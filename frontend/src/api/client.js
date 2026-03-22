const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";

function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[2]) : "";
}

let csrfReadyPromise = null;

async function ensureCsrfCookie() {
  if (!csrfReadyPromise) {
    csrfReadyPromise = fetch(`${API_BASE_URL}/csrf/`, {
      credentials: "include"
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

export async function apiFetch(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
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
          : undefined
  });

  const payload = await parseResponse(response);
  if (!response.ok) {
    const error = new Error(
      typeof payload === "string" ? payload : payload.detail || "Request failed."
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

export const authApi = {
  session: () => apiFetch("/auth/session/"),
  login: (body) => apiFetch("/auth/login/", { method: "POST", body }),
  logout: () => apiFetch("/auth/logout/", { method: "POST" }),
  profile: () => apiFetch("/auth/profile/"),
  updateProfile: (body) => apiFetch("/auth/profile/", { method: "PATCH", body }),
  users: () => apiFetch("/auth/users/"),
  createUser: (body) => apiFetch("/auth/users/", { method: "POST", body }),
  updateUser: (id, body) => apiFetch(`/auth/users/${id}/`, { method: "PATCH", body }),
  deleteUser: (id) => apiFetch(`/auth/users/${id}/`, { method: "DELETE" }),
  passwordReset: (body) => apiFetch("/auth/password-reset/", { method: "POST", body }),
  twoFactorStatus: () => apiFetch("/auth/2fa/status/"),
  twoFactorSetup: () => apiFetch("/auth/2fa/setup/", { method: "POST" }),
  twoFactorConfirm: (body) => apiFetch("/auth/2fa/confirm/", { method: "POST", body }),
  twoFactorCancel: () => apiFetch("/auth/2fa/cancel/", { method: "POST", body: {} }),
  twoFactorDisable: () => apiFetch("/auth/2fa/disable/", { method: "POST", body: {} })
};
