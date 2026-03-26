const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";
const SESSION_EXPIRED_EVENT = "app:session-expired";
const BACKEND_STATUS_EVENT = "app:backend-status";
const SERVICE_ERROR_WINDOW_MS = 2 * 60 * 1000;

let sessionExpiredNotified = false;
let serviceFailureWindowStart = 0;
let serviceFailureCount = 0;
let backendOutageNotified = false;
let backendProbePromise = null;

function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[2]) : "";
}

let csrfReadyPromise = null;

function stripHtmlTags(value) {
  return value.replace(/<[^>]*>/g, " ");
}

function normalizePlainText(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const plainText = stripHtmlTags(trimmed).replace(/\s+/g, " ").trim();

  return plainText;
}

function payloadMessage(payload) {
  if (typeof payload === "string") {
    return normalizePlainText(payload);
  }

  if (!payload || typeof payload !== "object") {
    return "";
  }

  if (typeof payload.detail === "string") {
    return normalizePlainText(payload.detail);
  }

  if (typeof payload.message === "string") {
    return normalizePlainText(payload.message);
  }

  return "";
}

function registerServiceFailure() {
  const now = Date.now();
  if (
    !serviceFailureWindowStart ||
    now - serviceFailureWindowStart > SERVICE_ERROR_WINDOW_MS
  ) {
    serviceFailureWindowStart = now;
    serviceFailureCount = 0;
  }
  serviceFailureCount += 1;
}

function clearServiceFailureWindow() {
  serviceFailureWindowStart = 0;
  serviceFailureCount = 0;
}

function notifyBackendRecovered() {
  if (!backendOutageNotified || typeof window === "undefined") {
    return;
  }
  backendOutageNotified = false;
  window.dispatchEvent(
    new CustomEvent(BACKEND_STATUS_EVENT, {
      detail: {
        state: "up",
      },
    }),
  );
}

function notifyBackendUnavailable(mode) {
  if (typeof window === "undefined") {
    return;
  }

  backendOutageNotified = true;
  window.dispatchEvent(
    new CustomEvent(BACKEND_STATUS_EVENT, {
      detail: {
        state: "down",
        mode,
      },
    }),
  );
}

function shouldTreatAsBackendUnavailable(status) {
  return [0, 502, 503, 504].includes(status);
}

function inferBackendMode(status, path) {
  const startupEndpoints = ["/csrf/", "/auth/session/"];
  const isStartupRequest = startupEndpoints.includes(path);
  const isLikelyRestarting =
    shouldTreatAsBackendUnavailable(status) &&
    (isStartupRequest || serviceFailureCount <= 3);
  return isLikelyRestarting ? "restarting" : "outage";
}

async function evaluateBackendAvailability(status, path) {
  if (!shouldTreatAsBackendUnavailable(status)) {
    return;
  }

  if (backendProbePromise) {
    return backendProbePromise;
  }

  const mode = inferBackendMode(status, path);
  backendProbePromise = probeBackendHealth()
    .then((healthy) => {
      if (healthy) {
        notifyBackendRecovered();
      } else {
        notifyBackendUnavailable(mode);
      }
    })
    .finally(() => {
      backendProbePromise = null;
    });

  return backendProbePromise;
}

function serviceUnavailableMessage(status, path) {
  registerServiceFailure();

  const isLikelyRestarting = inferBackendMode(status, path) === "restarting";

  if (isLikelyRestarting) {
    return "Please try again in a few minutes. The application is getting ready.";
  }

  return "There is an error. Please try again after a few hours.";
}

function shouldNotifySessionExpired(status, path) {
  if (![401, 403].includes(status)) {
    return false;
  }

  const ignoredPaths = [
    "/auth/session/",
    "/auth/login/",
    "/auth/password-reset/",
  ];

  return !ignoredPaths.includes(path);
}

function notifySessionExpired() {
  if (sessionExpiredNotified || typeof window === "undefined") {
    return;
  }
  sessionExpiredNotified = true;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

function resetSessionExpiryNotification(path) {
  if (path === "/auth/login/" || path === "/auth/session/") {
    sessionExpiredNotified = false;
  }
}

function createApiError({ status, payload, path }) {
  const message = payloadMessage(payload);
  let resolvedMessage = message || "Request failed.";

  if (shouldTreatAsBackendUnavailable(status)) {
    void evaluateBackendAvailability(status, path);
    resolvedMessage = serviceUnavailableMessage(status, path);
  } else if ([500, 501].includes(status)) {
    resolvedMessage = message || "Request failed.";
  }

  const error = new Error(resolvedMessage);
  error.status = status;
  error.payload = payload;
  return error;
}

function createNetworkError(path) {
  void evaluateBackendAvailability(0, path);
  const error = new Error(serviceUnavailableMessage(0, path));
  error.status = 0;
  error.payload = null;
  return error;
}

async function ensureCsrfCookie() {
  if (!csrfReadyPromise) {
    csrfReadyPromise = fetch(`${API_BASE_URL}/csrf/`, {
      credentials: "include",
    }).finally(() => {
      csrfReadyPromise = null;
    });
  }
  return csrfReadyPromise;
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function filenameFromDisposition(headerValue) {
  if (!headerValue) {
    return "";
  }
  const utf8Match = headerValue.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1]);
  }
  const plainMatch = headerValue.match(/filename="?([^"]+)"?/i);
  return plainMatch ? plainMatch[1] : "";
}

function fallbackDownloadFilename(contentType) {
  if (contentType.includes("application/pdf")) {
    return "download.pdf";
  }
  if (contentType.includes("text/csv")) {
    return "download.csv";
  }
  return "download";
}

export async function apiFetch(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const isFormData =
    typeof FormData !== "undefined" && options.body instanceof FormData;

  try {
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      await ensureCsrfCookie();
    }

    const headers = new Headers(options.headers || {});
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    if (options.body && !isFormData && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const csrfToken = getCookie("csrftoken");
      if (csrfToken) {
        headers.set("X-CSRFToken", csrfToken);
      }
    }

    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      method,
      headers,
      credentials: "include",
      body: isFormData
        ? options.body
        : typeof options.body === "string"
          ? options.body
          : options.body
            ? JSON.stringify(options.body)
            : undefined,
    });

    const payload = await parseResponse(response);
    if (!response.ok) {
      if (shouldNotifySessionExpired(response.status, path)) {
        notifySessionExpired();
      }
      throw createApiError({ status: response.status, payload, path });
    }

    clearServiceFailureWindow();
    notifyBackendRecovered();
    resetSessionExpiryNotification(path);
    return payload;
  } catch (error) {
    if (typeof error?.status === "number") {
      throw error;
    }
    throw createNetworkError(path);
  }
}

export async function probeBackendHealth() {
  try {
    const response = await fetch(`${API_BASE_URL}/csrf/`, {
      credentials: "include",
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function resolveAppUrl(url) {
  if (!url || typeof window === "undefined") {
    return url;
  }

  try {
    const currentOrigin = window.location.origin;
    const apiBasePath = new URL(API_BASE_URL, currentOrigin).pathname.replace(
      /\/$/,
      "",
    );
    const resolved = new URL(url, currentOrigin);
    const manifestUrl = resolved.searchParams.get("manifest");

    if (
      resolved.pathname === apiBasePath ||
      resolved.pathname.startsWith(`${apiBasePath}/`)
    ) {
      return `${currentOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`;
    }

    if (manifestUrl) {
      const normalizedManifestUrl = resolveAppUrl(manifestUrl);
      if (normalizedManifestUrl && normalizedManifestUrl !== manifestUrl) {
        resolved.searchParams.set("manifest", normalizedManifestUrl);
      }
    }

    return resolved.toString();
  } catch {
    return url;
  }
}

export async function downloadApiFile(path, options = {}) {
  const downloadUrl = `${API_BASE_URL}${path}`;
  const headers = new Headers(options.headers || {});
  if (!headers.has("Accept")) {
    headers.set("Accept", "*/*");
  }

  const response = await fetch(downloadUrl, {
    ...options,
    method: options.method || "GET",
    headers,
    credentials: "include",
  });

  if (!response.ok) {
    const payload = await parseResponse(response);
    const error = new Error(
      typeof payload === "string"
        ? payload
        : payload.detail || "Request failed.",
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  const contentType = response.headers.get("content-type") || "";
  const disposition = response.headers.get("content-disposition") || "";
  if (contentType.includes("application/json") && !disposition) {
    const payload = await response.json();
    const error = new Error(
      typeof payload === "string"
        ? payload
        : payload.detail || "Download failed.",
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  const blob = await response.blob();
  const filename =
    filenameFromDisposition(disposition) ||
    fallbackDownloadFilename(contentType);
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
}

export const authApi = {
  session: () => apiFetch("/auth/session/"),
  login: (body) => apiFetch("/auth/login/", { method: "POST", body }),
  logout: () => apiFetch("/auth/logout/", { method: "POST" }),
  profile: () => apiFetch("/auth/profile/"),
  updateProfile: (body) =>
    apiFetch("/auth/profile/", { method: "PATCH", body }),
  users: () => apiFetch("/auth/users/"),
  createUser: (body) => apiFetch("/auth/users/", { method: "POST", body }),
  updateUser: (id, body) =>
    apiFetch(`/auth/users/${id}/`, { method: "PATCH", body }),
  deleteUser: (id) => apiFetch(`/auth/users/${id}/`, { method: "DELETE" }),
  passwordReset: (body) =>
    apiFetch("/auth/password-reset/", { method: "POST", body }),
  twoFactorStatus: () => apiFetch("/auth/2fa/status/"),
  twoFactorSetup: () => apiFetch("/auth/2fa/setup/", { method: "POST" }),
  twoFactorConfirm: (body) =>
    apiFetch("/auth/2fa/confirm/", { method: "POST", body }),
  twoFactorCancel: () =>
    apiFetch("/auth/2fa/cancel/", { method: "POST", body: {} }),
  twoFactorDisable: () =>
    apiFetch("/auth/2fa/disable/", { method: "POST", body: {} }),
};
