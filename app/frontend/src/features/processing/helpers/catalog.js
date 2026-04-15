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

const TERMINAL_CATALOG_CREATION_STATUSES = new Set([
  "failed",
  "duplicate",
  "ready",
  "stopped",
  "deleted",
]);

function hasCatalogCreationStatus(entry, statuses) {
  return (
    statuses.has(entry?.curation_status) ||
    statuses.has(entry?.latest_job_status) ||
    statuses.has(entry?.latest_submission_status)
  );
}

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

  if (hasCatalogCreationStatus(entry, TERMINAL_CATALOG_CREATION_STATUSES)) {
    return false;
  }

  return hasCatalogCreationStatus(entry, ACTIVE_CATALOG_CREATION_STATUSES);
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
    jobs.some(
      (job) =>
        isActiveStatus(job?.status) &&
        !TERMINAL_CATALOG_CREATION_STATUSES.has(job?.submission_status),
    ) ||
    submissions.some((submission) =>
      ACTIVE_CATALOG_CREATION_STATUSES.has(submission?.status),
    )
  );
}

export function resolvePendingCatalogCreationEntries(
  trackedEntries,
  {
    catalogEntries = [],
    catalogOverviewEntries = [],
    jobs = [],
    submissions = [],
  } = {},
) {
  if (!Array.isArray(trackedEntries) || !trackedEntries.length) {
    return [];
  }

  const entriesById = new Map();
  const submissionStatusesBySourceUrl = new Map();
  for (const entry of [...catalogOverviewEntries, ...catalogEntries]) {
    if (entry?.id) {
      entriesById.set(entry.id, entry);
    }
  }
  for (const submission of submissions) {
    const sourceUrls = [
      String(submission?.resolved_url || "").trim(),
      String(submission?.original_input || "").trim(),
    ].filter(Boolean);
    for (const sourceUrl of sourceUrls) {
      const statuses = submissionStatusesBySourceUrl.get(sourceUrl) || [];
      statuses.push(String(submission?.status || "").trim());
      submissionStatusesBySourceUrl.set(sourceUrl, statuses);
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

    const submissionStatuses =
      submissionStatusesBySourceUrl.get(sourceUrl) || [];
    if (
      submissionStatuses.some((status) =>
        ACTIVE_CATALOG_CREATION_STATUSES.has(status),
      )
    ) {
      return true;
    }
    if (
      submissionStatuses.some((status) =>
        TERMINAL_CATALOG_CREATION_STATUSES.has(status),
      )
    ) {
      return false;
    }

    return jobs.some(
      (job) =>
        isActiveStatus(job.status) &&
        !TERMINAL_CATALOG_CREATION_STATUSES.has(job?.submission_status) &&
        String(job.submission_input || "").trim() === sourceUrl,
    );
  });
}
