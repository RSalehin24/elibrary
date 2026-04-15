import { API_BASE_URL } from "./constants";
import { normalizeAppUrl } from "./urlNormalization";

export function resolveAppUrl(url) {
  if (!url || typeof window === "undefined") {
    return url;
  }

  return normalizeAppUrl(url, {
    currentOrigin: window.location.origin,
    apiBaseUrl: API_BASE_URL,
  });
}
