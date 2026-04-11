import { defaultCatalogFilters } from "../constants";

export function filterCatalogEntriesByControls(entryRows, filters) {
  const query = String(filters.q || "")
    .trim()
    .toLowerCase();
  if (!query) {
    return entryRows;
  }
  return entryRows.filter((entry) => {
    const searchText = [
      entry.title,
      entry.author_line,
      entry.categories,
      entry.local_book_title,
      entry.latest_job_error,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return searchText.includes(query);
  });
}

export function getCatalogPageLabel(pagination) {
  const currentPage = pagination?.page || 1;
  const pageCount = pagination?.page_count || 1;
  return `Page ${currentPage} / ${pageCount}`;
}

export function isDefaultCatalogBrowseRequest(filters) {
  return (
    String(filters?.q || "") === defaultCatalogFilters.q &&
    String(filters?.status || "") === defaultCatalogFilters.status &&
    String(filters?.sort || defaultCatalogFilters.sort) ===
      defaultCatalogFilters.sort &&
    Number(filters?.page || defaultCatalogFilters.page) ===
      defaultCatalogFilters.page &&
    Number(filters?.limit || defaultCatalogFilters.limit) ===
      defaultCatalogFilters.limit
  );
}

export function canCreateCatalogEntry(entry) {
  return [
    "new",
    "failed",
    "stopped",
    "requeued",
    "unfinished",
    "deleted",
  ].includes(entry.curation_status);
}
