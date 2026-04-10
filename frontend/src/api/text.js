export function stripHtmlTags(value) {
  return value.replace(/<[^>]*>/g, " ");
}

export function normalizePlainText(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return stripHtmlTags(trimmed).replace(/\s+/g, " ").trim();
}

export function payloadMessage(payload) {
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
