import { apiFetch, resolveApiUrl } from "../../api/client";

export function processingFetch(path, options) {
  return apiFetch(path, options);
}

export function resolveProcessingStreamUrl(path) {
  return resolveApiUrl(path);
}
