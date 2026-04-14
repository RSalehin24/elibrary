import { isActiveStatus } from "./activity.js";

import { defaultCatalogFilters } from "../constants.js";

const CREATABLE_CATALOG_ENTRY_STATUSES = new Set([
  "new",
  "failed",
  "stopped",
  "unfinished",
  "deleted",
  "requeued",
]);

const ACTIVE_CATALOG_CREATION_STATUSES = new Set([
  "pending_resolution",
  "queued",
  "processing",
]);

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
  return CREATABLE_CATALOG_ENTRY_STATUSES.has(entry?.curation_status);
}

export function isCatalogEntryCreatePending(entry) {
  if (!entry) {
    return false;
  }

  return (
    ACTIVE_CATALOG_CREATION_STATUSES.has(entry.curation_status) ||
    ACTIVE_CATALOG_CREATION_STATUSES.has(entry.latest_job_status) ||
    ACTIVE_CATALOG_CREATION_STATUSES.has(entry.latest_submission_status)
  );
}

export function hasActiveCatalogCreationWork({
  catalogEntries = [],
  catalogOverviewEntries = [],
  jobs = [],
  submissions = [],
} = {}) {
  return (
    [...catalogOverviewEntries, ...catalogEntries].some((entry) =>
      isCatalogEntryCreatePending(entry),
    ) ||
    jobs.some((job) => isActiveStatus(job?.status)) ||
    submissions.some((submission) =>
      ACTIVE_CATALOG_CREATION_STATUSES.has(submission?.status),
    )
  );
}

export function resolvePendingCatalogCreationEntries(
  trackedEntries,
  { catalogEntries = [], catalogOverviewEntries = [], jobs = [] } = {},
) {
  if (!Array.isArray(trackedEntries) || !trackedEntries.length) {
    return [];
  }

  const entriesById = new Map();
  for (const entry of [...catalogOverviewEntries, ...catalogEntries]) {
    if (entry?.id) {
      entriesById.set(entry.id, entry);
    }
  }

  return trackedEntries.filter((trackedEntry) => {
    const currentEntry = entriesById.get(trackedEntry.id);
    if (currentEntry) {
      return isCatalogEntryCreatePending(currentEntry);
    }

    const sourceUrl = String(
      trackedEntry.source_url || trackedEntry.sourceUrl || "",
    ).trim();
    if (!sourceUrl) {
      return false;
    }

    return jobs.some(
      (job) =>
        isActiveStatus(job.status) &&
        String(job.submission_input || "").trim() === sourceUrl,
    );
  });
}
