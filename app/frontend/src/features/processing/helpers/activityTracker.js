export function normalizeProcessingActivityPayload(payload = {}) {
  const activeScopes = Array.isArray(payload.active_scopes)
    ? Array.from(
        new Set(
          payload.active_scopes
            .map((value) => String(value || "").trim())
            .filter(Boolean),
        ),
      )
    : [];

  return {
    canManageProcessing: Boolean(payload.can_manage_processing),
    hasVisibleActivity:
      Boolean(payload.has_visible_activity) || activeScopes.length > 0,
    activeScopes,
  };
}

export function shouldPollProcessingActivity({
  authenticated,
  pathname,
  sessionLoading,
}) {
  return Boolean(
    authenticated &&
      !sessionLoading &&
      String(pathname || "").startsWith("/processing"),
  );
}
