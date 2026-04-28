import {
  getContributorGroups,
  getPrimaryContributorGroup,
} from "../../utils/bookPresentation";

export function openManagedPreviewWindow(previewUrl, target) {
  const openedWindow = window.open("", target);
  if (!openedWindow) {
    return null;
  }

  try {
    if (openedWindow.location.href !== previewUrl) {
      openedWindow.location.replace(previewUrl);
    }
  } catch {
    openedWindow.location = previewUrl;
  }

  return openedWindow;
}

function normalizeIdentityLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function normalizeFrontMatterEntries(entries, bookIdValue) {
  if (!entries?.length) {
    return [];
  }

  let replacedIdentity = false;
  const seen = new Set();

  return entries.reduce((normalizedEntries, entry) => {
    const normalizedLabel = normalizeIdentityLabel(entry.label);
    const normalizedKey = normalizeIdentityLabel(entry.key);
    const isIdentityEntry =
      ["unique id", "book id", "catalog code", "catalog id", "id"].includes(
        normalizedLabel,
      ) ||
      ["unique id", "book id", "catalog code", "catalog id", "id"].includes(
        normalizedKey,
      );

    if (isIdentityEntry) {
      if (!replacedIdentity) {
        const normalizedEntry = {
          ...entry,
          key: "book_id",
          label: "Book ID",
          value: bookIdValue,
        };
        const dedupeKey = `${normalizeIdentityLabel(normalizedEntry.key)}::${normalizeIdentityLabel(normalizedEntry.value)}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          normalizedEntries.push(normalizedEntry);
        }
        replacedIdentity = true;
      }
      return normalizedEntries;
    }

    const dedupeKey = `${normalizedKey || normalizedLabel}::${normalizeIdentityLabel(entry.value)}`;
    if (seen.has(dedupeKey)) {
      return normalizedEntries;
    }
    seen.add(dedupeKey);
    normalizedEntries.push(entry);
    return normalizedEntries;
  }, []);
}

export function waitForUiFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    });
  });
}

export function waitForMinimumLoader(startedAt, minimumMs = 320) {
  const elapsed = Date.now() - startedAt;
  const remaining = minimumMs - elapsed;
  if (remaining <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => window.setTimeout(resolve, remaining));
}

export function buildSourceRecords(book) {
  if (!book) {
    return [];
  }

  return book.source_records?.length
    ? book.source_records
    : (book.source_urls || []).map((url) => ({
        url,
        display_url: decodeURIComponent(url),
        display_path: decodeURIComponent(url).replace(
          /^https?:\/\/[^/]+\//,
          "",
        ),
        source_title: "",
        site: "",
        is_primary: false,
      }));
}

export function buildBookDetailView(book, readerState) {
  if (!book) {
    return {
      bookIdValue: "Pending",
      downloadableAssets: [],
      epubAsset: null,
      frontMatter: [],
      hasActiveProcessing: false,
      hasDedication: false,
      hasFailedProcessing: false,
      hasFrontMatter: false,
      hasToc: false,
      latestProcessingJob: null,
      primaryContributorGroup: null,
      processingBody: "",
      processingHeading: "Processing book",
      progressPercent: 0,
      sourceRecords: [],
      supportingContributorGroups: [],
    };
  }

  const contributorGroups = getContributorGroups(book);
  const primaryContributorGroup = getPrimaryContributorGroup(book);
  const supportingContributorGroups = contributorGroups.filter(
    (group) => group.role !== primaryContributorGroup?.role,
  );
  const bookIdValue = book.catalog_code || "Pending";
  const frontMatter = normalizeFrontMatterEntries(
    book.front_matter || [],
    bookIdValue,
  );
  const hasFrontMatter = Boolean(
    frontMatter.length || book.book_info_html?.trim(),
  );
  const hasDedication = Boolean(book.dedication_html?.trim());
  const hasToc = Boolean(book.toc?.length);
  const progressPercent = Math.max(
    0,
    Math.min(100, Math.round(Number(readerState.progress_percent) || 0)),
  );
  const latestProcessingJob = book.latest_processing_job || null;
  const hasActiveProcessing = Boolean(
    latestProcessingJob &&
    ["queued", "processing"].includes(latestProcessingJob.status),
  );
  const hasFailedProcessing = latestProcessingJob?.status === "failed";
  const epubAsset = (book.assets || []).find(
    (asset) => asset.asset_type === "epub",
  );
  const downloadableAssets = (book.assets || []).filter(
    (asset) => asset.download_url,
  );
  const processingHeading =
    latestProcessingJob?.job_type === "reprocess"
      ? "Regenerating book"
      : "Processing book";
  const processingBody = hasFailedProcessing
    ? latestProcessingJob?.last_error || "The latest processing job failed."
    : hasActiveProcessing
      ? "New book files are being prepared. This page refreshes automatically while the job is running."
      : "";

  return {
    bookIdValue,
    downloadableAssets,
    epubAsset,
    frontMatter,
    hasActiveProcessing,
    hasDedication,
    hasFailedProcessing,
    hasFrontMatter,
    hasToc,
    latestProcessingJob,
    primaryContributorGroup,
    processingBody,
    processingHeading,
    progressPercent,
    sourceRecords: buildSourceRecords(book),
    supportingContributorGroups,
  };
}
