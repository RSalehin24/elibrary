export function toQueryString(params) {
  const searchParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }

    const stringValue = String(value).trim();
    if (!stringValue) {
      return;
    }

    searchParams.set(key, stringValue);
  });

  const queryString = searchParams.toString();
  return queryString ? `?${queryString}` : "";
}
