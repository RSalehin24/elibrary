export function decodeValue(value) {
  if (!value) {
    return "";
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function manifestFromLaunchUrl(launchUrlValue) {
  if (!launchUrlValue) {
    return "";
  }

  try {
    const parsed = new URL(launchUrlValue, window.location.origin);
    const manifest = parsed.searchParams.get("manifest") || "";
    return manifest ? decodeValue(manifest) : "";
  } catch {
    return "";
  }
}
