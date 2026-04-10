export function generateSuggestedPassword(length = 18) {
  const characters =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const randomValues = new Uint32Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(randomValues);
  } else {
    for (let index = 0; index < length; index += 1) {
      randomValues[index] = Math.floor(Math.random() * characters.length);
    }
  }
  return Array.from(
    randomValues,
    (value) => characters[value % characters.length],
  ).join("");
}

export function sortValues(values) {
  return [...values].sort((left, right) => `${left}`.localeCompare(`${right}`));
}

export function formatApiError(error, labelMap = {}) {
  if (
    error?.payload &&
    typeof error.payload === "object" &&
    !Array.isArray(error.payload)
  ) {
    for (const [field, value] of Object.entries(error.payload)) {
      const label = labelMap[field] || field;
      if (Array.isArray(value) && value.length) {
        return `${label}: ${value[0]}`;
      }
      if (typeof value === "string") {
        return `${label}: ${value}`;
      }
    }
  }
  return error.message;
}

export function formatAccountAccess(entry, scopeLabelMap) {
  const labels = sortValues(
    (entry.global_scopes || []).map(
      (scope) => scopeLabelMap.get(scope) || scope,
    ),
  );
  return labels.length ? labels.join(", ") : "-";
}

export function grantTargetField(targetType) {
  if (targetType === "category") {
    return "category";
  }
  if (targetType === "writer") {
    return "contributor";
  }
  return "book";
}
