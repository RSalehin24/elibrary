import { API_BASE_URL } from "./constants";

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
