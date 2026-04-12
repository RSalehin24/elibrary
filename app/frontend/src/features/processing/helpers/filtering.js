export function buildProcessingCardDrawerId(prefix, title) {
  const normalizedTitle = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalizedTitle ? `${prefix}-${normalizedTitle}` : prefix;
}

export function getScopedFilterDrawerState(
  activeDrawerId,
  setActiveDrawerId,
  drawerId,
) {
  return {
    filtersExpanded: activeDrawerId === drawerId,
    setFiltersExpanded(valueOrUpdater) {
      setActiveDrawerId((current) => {
        const isCurrentDrawer = current === drawerId;
        const nextExpanded =
          typeof valueOrUpdater === "function"
            ? Boolean(valueOrUpdater(isCurrentDrawer))
            : Boolean(valueOrUpdater);

        if (nextExpanded) {
          return drawerId;
        }

        return isCurrentDrawer ? "" : current;
      });
    },
  };
}
