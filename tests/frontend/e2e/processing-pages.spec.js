import { expect, test } from "./support/playwright";

const PROCESSING_TIMEOUT_MS = 20 * 60 * 1000;
const SYNC_RUN_MODE_MANUAL = "manual";
const SYNC_RUN_MODE_CATALOG_AUTOMATION = "catalog_automation";
const SYNC_RUN_MODE_INCOMPLETE_AUTOMATION = "incomplete_automation";
const CATALOG_SYNC_PHASE = "sync";
const CATALOG_REQUEST_CREATION_PHASE = "request_creation";
const CATALOG_PHASE_STATUS_NOT_STARTED = "not_started";
const CATALOG_PHASE_STATUS_RUNNING = "running";
const CATALOG_PHASE_STATUS_PAUSED = "paused";
const CATALOG_PHASE_STATUS_COMPLETED = "completed";
const PROCESSING_CARD_KEYS = [
  "catalog-overview",
  "catalog-sync",
  "catalog-automation",
  "catalog-records",
  "create-overview",
  "create-requests",
  "create-queue",
  "create-processing",
  "create-created",
  "on-hold-overview",
  "on-hold-paused",
  "on-hold-failed",
  "on-hold-duplicate",
  "on-hold-deleted",
  "incomplete-overview",
  "incomplete-automation",
  "incomplete-records",
  "incomplete-completed",
];
const INCOMPLETE_CATEGORY_KEYWORDS = [
  "incomplete",
  "unfinished",
  "অসম্পূর্ণ",
  "অসম্পূর্ণ বই",
];

const sessionPayload = {
  authenticated: true,
  user: {
    id: "processing-user",
    email: "processing-admin@example.com",
    full_name: "Processing Admin",
    is_superuser: true,
    capabilities: ["processing:manage"],
    totp_setup_required: false,
  },
};

function iso(offsetMinutes = 0) {
  return new Date(Date.UTC(2026, 3, 17, 8, offsetMinutes, 0)).toISOString();
}

function record(overrides = {}) {
  return {
    id: "record-1",
    name: "Reusable Systems",
    url: "https://example.test/books/reusable-systems",
    category: "Architecture",
    writer: "Ada Writer",
    translator: null,
    composer: null,
    publisher: "North Press",
    createdAt: iso(1),
    updatedAt: iso(1),
    bookCreationState: "not_created",
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    id: "request-1",
    bookRecordId: "record-1",
    state: "initial",
    createdAt: iso(2),
    updatedAt: iso(2),
    progress: null,
    errorMessage: null,
    isResumed: false,
    isConfirmedNotDuplicate: false,
    duplicateOfRequestId: null,
    duplicateOfRecordId: null,
    linkedBookId: null,
    linkedBookSlug: null,
    ...overrides,
  };
}

function baseState(overrides = {}) {
  return {
    records: [],
    requests: [],
    sync: {
      status: "idle",
      phase: "sync",
      progress: null,
      fetchedCount: 0,
      skippedCount: 0,
      updatedCount: 0,
      appendedCount: 0,
      message: "Ready to sync.",
      remotePages: [],
      pageIndex: 0,
      runMode: SYNC_RUN_MODE_MANUAL,
    },
    automation: {
      catalog: {
        enabled: false,
        interval: "weekly",
        time: "03:00",
        saved: false,
        lastRunAt: "",
      },
      incomplete: {
        enabled: false,
        interval: "weekly",
        time: "03:00",
        saved: false,
        lastRunAt: "",
      },
    },
    orchestration: {
      manualPipelineAdvance: true,
    },
    ui: {
      actionDelayMs: 80,
      pipelineDelayMs: 500,
    },
    ...overrides,
  };
}

async function mockAuthenticatedSession(page) {
  await page.route("**/api/auth/session/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sessionPayload),
    });
  });
  await page.route("**/api/csrf/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ detail: "ok" }),
    });
  });
  await page.route("**/api/catalog/books/**", async (route) => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get("page") || "1");
    const limit = Number(url.searchParams.get("limit") || "60");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entries: [],
        pagination: {
          page: pageNumber,
          limit,
          total_count: 0,
          page_count: 1,
          has_previous: false,
          has_next: false,
        },
      }),
    });
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function categoryIsIncomplete(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return INCOMPLETE_CATEGORY_KEYWORDS.some((keyword) =>
    normalized.includes(keyword.toLowerCase()),
  );
}

function latestRequestForRecord(state, recordId) {
  return state.requests
    .filter((item) => item.bookRecordId === recordId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function requestBlocksSelection(requestItem) {
  return requestItem && !["failed", "deleted"].includes(requestItem.state);
}

function recordSelectable(state, recordItem) {
  const recordRequests = state.requests.filter(
    (item) => item.bookRecordId === recordItem.id,
  );
  const confirmedDuplicate = recordRequests.find(
    (item) => item.state === "duplicate" && item.duplicateConfirmed,
  );
  if (confirmedDuplicate) {
    const original = state.requests.find(
      (item) => item.id === confirmedDuplicate.duplicateOfRequestId,
    );
    return !original || ["failed", "deleted"].includes(original.state);
  }
  return !recordRequests.some(requestBlocksSelection);
}

function syncRecordStates(state) {
  state.records = state.records.map((recordItem) => {
    const latest = latestRequestForRecord(state, recordItem.id);
    return {
      selectable: recordSelectable(state, recordItem),
      ...recordItem,
      bookCreationState: latest?.state || recordItem.bookCreationState,
      latestRequestId: latest?.id || null,
      selectable: recordSelectable(state, recordItem),
    };
  });
  return state;
}

function nextRequestId(state, recordId) {
  const preferred = `request-${recordId}`;
  if (!state.requests.some((item) => item.id === preferred)) {
    return preferred;
  }
  let index = 2;
  while (state.requests.some((item) => item.id === `${preferred}-${index}`)) {
    index += 1;
  }
  return `${preferred}-${index}`;
}

function createRequestForRecord(state, recordId, stateValue = "initial") {
  const timestamp = iso(30 + state.requests.length);
  state.requests.push({
    id: nextRequestId(state, recordId),
    bookRecordId: recordId,
    state: stateValue,
    createdAt: timestamp,
    updatedAt: timestamp,
    progress: null,
    errorMessage: null,
    isResumed: false,
    isConfirmedNotDuplicate: false,
    duplicateOfRequestId: null,
    duplicateOfRecordId: null,
    duplicateConfirmed: false,
  });
}

function reconcilePage(state, pageRecords) {
  for (const incoming of pageRecords) {
    const existing = state.records.find((item) => item.id === incoming.id);
    if (!existing) {
      state.records.push(incoming);
      state.sync.appendedCount += 1;
      continue;
    }
    if (existing.updatedAt !== incoming.updatedAt) {
      Object.assign(existing, incoming, {
        bookCreationState: existing.bookCreationState,
      });
      state.sync.updatedCount += 1;
      continue;
    }
    state.sync.skippedCount += 1;
  }
}

function nextStateTimestamp(state) {
  return Date.parse(state.ui?.nowIso || iso(10));
}

function applyRequestTimeouts(state) {
  const now = nextStateTimestamp(state);
  for (const item of state.requests) {
    if (item.state !== "processing") {
      continue;
    }
    const updatedAt = Date.parse(item.updatedAt || item.createdAt || "");
    if (!Number.isFinite(updatedAt) || now - updatedAt <= PROCESSING_TIMEOUT_MS) {
      continue;
    }
    item.state = "failed";
    item.errorMessage =
      item.errorMessage || "Processing exceeded 20 minutes without completing.";
    item.updatedAt = new Date(now).toISOString();
  }
}

function requestDetails(item) {
  const checkpoint = item?.progress?.checkpoint || item?.progressCheckpoint || "";
  if (checkpoint) {
    return checkpoint;
  }
  if (item?.errorMessage) {
    return item.errorMessage;
  }
  if (item?.duplicateConfirmed) {
    return "Confirmed duplicate";
  }
  if (item?.isConfirmedNotDuplicate) {
    return "Confirmed new";
  }
  if (item?.isResumed) {
    return "Resumed from saved progress";
  }
  return "";
}

function decodeUrlForDisplay(value) {
  const url = String(value || "").trim();
  if (!url) {
    return "";
  }
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function rowFromRecord(state, recordItem) {
  const latest = latestRequestForRecord(state, recordItem.id);
  return {
    id: recordItem.id,
    recordId: recordItem.id,
    requestId: latest?.id || null,
    title: recordItem.name,
    url: recordItem.url,
    displayUrl: recordItem.displayUrl || decodeUrlForDisplay(recordItem.url),
    displayPath: recordItem.displayPath || "",
    category: recordItem.category,
    writer: recordItem.writer,
    translator: recordItem.translator,
    publisher: recordItem.publisher,
    status: latest?.state || recordItem.bookCreationState || "not_created",
    updatedAt: latest?.updatedAt || recordItem.updatedAt,
    selectable: recordSelectable(state, recordItem),
    progressCheckpoint: latest?.progress?.checkpoint || "",
    progressSavedAt: latest?.progress?.savedAt || "",
    errorMessage: latest?.errorMessage || "",
    isResumed: Boolean(latest?.isResumed),
    isConfirmedNotDuplicate: Boolean(latest?.isConfirmedNotDuplicate),
    linkedBookId: latest?.linkedBookId || recordItem.linkedBookId || null,
    linkedBookSlug: latest?.linkedBookSlug || recordItem.linkedBookSlug || null,
    duplicateOfRequestId: latest?.duplicateOfRequestId || null,
    duplicateOfRecordId: latest?.duplicateOfRecordId || null,
    duplicateConfirmed: Boolean(latest?.duplicateConfirmed),
  };
}

function rowFromRequest(state, requestItem) {
  const recordItem = state.records.find((item) => item.id === requestItem.bookRecordId);
  if (!recordItem) {
    return null;
  }
  return {
    ...rowFromRecord(state, recordItem),
    id: requestItem.id,
    requestId: requestItem.id,
    status: requestItem.state,
    updatedAt: requestItem.updatedAt,
    selectable: true,
    progressCheckpoint: requestItem.progress?.checkpoint || "",
    progressSavedAt: requestItem.progress?.savedAt || "",
    errorMessage: requestItem.errorMessage || "",
    isResumed: Boolean(requestItem.isResumed),
    isConfirmedNotDuplicate: Boolean(requestItem.isConfirmedNotDuplicate),
    linkedBookId: requestItem.linkedBookId || recordItem.linkedBookId || null,
    linkedBookSlug: requestItem.linkedBookSlug || recordItem.linkedBookSlug || null,
    duplicateOfRequestId: requestItem.duplicateOfRequestId || null,
    duplicateOfRecordId: requestItem.duplicateOfRecordId || null,
    duplicateConfirmed: Boolean(requestItem.duplicateConfirmed),
  };
}

function tableRowsForCard(state, card) {
  if (card === "catalog-records") {
    return [...state.records]
      .map((recordItem) => rowFromRecord(state, recordItem))
      .sort((left, right) => {
        const leftPriority = left.status === "not_created" ? 0 : 1;
        const rightPriority = right.status === "not_created" ? 0 : 1;
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        return left.title.localeCompare(right.title);
      });
  }

  const stateMap = {
    "create-requests": ["initial"],
    "create-queue": ["queued"],
    "create-processing": ["processing"],
    "create-created": ["created"],
    "on-hold-paused": ["paused"],
    "on-hold-failed": ["failed"],
    "on-hold-duplicate": ["duplicate"],
    "on-hold-deleted": ["deleted"],
  };

  if (stateMap[card]) {
    return state.requests
      .filter((item) => stateMap[card].includes(item.state))
      .map((item) => rowFromRequest(state, item))
      .filter(Boolean);
  }

  if (card === "incomplete-records") {
    return state.records
      .filter(
        (recordItem) =>
          (recordItem.wasIncomplete || categoryIsIncomplete(recordItem.category)) &&
          !recordItem.resolvedFromIncomplete,
      )
      .map((recordItem) => ({
        ...rowFromRecord(state, recordItem),
        selectable: false,
      }));
  }

  if (card === "incomplete-completed") {
    return state.requests
      .filter((item) => item.state === "created")
      .map((item) => rowFromRequest(state, item))
      .filter((item) => {
        const recordItem = state.records.find((record) => record.id === item.recordId);
        return recordItem?.wasIncomplete && recordItem?.resolvedFromIncomplete;
      });
  }

  return [];
}

function processingSummary(state) {
  const counts = state.requests.reduce((result, item) => {
    result[item.state] = (result[item.state] || 0) + 1;
    return result;
  }, {});
  const latestFailedMessage =
    state.requests.find((item) => item.state === "failed" && item.errorMessage)
      ?.errorMessage || "";

  return {
    catalog: {
      records: state.records.length,
      notCreated: state.records.filter(
        (item) => item.bookCreationState === "not_created",
      ).length,
      active:
        (counts.initial || 0) + (counts.queued || 0) + (counts.processing || 0),
      created: counts.created || 0,
      onHold:
        (counts.paused || 0) +
        (counts.failed || 0) +
        (counts.duplicate || 0) +
        (counts.deleted || 0),
    },
    create: {
      requests: counts.initial || 0,
      queue: counts.queued || 0,
      processing: counts.processing || 0,
      created: counts.created || 0,
    },
    onHold: {
      paused: counts.paused || 0,
      failed: counts.failed || 0,
      duplicate: counts.duplicate || 0,
      deleted: counts.deleted || 0,
    },
    incomplete: {
      incomplete: state.records.filter(
        (item) =>
          (item.wasIncomplete || categoryIsIncomplete(item.category)) &&
          !item.resolvedFromIncomplete,
      ).length,
      resolved: state.records.filter(
        (item) => item.wasIncomplete && item.resolvedFromIncomplete,
      ).length,
    },
    notifications: {
      activeRequests:
        (counts.initial || 0) + (counts.queued || 0) + (counts.processing || 0),
      createdCount: counts.created || 0,
      failedCount: counts.failed || 0,
      duplicateCount: counts.duplicate || 0,
      latestFailedMessage,
    },
  };
}

function processingCardPayload(state, cardKey) {
  const summary = processingSummary(state);
  const cards = {
    "catalog-overview": {
      card: "catalog-overview",
      summary: summary.catalog,
    },
    "catalog-sync": {
      card: "catalog-sync",
      sync: state.sync,
    },
    "catalog-automation": {
      card: "catalog-automation",
      sync: state.sync,
      automation: state.automation.catalog,
    },
    "create-overview": {
      card: "create-overview",
      summary: summary.create,
    },
    "on-hold-overview": {
      card: "on-hold-overview",
      summary: summary.onHold,
    },
    "incomplete-overview": {
      card: "incomplete-overview",
      summary: summary.incomplete,
    },
    "incomplete-automation": {
      card: "incomplete-automation",
      sync: state.sync,
      automation: state.automation.incomplete,
    },
  };
  return cards[cardKey] || { card: cardKey };
}

function filteredTablePayload(
  state,
  {
    card,
    query = "",
    category = "",
    status = "",
    offset = 0,
    limit = 60,
    includeFacets = true,
  },
) {
  const rows = tableRowsForCard(state, card);
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const categoryOptions = Array.from(
    new Set(rows.map((row) => row.category).filter(Boolean)),
  ).sort();
  const statusOptions = Array.from(
    new Set(rows.map((row) => row.status).filter(Boolean)),
  ).sort();
  const filtered = rows.filter((row) => {
    const searchText = [
      row.title,
      row.url,
      row.displayUrl,
      row.displayPath,
      row.writer,
      row.translator,
      row.publisher,
      row.category,
      row.status,
      requestDetails(row),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (normalizedQuery && !searchText.includes(normalizedQuery)) {
      return false;
    }
    if (category && row.category !== category) {
      return false;
    }
    if (status && row.status !== status) {
      return false;
    }
    return true;
  });
  const nextRows = filtered.slice(offset, offset + limit);
  const nextOffset = offset + nextRows.length;

  return {
    rows: nextRows,
    pagination: {
      offset,
      limit,
      totalCount: filtered.length,
      returnedCount: nextRows.length,
      hasMore: nextOffset < filtered.length,
      nextOffset,
    },
    ...(includeFacets
      ? {
          filters: {
            categoryOptions,
            statusOptions,
          },
        }
      : {}),
  };
}

function finalizeSync(state) {
  state.sync.status = "idle";
  state.sync.phase = CATALOG_SYNC_PHASE;
  buildCatalogSyncProgress(state, SYNC_RUN_MODE_MANUAL, {
    syncPhaseStatus: CATALOG_PHASE_STATUS_COMPLETED,
  });
  state.sync.message = `Sync complete. Updated ${state.sync.updatedCount}, Skipped ${state.sync.skippedCount}, Added ${state.sync.appendedCount}.`;
  state.sync.runMode = SYNC_RUN_MODE_MANUAL;
}

function catalogSyncSavedData(state) {
  return state.sync.progress?.savedData || {};
}

function catalogSyncCheckpointToken(state) {
  const savedData = catalogSyncSavedData(state);
  if (!savedData.sessionId) {
    return "";
  }
  return (
    savedData.checkpointToken ||
    `${savedData.sessionId}:0:${savedData.nextPageIndex || 0}:${savedData.fetchedCount || 0}`
  );
}

function preserveCatalogRequestCreation(state, checkpointToken) {
  const requestCreation = state.sync.progress?.requestCreation;
  if (requestCreation?.baseCheckpointToken === checkpointToken) {
    return requestCreation;
  }
  return null;
}

function catalogSavedCheckpointAvailable(state) {
  return Object.keys(catalogSyncSavedData(state)).length > 0;
}

function catalogPhaseStatuses(
  syncStatus = CATALOG_PHASE_STATUS_NOT_STARTED,
  requestCreationStatus = CATALOG_PHASE_STATUS_NOT_STARTED,
) {
  return {
    [CATALOG_SYNC_PHASE]: syncStatus,
    [CATALOG_REQUEST_CREATION_PHASE]: requestCreationStatus,
  };
}

function explicitCatalogPhaseStatus(state, phase) {
  return state.sync.progress?.phaseStatuses?.[phase] || "";
}

function catalogSyncPhaseStatus(state) {
  const explicit = explicitCatalogPhaseStatus(state, CATALOG_SYNC_PHASE);
  if (explicit) {
    return explicit;
  }
  if ((state.sync.phase || state.sync.progress?.phase) === CATALOG_REQUEST_CREATION_PHASE) {
    return CATALOG_PHASE_STATUS_COMPLETED;
  }
  if (state.sync.status === "paused") {
    return CATALOG_PHASE_STATUS_PAUSED;
  }
  if (["syncing", "pausing"].includes(state.sync.status)) {
    return CATALOG_PHASE_STATUS_RUNNING;
  }
  return catalogSavedCheckpointAvailable(state)
    ? CATALOG_PHASE_STATUS_COMPLETED
    : CATALOG_PHASE_STATUS_NOT_STARTED;
}

function catalogRequestCreationPhaseStatus(state) {
  const explicit = explicitCatalogPhaseStatus(state, CATALOG_REQUEST_CREATION_PHASE);
  if (explicit) {
    return explicit;
  }
  if ((state.sync.phase || state.sync.progress?.phase) === CATALOG_REQUEST_CREATION_PHASE) {
    if (state.sync.status === "paused") {
      return CATALOG_PHASE_STATUS_PAUSED;
    }
    if (["syncing", "pausing"].includes(state.sync.status)) {
      return CATALOG_PHASE_STATUS_RUNNING;
    }
  }
  return CATALOG_PHASE_STATUS_NOT_STARTED;
}

function catalogRequestCreationCanResume(state) {
  const requestCreation = state.sync.progress?.requestCreation;
  return (
    state.sync.status === "paused" &&
    catalogRequestCreationPhaseStatus(state) === CATALOG_PHASE_STATUS_PAUSED &&
    requestCreation?.baseCheckpointToken === catalogSyncCheckpointToken(state)
  );
}

function nextCatalogSessionId(state) {
  if (state.sync.progress?.savedData?.sessionId) {
    return state.sync.progress.savedData.sessionId;
  }
  state.ui = {
    ...state.ui,
    catalogSessionCount: (state.ui?.catalogSessionCount || 0) + 1,
  };
  return `catalog-session-${state.ui.catalogSessionCount}`;
}

function buildCatalogSyncProgress(
  state,
  runMode,
  {
    savedAt = null,
    syncPhaseStatus = CATALOG_PHASE_STATUS_RUNNING,
    requestCreationPhaseStatus = CATALOG_PHASE_STATUS_NOT_STARTED,
  } = {},
) {
  const savedData = {
    runMode,
    fetchedCount: state.sync.fetchedCount,
    nextPageIndex: state.sync.pageIndex,
    sessionId: nextCatalogSessionId(state),
  };
  savedData.checkpointToken = `${savedData.sessionId}:0:${savedData.nextPageIndex}:${savedData.fetchedCount}`;
  const progress = {
    runMode,
    phase: CATALOG_SYNC_PHASE,
    checkpoint: `page-${state.sync.pageIndex}`,
    savedData,
    phaseStatuses: catalogPhaseStatuses(syncPhaseStatus, requestCreationPhaseStatus),
  };
  if (savedAt) {
    progress.savedAt = savedAt;
  }
  state.sync.progress = progress;
  state.sync.phase = CATALOG_SYNC_PHASE;
  return progress;
}

function currentCatalogRequestCreation(state) {
  const savedData = catalogSyncSavedData(state);
  const requestCreation = state.sync.progress?.requestCreation;
  if (requestCreation?.baseCheckpointToken === catalogSyncCheckpointToken(state)) {
    return requestCreation;
  }
  return {
    baseCheckpointToken: savedData.checkpointToken || "",
    lastRecordId: "",
    processedCount: 0,
    createdCount: 0,
    unsupportedCount: 0,
  };
}

function buildCatalogRequestCreationProgress(state, requestCreation, { savedAt = null } = {}) {
  state.sync.progress = {
    runMode: SYNC_RUN_MODE_CATALOG_AUTOMATION,
    phase: CATALOG_REQUEST_CREATION_PHASE,
    checkpoint: `request-${requestCreation.lastRecordId || requestCreation.processedCount}`,
    savedData: {
      ...catalogSyncSavedData(state),
      runMode: SYNC_RUN_MODE_CATALOG_AUTOMATION,
    },
    requestCreation,
    phaseStatuses: catalogPhaseStatuses(
      CATALOG_PHASE_STATUS_COMPLETED,
      savedAt ? CATALOG_PHASE_STATUS_PAUSED : CATALOG_PHASE_STATUS_RUNNING,
    ),
  };
  if (savedAt) {
    state.sync.progress.savedAt = savedAt;
  }
  state.sync.phase = CATALOG_REQUEST_CREATION_PHASE;
  return state.sync.progress;
}

function completeCatalogAutomation(state, requestCreation = currentCatalogRequestCreation(state)) {
  state.automation.catalog.statusMessage = `Created ${requestCreation.createdCount} requests.`;
  state.sync.status = "idle";
  state.sync.phase = CATALOG_SYNC_PHASE;
  state.sync.runMode = SYNC_RUN_MODE_CATALOG_AUTOMATION;
  buildCatalogSyncProgress(state, SYNC_RUN_MODE_CATALOG_AUTOMATION, {
    syncPhaseStatus: CATALOG_PHASE_STATUS_COMPLETED,
    requestCreationPhaseStatus: CATALOG_PHASE_STATUS_COMPLETED,
  });
  delete state.sync.progress.requestCreation;
  state.sync.message = `Automated catalog sync complete. Updated ${state.sync.updatedCount}, Skipped ${state.sync.skippedCount}, Added ${state.sync.appendedCount}.`;
}

function syncPauseMessage(runMode, phase = "sync") {
  if (phase === "request_creation") {
    return "Pausing automated request creation after the current batch finishes.";
  }
  if (runMode === SYNC_RUN_MODE_CATALOG_AUTOMATION) {
    return "Pausing automated catalog sync after the current page finishes.";
  }
  if (runMode === SYNC_RUN_MODE_INCOMPLETE_AUTOMATION) {
    return "Pausing incomplete catalog sync after the current batch finishes.";
  }
  return "Pausing after the current page finishes.";
}

function startFreshCatalogRun(state, runMode, { remotePages } = {}) {
  state.sync = {
    ...state.sync,
    ...(remotePages ? { remotePages } : {}),
    status: "syncing",
    fetchedCount: 0,
    skippedCount: 0,
    updatedCount: 0,
    appendedCount: 0,
    pageIndex: 0,
    runMode,
    phase: CATALOG_SYNC_PHASE,
  };
  buildCatalogSyncProgress(state, runMode);
  state.sync.message =
    runMode === SYNC_RUN_MODE_CATALOG_AUTOMATION
      ? "Automated catalog sync is running."
      : "Syncing catalog records.";
}

function resumeCatalogRun(state, runMode) {
  const savedData = catalogSyncSavedData(state);
  const nextPageIndex = savedData.nextPageIndex || 0;
  const fetchedCount = savedData.fetchedCount || 0;

  state.sync = {
    ...state.sync,
    status: "syncing",
    pageIndex: nextPageIndex,
    fetchedCount,
    runMode,
    phase: CATALOG_SYNC_PHASE,
  };

  if (
    runMode === SYNC_RUN_MODE_CATALOG_AUTOMATION &&
    catalogRequestCreationCanResume(state)
  ) {
    buildCatalogRequestCreationProgress(
      state,
      currentCatalogRequestCreation(state),
    );
    state.sync.message = "Resuming automated request creation from saved progress.";
    state.automation.catalog.statusMessage = state.sync.message;
    return;
  }

  buildCatalogSyncProgress(state, runMode);
  state.sync.message =
    runMode === SYNC_RUN_MODE_CATALOG_AUTOMATION
      ? "Continuing automated catalog sync from the saved endpoint."
      : "Continuing catalog sync from the saved endpoint.";
  if (runMode === SYNC_RUN_MODE_CATALOG_AUTOMATION) {
    state.automation.catalog.statusMessage = state.sync.message;
  }
}

function completeIncompleteAutomation(state) {
  let resolvedCount = 0;
  for (const recordItem of state.records) {
    if (
      !categoryIsIncomplete(recordItem.category) ||
      !recordItem.willResolveToCategory ||
      recordItem.resolvedFromIncomplete
    ) {
      continue;
    }
    recordItem.category = recordItem.willResolveToCategory;
    recordItem.wasIncomplete = true;
    recordItem.resolvedFromIncomplete = true;
    const latest = latestRequestForRecord(state, recordItem.id);
    if (latest) {
      latest.state = "created";
    } else {
      createRequestForRecord(state, recordItem.id, "created");
    }
    resolvedCount += 1;
  }
  state.automation.incomplete.statusMessage = `Resolved ${resolvedCount} ${resolvedCount === 1 ? "book" : "books"}.`;
  state.sync.status = "idle";
  state.sync.progress = null;
  state.sync.runMode = SYNC_RUN_MODE_MANUAL;
  state.sync.message = `Incomplete catalog sync complete. Resolved ${resolvedCount} ${resolvedCount === 1 ? "book" : "books"}.`;
}

function catalogRecordCountMessage(state) {
  return `Catalog now has ${state.records.length} ${state.records.length === 1 ? "book record" : "book records"}.`;
}

function advanceSyncPage(state) {
  if (state.sync.runMode === SYNC_RUN_MODE_INCOMPLETE_AUTOMATION) {
    if (state.sync.status === "pausing") {
      state.sync.status = "paused";
      state.sync.progress = {
        savedAt: iso(99),
        checkpoint: `page-${state.sync.pageIndex}`,
        runMode: SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
        savedData: {
          runMode: SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
          fetchedCount: state.sync.fetchedCount,
          nextPageIndex: state.sync.pageIndex,
        },
      };
      state.sync.message = `Saved progress for ${state.sync.fetchedCount} ${state.sync.fetchedCount === 1 ? "record" : "records"} before pausing.`;
      return;
    }
    completeIncompleteAutomation(state);
    return;
  }

  if ((state.sync.phase || state.sync.progress?.phase) === CATALOG_REQUEST_CREATION_PHASE) {
    const requestCreation = currentCatalogRequestCreation(state);
    const batchSize = Math.max(1, state.ui?.catalogRequestBatchSize || 50);
    const batch = [...state.records]
      .sort((left, right) => left.id.localeCompare(right.id))
      .filter((recordItem) =>
        !requestCreation.lastRecordId || recordItem.id > requestCreation.lastRecordId,
      )
      .slice(0, batchSize);
    if (!batch.length) {
      completeCatalogAutomation(state, requestCreation);
      return;
    }
    const nextRequestCreation = { ...requestCreation };
    for (const recordItem of batch) {
      nextRequestCreation.lastRecordId = recordItem.id;
      nextRequestCreation.processedCount += 1;
      const latest = latestRequestForRecord(state, recordItem.id);
      const latestState = latest?.state || recordItem.bookCreationState;
      if (
        (!latest && recordItem.bookCreationState === "not_created") ||
        ["failed", "deleted"].includes(latestState)
      ) {
        createRequestForRecord(state, recordItem.id);
        nextRequestCreation.createdCount += 1;
      }
    }
    const hasMore = [...state.records]
      .sort((left, right) => left.id.localeCompare(right.id))
      .some((recordItem) => recordItem.id > nextRequestCreation.lastRecordId);
    if (state.sync.status === "pausing") {
      if (!hasMore) {
        completeCatalogAutomation(state, nextRequestCreation);
        return;
      }
      state.sync.status = "paused";
      buildCatalogRequestCreationProgress(state, nextRequestCreation, {
        savedAt: iso(99),
      });
      state.sync.message = `Saved request creation progress after scanning ${nextRequestCreation.processedCount} ${nextRequestCreation.processedCount === 1 ? "record" : "records"}.`;
      return;
    }
    if (!hasMore) {
      completeCatalogAutomation(state, nextRequestCreation);
      return;
    }
    buildCatalogRequestCreationProgress(state, nextRequestCreation);
    state.sync.message = `Scanned ${nextRequestCreation.processedCount} catalog ${nextRequestCreation.processedCount === 1 ? "record" : "records"}; created ${nextRequestCreation.createdCount} ${nextRequestCreation.createdCount === 1 ? "request" : "requests"} so far.`;
    return;
  }

  const pageRecords = state.sync.remotePages[state.sync.pageIndex] || [];
  if (!pageRecords.length) {
    if (state.sync.runMode === SYNC_RUN_MODE_CATALOG_AUTOMATION) {
      buildCatalogSyncProgress(state, SYNC_RUN_MODE_CATALOG_AUTOMATION, {
        syncPhaseStatus: CATALOG_PHASE_STATUS_COMPLETED,
      });
      const requestCreation = {
        baseCheckpointToken: catalogSyncCheckpointToken(state),
        lastRecordId: "",
        processedCount: 0,
        createdCount: 0,
        unsupportedCount: 0,
      };
      state.sync.status = "syncing";
      buildCatalogRequestCreationProgress(state, requestCreation);
      state.sync.message = "Creating book requests from the synced catalog records.";
      return;
    }
    finalizeSync(state);
    return;
  }
  reconcilePage(state, pageRecords);
  state.sync.fetchedCount += pageRecords.length;
  state.sync.pageIndex += 1;
  const nextPage = state.sync.remotePages[state.sync.pageIndex] || [];
  if (state.sync.status === "pausing") {
    state.sync.status = "paused";
    buildCatalogSyncProgress(state, state.sync.runMode, { savedAt: iso(99) });
    state.sync.message = `Sync progress saved. ${catalogRecordCountMessage(state)}`;
    return;
  }

  if (!nextPage.length) {
    if (state.sync.runMode === SYNC_RUN_MODE_CATALOG_AUTOMATION) {
      buildCatalogSyncProgress(state, SYNC_RUN_MODE_CATALOG_AUTOMATION, {
        syncPhaseStatus: CATALOG_PHASE_STATUS_COMPLETED,
      });
      const requestCreation = {
        baseCheckpointToken: catalogSyncCheckpointToken(state),
        lastRecordId: "",
        processedCount: 0,
        createdCount: 0,
        unsupportedCount: 0,
      };
      buildCatalogRequestCreationProgress(state, requestCreation);
      state.sync.message = "Creating book requests from the synced catalog records.";
      return;
    }
    finalizeSync(state);
    return;
  }

  buildCatalogSyncProgress(state, state.sync.runMode);
  state.sync.message = catalogRecordCountMessage(state);
}

function advancePipelineState(state) {
  applyRequestTimeouts(state);
  for (const item of state.requests) {
    if (item.state === "initial") {
      item.state = "queued";
    } else if (item.state === "queued") {
      item.state = "processing";
    } else if (item.state === "processing") {
      if (item.pipelineOutcome === "failed") {
        item.state = "failed";
        item.errorMessage = item.errorMessage || "Pipeline failed after retries.";
      } else if (item.pipelineOutcome === "duplicate") {
        item.state = "duplicate";
      } else {
        item.state = "created";
        item.linkedBookId = item.linkedBookId || `linked-${item.bookRecordId}`;
        item.linkedBookSlug = item.linkedBookSlug || `${item.bookRecordId}-book`;
        const recordItem = state.records.find((record) => record.id === item.bookRecordId);
        if (recordItem) {
          recordItem.linkedBookId = item.linkedBookId;
          recordItem.linkedBookSlug = item.linkedBookSlug;
        }
      }
    }
    item.updatedAt = iso(200 + state.requests.indexOf(item));
  }
  applyRequestTimeouts(state);
}

async function mockProcessingApi(page, initialState, options = {}) {
  await page.addInitScript((config) => {
    const sources = new Set();
    window.__processingStreamSourceCount = 0;

    if (config.eventSourceMode === "unsupported") {
      window.EventSource = undefined;
      window.__processingEmitStreamEvent = () => {};
      window.__processingTriggerStreamError = () => {};
      return;
    }

    class MockEventSource {
      constructor() {
        this.listeners = new Map();
        this.onerror = null;
        sources.add(this);
        window.__processingStreamSourceCount = sources.size;
        setTimeout(() => {
          this._emit("connected", {});
        }, 0);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        this.listeners.set(
          type,
          listeners.filter((candidate) => candidate !== listener),
        );
      }

      close() {
        sources.delete(this);
        window.__processingStreamSourceCount = sources.size;
      }

      _emit(type, payload) {
        const listeners = this.listeners.get(type) || [];
        const event = { data: JSON.stringify(payload) };
        listeners.forEach((listener) => listener(event));
      }
    }

    window.EventSource = MockEventSource;
    window.__processingEmitStreamEvent = (type, payload) => {
      sources.forEach((source) => {
        source._emit(type, payload);
      });
    };
    window.__processingTriggerStreamError = () => {
      sources.forEach((source) => {
        source.onerror?.(new Event("error"));
      });
    };
  }, {
    eventSourceMode: options.eventSourceMode || "mock",
  });

  let state = syncRecordStates(clone(initialState));
  let lastSyncStartBody = null;
  let streamTimer = null;
  const requestCounts = {};
  const versions = Object.fromEntries(
    PROCESSING_CARD_KEYS.map((cardKey) => [cardKey, 0]),
  );
  const controller = {
    async emitVersions(domains = PROCESSING_CARD_KEYS) {
      await emitStreamVersions(domains);
    },
    async emitVersionsPayload(payload) {
      if (page.isClosed()) {
        cancelStreamAdvance();
        return;
      }
      try {
        await page.evaluate((nextPayload) => {
          window.__processingEmitStreamEvent?.("versions", nextPayload);
        }, payload);
      } catch {
        cancelStreamAdvance();
      }
    },
    getLastSyncStartBody() {
      return clone(lastSyncStartBody);
    },
    getRequestCount(key) {
      return requestCounts[key] || 0;
    },
    getVersion(domain) {
      return versions[domain] || 0;
    },
    async triggerStreamError() {
      await page.evaluate(() => {
        window.__processingTriggerStreamError?.();
      });
    },
    startStream() {
      scheduleStreamAdvance();
    },
    setNowIso(nowIso) {
      state.ui = {
        ...state.ui,
        nowIso,
      };
    },
    updateRequest(id, updates, domains = PROCESSING_CARD_KEYS) {
      state.requests = state.requests.map((item) =>
        item.id === id ? { ...item, ...updates, updatedAt: iso(900) } : item,
      );
      state = syncRecordStates(state);
      void emitStreamVersions(domains);
      scheduleStreamAdvance();
    },
  };

  function trackRequest(key) {
    requestCounts[key] = (requestCounts[key] || 0) + 1;
  }

  function bumpVersions(domains = PROCESSING_CARD_KEYS) {
    const nextVersions = {};
    for (const domain of domains) {
      versions[domain] = (versions[domain] || 0) + 1;
      nextVersions[domain] = versions[domain];
    }
    return nextVersions;
  }

  function hasActiveStreamWork() {
    return (
      ["syncing", "pausing"].includes(state.sync.status) ||
      state.requests.some((item) =>
        ["initial", "queued", "processing"].includes(item.state),
      )
    );
  }

  function nextStreamDelayMs() {
    return Math.max(
      50,
      ["syncing", "pausing"].includes(state.sync.status)
        ? state.ui?.syncDelayMs || state.ui?.pipelineDelayMs || 500
        : state.ui?.pipelineDelayMs || 500,
    );
  }

  async function emitStreamVersions(domains = PROCESSING_CARD_KEYS) {
    if (page.isClosed()) {
      cancelStreamAdvance();
      return;
    }
    try {
      await page.evaluate((payload) => {
        window.__processingEmitStreamEvent?.("versions", payload);
      }, {
        eventId: Date.now(),
        versions: bumpVersions(domains),
      });
    } catch {
      cancelStreamAdvance();
    }
  }

  function cancelStreamAdvance() {
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
  }

  function scheduleStreamAdvance() {
    cancelStreamAdvance();
    if (!hasActiveStreamWork()) {
      return;
    }

    streamTimer = setTimeout(async () => {
      if (page.isClosed()) {
        cancelStreamAdvance();
        return;
      }
      applyRequestTimeouts(state);
      state = syncRecordStates(state);

      if (["syncing", "pausing"].includes(state.sync.status)) {
        advanceSyncPage(state);
      } else if (hasActiveStreamWork()) {
        advancePipelineState(state);
      }

      state = syncRecordStates(state);
      await emitStreamVersions();
      scheduleStreamAdvance();
    }, nextStreamDelayMs());
  }

  function includeListsForRoute(route) {
    const url = new URL(route.request().url());
    const raw = (url.searchParams.get("includeLists") || "").toLowerCase();
    return !["0", "false", "no", "off"].includes(raw);
  }

  function statePayload(includeLists, extra = {}) {
    return {
      ...(includeLists ? state : {}),
      ...(includeLists
        ? {}
        : {
            sync: state.sync,
            syncStates: {
              catalog: state.sync,
              incomplete: state.sync,
            },
            automation: state.automation,
            ui: state.ui,
          }),
      orchestration: {
        manualPipelineAdvance: false,
      },
      summary: processingSummary(state),
      versions,
      ...extra,
    };
  }

  function mutationPayload(extra = {}, domains = PROCESSING_CARD_KEYS) {
    return {
      ok: true,
      versions: bumpVersions(domains),
      ...extra,
    };
  }

  async function fulfillState(route, extra = {}) {
    applyRequestTimeouts(state);
    state = syncRecordStates(state);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        statePayload(includeListsForRoute(route), extra),
      ),
    });
  }

  async function delayForActions() {
    await new Promise((resolve) => {
      setTimeout(resolve, Math.max(20, state.ui?.actionDelayMs || 80));
    });
  }

  async function delayForLoads(kind = "generic") {
    const routeDelayMs =
      kind === "state"
        ? state.ui?.stateLoadDelayMs
        : kind === "table"
          ? state.ui?.tableLoadDelayMs
          : kind === "card"
            ? state.ui?.cardLoadDelayMs
            : undefined;
    await new Promise((resolve) => {
      setTimeout(
        resolve,
        Math.max(
          0,
          (routeDelayMs ?? state.ui?.loadDelayMs) || 0,
        ),
      );
    });
  }

  await page.route("**/api/processing/state/**", async (route) => {
    trackRequest("state");
    await delayForLoads("state");
    await fulfillState(route);
  });
  await page.route("**/api/processing/card/**", async (route) => {
    await delayForLoads("card");
    applyRequestTimeouts(state);
    state = syncRecordStates(state);
    const url = new URL(route.request().url());
    const cardKey = url.searchParams.get("card") || "";
    trackRequest(`card:${cardKey}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...processingCardPayload(state, cardKey),
        version: versions[cardKey] || 0,
      }),
    });
  });
  await page.route("**/api/processing/table/**", async (route) => {
    await delayForLoads("table");
    applyRequestTimeouts(state);
    state = syncRecordStates(state);
    const url = new URL(route.request().url());
    trackRequest(`table:${url.searchParams.get("card") || ""}`);
    const offset = Number(url.searchParams.get("offset") || 0);
    const limit = Number(url.searchParams.get("limit") || 60);
    const includeFacets = !["0", "false", "no", "off"].includes(
      (url.searchParams.get("includeFacets") || "1").toLowerCase(),
    );
    const payload = filteredTablePayload(state, {
      card: url.searchParams.get("card") || "",
      query: url.searchParams.get("q") || "",
      category: url.searchParams.get("category") || "",
      status: url.searchParams.get("status") || "",
      offset,
      limit,
      includeFacets,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...payload,
        version: versions[url.searchParams.get("card") || ""] || 0,
      }),
    });
  });
  await page.route("**/api/processing/sync/start/**", async (route) => {
    cancelStreamAdvance();
    const body = route.request().postDataJSON();
    lastSyncStartBody = body;
    if (
      state.sync.status === "paused" &&
      catalogSyncPhaseStatus(state) === CATALOG_PHASE_STATUS_PAUSED
    ) {
      resumeCatalogRun(state, SYNC_RUN_MODE_MANUAL);
    } else {
      startFreshCatalogRun(state, SYNC_RUN_MODE_MANUAL, {
        remotePages: body?.remotePages,
      });
    }
    await delayForActions();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mutationPayload()),
    });
    scheduleStreamAdvance();
  });
  await page.route(/\/api\/processing\/sync(?:\/[^/]+)?\/pause\/?(?:\?.*)?$/, async (route) => {
    cancelStreamAdvance();
    if (state.sync.status === "syncing") {
      state.sync.status = "pausing";
      state.sync.message = syncPauseMessage(
        state.sync.runMode,
        state.sync.phase || state.sync.progress?.phase || "sync",
      );
    }
    await delayForActions();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mutationPayload()),
    });
    scheduleStreamAdvance();
  });
  await page.route(/\/api\/processing\/sync(?:\/[^/]+)?\/advance\/?(?:\?.*)?$/, async (route) => {
    cancelStreamAdvance();
    await delayForActions();
    advanceSyncPage(state);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mutationPayload()),
    });
    scheduleStreamAdvance();
  });
  await page.route(/\/api\/processing\/sync(?:\/[^/]+)?\/resume\/?(?:\?.*)?$/, async (route) => {
    cancelStreamAdvance();
    const body = route.request().postDataJSON?.() || {};
    const runMode = body.runMode || state.sync.runMode || SYNC_RUN_MODE_MANUAL;
    if (runMode === SYNC_RUN_MODE_INCOMPLETE_AUTOMATION) {
      state.sync.status = "syncing";
      state.sync.phase = "sync";
      state.sync.progress = {
        runMode,
        savedData: {
          runMode,
          nextPageIndex: 0,
          fetchedCount: state.sync.fetchedCount,
        },
      };
      state.sync.pageIndex = 0;
      state.sync.message = "Restarting incomplete catalog sync from the beginning.";
      state.automation.incomplete.statusMessage = state.sync.message;
    } else {
      resumeCatalogRun(state, runMode);
    }
    await delayForActions();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mutationPayload()),
    });
    scheduleStreamAdvance();
  });
  await page.route(/\/api\/processing\/sync(?:\/[^/]+)?\/stop\/?(?:\?.*)?$/, async (route) => {
    cancelStreamAdvance();
    state.sync.status = "idle";
    state.sync.progress = null;
    state.sync.phase = "sync";
    if (state.sync.runMode === SYNC_RUN_MODE_CATALOG_AUTOMATION) {
      state.automation.catalog.statusMessage = "Automated catalog sync stopped.";
      state.sync.message = "Automated catalog sync stopped.";
    } else if (state.sync.runMode === SYNC_RUN_MODE_INCOMPLETE_AUTOMATION) {
      state.automation.incomplete.statusMessage = "Incomplete catalog sync stopped.";
      state.sync.message = "Incomplete catalog sync stopped.";
    } else {
      state.sync.message = "Catalog sync stopped.";
    }
    state.sync.runMode = SYNC_RUN_MODE_MANUAL;
    await delayForActions();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mutationPayload()),
    });
    scheduleStreamAdvance();
  });
  await page.route("**/api/processing/records/create-requests/**", async (route) => {
    cancelStreamAdvance();
    const body = route.request().postDataJSON();
    await delayForActions();
    for (const id of body.ids || []) {
      const recordItem = state.records.find((item) => item.id === id);
      if (recordItem && recordSelectable(state, recordItem)) {
        createRequestForRecord(state, id);
      }
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        mutationPayload({ createdCount: (body.ids || []).length }),
      ),
    });
    scheduleStreamAdvance();
  });
  await page.route(/\/api\/processing\/automation\/catalog\/?(?:\?.*)?$/, async (route) => {
    state.automation.catalog = {
      ...state.automation.catalog,
      ...route.request().postDataJSON(),
      saved: true,
      statusMessage: "Saved.",
    };
    await delayForActions();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mutationPayload()),
    });
  });
  await page.route("**/api/processing/automation/catalog/run/**", async (route) => {
    cancelStreamAdvance();
    await delayForActions();
    if (
      catalogRequestCreationCanResume(state) ||
      (state.sync.status === "paused" &&
        catalogSyncPhaseStatus(state) === CATALOG_PHASE_STATUS_PAUSED)
    ) {
      resumeCatalogRun(state, SYNC_RUN_MODE_CATALOG_AUTOMATION);
    } else {
      startFreshCatalogRun(state, SYNC_RUN_MODE_CATALOG_AUTOMATION, {
        remotePages: state.sync.remotePages?.length ? state.sync.remotePages : [[]],
      });
      state.automation.catalog.statusMessage = state.sync.message;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mutationPayload()),
    });
    scheduleStreamAdvance();
  });
  await page.route("**/api/processing/requests/action/**", async (route) => {
    cancelStreamAdvance();
    const body = route.request().postDataJSON();
    await delayForActions();
    for (const id of body.ids || []) {
      const item = state.requests.find((requestItem) => requestItem.id === id);
      if (!item) {
        continue;
      }
      if (body.action === "delete") {
        item.state = "deleted";
        item.progress = null;
      } else if (body.action === "pause") {
        item.state = "paused";
        item.progress = {
          savedAt: iso(88),
          checkpoint: "Paused at processing",
          savedData: {},
        };
      } else if (body.action === "resume") {
        item.state = "initial";
        item.isResumed = true;
      } else if (body.action === "retry") {
        item.state = "initial";
        item.errorMessage = null;
      } else if (body.action === "new") {
        item.state = "initial";
        item.isConfirmedNotDuplicate = true;
      } else if (body.action === "confirm_duplicate") {
        item.state = "duplicate";
        item.duplicateConfirmed = true;
      } else if (body.action === "create_again" || body.action === "recreate") {
        item.state = "initial";
      }
      item.updatedAt = iso(300 + state.requests.indexOf(item));
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        mutationPayload({ changedCount: (body.ids || []).length }),
      ),
    });
    scheduleStreamAdvance();
  });
  await page.route(/\/api\/processing\/automation\/incomplete\/?(?:\?.*)?$/, async (route) => {
    state.automation.incomplete = {
      ...state.automation.incomplete,
      ...route.request().postDataJSON(),
      saved: true,
      statusMessage: "Saved.",
    };
    await delayForActions();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mutationPayload()),
    });
  });
  await page.route("**/api/processing/automation/incomplete/run/**", async (route) => {
    cancelStreamAdvance();
    await delayForActions();
    state.sync = {
      ...state.sync,
      status: "syncing",
      progress: {
        runMode: SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
        savedData: {
          runMode: SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
          nextPageIndex: 0,
          fetchedCount: 0,
        },
      },
      fetchedCount: 0,
      skippedCount: 0,
      updatedCount: 0,
      appendedCount: 0,
      pageIndex: 0,
      remotePages: [[]],
      message: "Incomplete catalog sync is running.",
      runMode: SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
    };
    state.automation.incomplete.statusMessage = "Incomplete catalog sync is running.";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mutationPayload()),
    });
    scheduleStreamAdvance();
  });

  return controller;
}

async function boot(page, path, state, options = {}) {
  await mockAuthenticatedSession(page);
  const processingApi = await mockProcessingApi(page, state, options);
  await page.goto(path);
  if (options.eventSourceMode !== "unsupported") {
    await page.waitForFunction(() => window.__processingStreamSourceCount > 0);
    processingApi.startStream();
  }
  return processingApi;
}

function row(page, pageId, cardId, id) {
  return page.getByTestId(`${pageId}-${cardId}-row-${id}`);
}

function card(page, pageId, cardId) {
  return page.getByTestId(`${pageId}-${cardId}-card`);
}

function checkbox(page, pageId, cardId, id) {
  return page.getByTestId(`${pageId}-${cardId}-select-${id}`);
}

async function automationControlHeights(page, pageId) {
  return page.evaluate((targetPageId) => {
    const runButton = document.querySelector(
      `[data-testid="${targetPageId}-automation-run-btn"]`,
    );
    const toggle = document
      .querySelector(`[data-testid="${targetPageId}-automation-enabled"]`)
      ?.closest(".processing-switch");

    if (!runButton || !toggle) {
      return null;
    }

    return {
      button: Math.round(runButton.getBoundingClientRect().height),
      toggle: Math.round(toggle.getBoundingClientRect().height),
    };
  }, pageId);
}

async function controlDimensions(page, controls) {
  return page.evaluate((items) => {
    return Object.fromEntries(
      items.map(({ key, testId, selector, closest }) => {
        const element = selector
          ? document.querySelector(selector)
          : document.querySelector(`[data-testid="${testId}"]`);
        const target = closest ? element?.closest(closest) : element;
        if (!target) {
          return [key, null];
        }
        const rect = target.getBoundingClientRect();
        return [
          key,
          {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        ];
      }),
    );
  }, controls);
}

async function openCardFilters(page, pageId, cardId) {
  await card(page, pageId, cardId)
    .getByRole("button", { name: /^Filters/ })
    .click();
}

async function installNotificationAudioSpy(page) {
  await page.addInitScript(() => {
    const events = [];
    window.__notificationSoundEvents = events;

    class FakeGainNode {
      constructor() {
        this.gain = {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        };
      }

      connect() {}
    }

    class FakeOscillatorNode {
      constructor() {
        this.type = "sine";
        this.frequencyValue = 0;
        this.frequency = {
          setValueAtTime: (value) => {
            this.frequencyValue = value;
          },
        };
      }

      connect() {}

      start(startTime = 0) {
        events.push({
          frequency: this.frequencyValue,
          startTime,
          type: this.type,
        });
      }

      stop() {}
    }

    class FakeAudioContext {
      constructor() {
        this.currentTime = 0;
        this.destination = {};
        this.state = "running";
      }

      createOscillator() {
        return new FakeOscillatorNode();
      }

      createGain() {
        return new FakeGainNode();
      }

      resume() {
        return Promise.resolve();
      }
    }

    window.AudioContext = FakeAudioContext;
    window.webkitAudioContext = FakeAudioContext;
  });
}

async function notificationSoundEventCount(page) {
  return page.evaluate(
    () => (window.__notificationSoundEvents || []).length,
  );
}

async function expectVisibleCount(page, pageId, cardId, count) {
  await expect(page.getByTestId(`${pageId}-${cardId}-count`)).toContainText(
    `${count}`,
  );
}

test.describe("processing pages replacement", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("catalog sync, filters, record selection, and request creation", async ({
    page,
  }) => {
    const existing = record({
      id: "existing",
      name: "Stable Local Book",
      writer: "Local Writer",
      publisher: "Local Press",
      updatedAt: iso(1),
    });
    const active = record({
      id: "active",
      name: "Locked Processing Book",
      category: "Science",
      writer: "Busy Writer",
      publisher: "Busy Press",
      bookCreationState: "processing",
    });
    const remoteChanged = record({
      id: "existing",
      name: "Stable Local Book Revised",
      writer: "Local Writer",
      publisher: "Local Press",
      updatedAt: iso(10),
    });
    const remoteNew = record({
      id: "new-remote",
      name: "Fresh Remote Book",
      url: "https://example.test/books/fresh-remote",
      category: "Poetry",
      writer: "Remote Writer",
      translator: "Case Translator",
      publisher: "Remote House",
      updatedAt: iso(11),
    });

    await boot(
      page,
      "/catalog",
      baseState({
        records: [active, existing],
        requests: [
          request({
            id: "active-request",
            bookRecordId: "active",
            state: "processing",
          }),
        ],
        sync: {
          ...baseState().sync,
          remotePages: [[remoteChanged], [remoteNew], []],
        },
        ui: {
          ...baseState().ui,
          syncDelayMs: 2_000,
        },
      }),
    );

    await expect(
      page.getByRole("heading", { level: 1, name: "Catalog" }),
    ).toBeVisible();
    await expect(page.getByTestId("catalog-overview-stat-records")).toContainText(
      "2",
    );
    await expect(page.getByTestId("catalog-records-table")).toBeVisible();
    await expect(
      page.locator('[data-testid="catalog-records-table"] thead'),
    ).toContainText("Name");
    await expect(
      page.locator('[data-testid="catalog-records-table"] thead'),
    ).toContainText("URL");
    await expect(page.getByTestId("catalog-automation-interval")).toHaveValue("weekly");
    await expect(page.getByTestId("catalog-automation-time")).toHaveValue("03:00");
    await expect(page.getByTestId("catalog-automation-status")).toHaveCount(0);
    expect(await automationControlHeights(page, "catalog")).toEqual({
      button: 30,
      toggle: 30,
    });
    await expect(
      page.locator('[data-testid="catalog-records-table"] tbody tr').first(),
    ).toContainText("Stable Local Book");
    await expect(page.getByTestId("catalog-sync-start-btn")).toHaveCSS(
      "width",
      "58px",
    );
    await expect(page.getByTestId("catalog-sync-start-btn")).toHaveCSS(
      "height",
      "58px",
    );
    await expect(page.getByTestId("catalog-sync-start-btn")).toHaveCSS(
      "color",
      "rgb(236, 255, 246)",
    );

    await page.getByTestId("catalog-sync-start-btn").click();
    await expect(page.getByTestId("catalog-sync-loader")).toBeVisible();
    await expect(page.getByTestId("catalog-sync-pause-btn")).toHaveAttribute(
      "data-state",
      "syncing",
    );

    await page.getByTestId("catalog-sync-pause-btn").click();
    await expect(page.getByTestId("catalog-sync-pause-btn")).toHaveAttribute(
      "data-state",
      "pausing",
    );
    await expect(page.getByTestId("catalog-sync-resume-btn")).toBeVisible();
    await expect(page.getByTestId("catalog-sync-resume-btn")).toHaveCSS(
      "color",
      "rgb(236, 255, 246)",
    );
    await expect(page.getByTestId("catalog-sync-loader")).toHaveCount(0);
    await expect(page.getByTestId("catalog-sync-progress")).toContainText(
      "Catalog now has 2 book records",
    );

    await page.getByTestId("catalog-sync-resume-btn").click();
    await expect(row(page, "catalog", "records", "new-remote")).toBeVisible();
    await expect(row(page, "catalog", "records", "existing")).toContainText(
      "Stable Local Book Revised",
    );
    await expect(page.getByTestId("catalog-sync-progress")).toContainText(
      "Skipped 0",
    );
    await expect(page.getByTestId("catalog-sync-progress")).toContainText(
      "Added 1",
    );
    await expect(page.getByTestId("catalog-sync-progress-summary")).toHaveText(
      "Sync complete.",
    );
    await expect(page.getByTestId("catalog-sync-progress-details")).toHaveText(
      "Updated 1, Skipped 0, Added 1.",
    );
    await expect(page.getByTestId("catalog-overview-stat-records")).toContainText(
      "3",
    );

    await page.getByTestId("catalog-records-search").fill("remote writer");
    await expectVisibleCount(page, "catalog", "records", 1);
    await expect(row(page, "catalog", "records", "new-remote")).toBeVisible();
    await page
      .getByTestId("catalog-records-search")
      .fill("fresh-remote");
    await expectVisibleCount(page, "catalog", "records", 1);
    await page.getByTestId("catalog-records-search").fill("poetry");
    await expectVisibleCount(page, "catalog", "records", 1);
    await page.getByTestId("catalog-records-search").fill("case translator");
    await expectVisibleCount(page, "catalog", "records", 1);
    await page.getByTestId("catalog-records-search").fill("remote house");
    await expectVisibleCount(page, "catalog", "records", 1);
    await page.getByTestId("catalog-records-search").fill("");
    await openCardFilters(page, "catalog", "records");
    await page.getByTestId("catalog-records-category-filter").selectOption("Poetry");
    await expect(page.getByTestId("catalog-records-active-filters")).toContainText(
      "Poetry",
    );
    await expectVisibleCount(page, "catalog", "records", 1);
    await page
      .getByTestId("catalog-records-status-filter")
      .selectOption("not_created");
    await expect(page.getByTestId("catalog-records-active-filters")).toContainText(
      "Not created",
    );

    await page.getByTestId("catalog-records-category-filter").selectOption("");
    await page.getByTestId("catalog-records-status-filter").selectOption("");
    await expect(checkbox(page, "catalog", "records", "active")).toBeDisabled();
    await checkbox(page, "catalog", "records", "new-remote").check();
    await page.getByTestId("catalog-records-create-btn").click();
    await expect(page.getByTestId("catalog-records-loader")).toBeVisible();
    await expect(page.getByTestId("catalog-records-create-btn")).toBeDisabled();
    await expect(page.getByTestId("catalog-records-loader")).toHaveCount(0);
    await page.goto("/create");
    await expect(
      page
        .getByTestId("create-requests-row-request-new-remote")
        .or(page.getByTestId("create-queue-row-request-new-remote"))
        .or(page.getByTestId("create-processing-row-request-new-remote"))
        .or(page.getByTestId("create-created-row-request-new-remote"))
        .first(),
    ).toBeVisible();
  });

  test("manual sync pause persists while navigating away from processing routes", async ({
    page,
  }) => {
    const remotePaused = record({
      id: "pause-remote",
      name: "Pause Remote Book",
      updatedAt: iso(10),
    });

    await boot(
      page,
      "/catalog",
      baseState({
        sync: {
          ...baseState().sync,
          remotePages: [[remotePaused], []],
        },
        ui: {
          ...baseState().ui,
          syncDelayMs: 2_000,
        },
      }),
    );

    await page.getByTestId("catalog-sync-start-btn").click();
    await expect(page.getByTestId("catalog-sync-pause-btn")).toHaveAttribute(
      "data-state",
      "syncing",
    );

    await page.getByTestId("catalog-sync-pause-btn").click();
    await expect(page.getByTestId("catalog-sync-pause-btn")).toHaveAttribute(
      "data-state",
      "pausing",
    );

    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (
        url.includes("/api/processing/") ||
        url.includes("/api/auth/session/") ||
        url.includes("/api/csrf/") ||
        url.includes("/api/catalog/books/")
      ) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    });

    await page.getByRole("link", { name: "Home", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "All Books", exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(4_500);
    await page.getByRole("button", { name: "Processing" }).click();
    await page.getByRole("link", { name: "Catalog", exact: true }).click();

    await expect(page.getByTestId("catalog-sync-resume-btn")).toBeVisible({
      timeout: 1_200,
    });
    await expect(page.getByTestId("catalog-sync-progress")).toContainText(
      "Catalog now has 1 book record",
      { timeout: 1_200 },
    );
  });

  test("processing cards show skeletons and fetch the next batch after scrolling", async ({
    page,
  }) => {
    const records = Array.from({ length: 95 }, (_, index) =>
      record({
        id: `scroll-record-${index.toString().padStart(2, "0")}`,
        name: `Scroll Record ${index.toString().padStart(2, "0")}`,
        url: `https://example.test/books/scroll-record-${index.toString().padStart(2, "0")}`,
        category: index % 2 === 0 ? "Poetry" : "Novel",
      }),
    );

    await boot(
      page,
      "/catalog",
      baseState({
        records,
        ui: {
          ...baseState().ui,
          loadDelayMs: 250,
          pipelineDelayMs: 5_000,
        },
      }),
    );

    await expect(
      page
        .getByTestId("catalog-overview-stat-records")
        .locator(".processing-value-skeleton"),
    ).toBeVisible();
    await expect(page.getByTestId("catalog-records-table-skeleton")).toBeVisible();
    await expect.poll(async () =>
      page.getByTestId("catalog-records-table-skeleton").evaluate((row) => ({
        rowDisplay: window.getComputedStyle(row).display,
        firstCellDisplay: window.getComputedStyle(
          row.querySelector("td"),
        ).display,
      })),
    ).toEqual({
      rowDisplay: "table-row",
      firstCellDisplay: "table-cell",
    });

    await expect(page.getByTestId("catalog-records-row-scroll-record-00")).toBeVisible();
    await expect(page.getByTestId("catalog-records-count")).toContainText("95");
    await expect(
      page.getByTestId("catalog-records-row-scroll-record-70"),
    ).toHaveCount(0);

    await page
      .getByTestId("catalog-records-row-scroll-record-30")
      .scrollIntoViewIfNeeded();

    await expect(
      page.getByTestId("catalog-records-load-more-skeleton"),
    ).toBeVisible();
    await expect(
      page.getByTestId("catalog-records-row-scroll-record-70"),
    ).toHaveCount(1);
  });

  test("catalog loading cards and controls keep the same dimensions as the loaded UI", async ({
    page,
  }) => {
    const initialState = baseState({
      automation: {
        catalog: {
          ...baseState().automation.catalog,
          statusMessage: "Saved.",
        },
        incomplete: {
          ...baseState().automation.incomplete,
        },
      },
      ui: {
        ...baseState().ui,
        loadDelayMs: 450,
        pipelineDelayMs: 5_000,
      },
    });

    await boot(
      page,
      "/catalog",
      initialState,
    );

    await expect(page.getByTestId("catalog-automation-run-skeleton")).toBeVisible();
    await expect(page.getByTestId("catalog-sync-control-skeleton")).toBeVisible();

    const loadingDimensions = await controlDimensions(page, [
      { key: "automationRun", testId: "catalog-automation-run-skeleton" },
      {
        key: "automationToggle",
        testId: "catalog-automation-enabled-skeleton",
      },
      {
        key: "automationInterval",
        testId: "catalog-automation-interval-skeleton",
      },
      {
        key: "automationTime",
        testId: "catalog-automation-time-skeleton",
      },
      { key: "automationSave", testId: "catalog-automation-save-skeleton" },
      { key: "manualSync", testId: "catalog-sync-control-skeleton" },
      { key: "recordsCount", testId: "catalog-records-count" },
      {
        key: "overviewValue",
        selector:
          '[data-testid="catalog-overview-stat-records"] .processing-value-skeleton',
      },
      {
        key: "manualStatus",
        selector: '[data-testid="catalog-sync-card"] .processing-status-skeleton',
      },
    ]);

    await expect(page.getByTestId("catalog-automation-run-btn")).toBeVisible();
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeVisible();

    const loadedDimensions = await controlDimensions(page, [
      { key: "automationRun", testId: "catalog-automation-run-btn" },
      {
        key: "automationToggle",
        testId: "catalog-automation-enabled",
        closest: ".processing-switch",
      },
      {
        key: "automationInterval",
        testId: "catalog-automation-interval",
        closest: ".processing-automation-field-control",
      },
      {
        key: "automationTime",
        testId: "catalog-automation-time",
        closest: ".processing-automation-field-control",
      },
      { key: "automationSave", testId: "catalog-automation-save-btn" },
      { key: "manualSync", testId: "catalog-sync-start-btn" },
      { key: "recordsCount", testId: "catalog-records-count" },
      {
        key: "overviewValue",
        selector: '[data-testid="catalog-overview-stat-records"] strong',
      },
      {
        key: "manualStatus",
        testId: "catalog-sync-progress",
      },
    ]);

    expect({
      automationRun: loadingDimensions.automationRun,
      automationToggle: loadingDimensions.automationToggle,
      automationInterval: loadingDimensions.automationInterval,
      automationTime: loadingDimensions.automationTime,
      automationSave: loadingDimensions.automationSave,
      manualSync: loadingDimensions.manualSync,
      recordsCount: loadingDimensions.recordsCount,
    }).toEqual({
      automationRun: loadedDimensions.automationRun,
      automationToggle: loadedDimensions.automationToggle,
      automationInterval: loadedDimensions.automationInterval,
      automationTime: loadedDimensions.automationTime,
      automationSave: loadedDimensions.automationSave,
      manualSync: loadedDimensions.manualSync,
      recordsCount: loadedDimensions.recordsCount,
    });
    expect(loadingDimensions.overviewValue?.height).toBe(
      loadedDimensions.overviewValue?.height,
    );
    expect(loadingDimensions.manualStatus?.height).toBe(
      loadedDimensions.manualStatus?.height,
    );
  });

  test("catalog table skeleton rows keep the same dimensions as loaded rows", async ({
    page,
  }) => {
    await boot(
      page,
      "/catalog",
      baseState({
        records: [
          record({
            id: "catalog-row-size",
            name: "Catalog Row Size",
            category: "Poetry",
            writer: "Row Writer",
            publisher: "Row Publisher",
          }),
        ],
        ui: {
          ...baseState().ui,
          loadDelayMs: 450,
          pipelineDelayMs: 5_000,
        },
      }),
    );

    await expect(page.getByTestId("catalog-records-table-skeleton")).toBeVisible();

    const loadingRowDimensions = await controlDimensions(page, [
      { key: "row", testId: "catalog-records-table-skeleton" },
    ]);

    await expect(
      page.getByTestId("catalog-records-row-catalog-row-size"),
    ).toBeVisible();

    const loadedRowDimensions = await controlDimensions(page, [
      { key: "row", testId: "catalog-records-row-catalog-row-size" },
    ]);

    expect(
      Math.abs(
        (loadingRowDimensions.row?.height ?? 0) -
          (loadedRowDimensions.row?.height ?? 0),
      ),
    ).toBeLessThanOrEqual(1);
  });

  test("catalog records show bangla source urls as decoded text", async ({
    page,
  }) => {
    const encodedUrl =
      "https://www.ebanglalibrary.com/books/%E0%A6%85%E0%A6%97%E0%A7%8D%E0%A6%A8%E0%A6%BF%E0%A6%AA%E0%A6%B0%E0%A7%80%E0%A6%95%E0%A7%8D%E0%A6%B7%E0%A6%BE-%E0%A6%86%E0%A6%B6%E0%A6%BE%E0%A6%AA%E0%A7%82%E0%A6%B0%E0%A7%8D%E0%A6%A3%E0%A6%BE/";
    const decodedUrl =
      "https://www.ebanglalibrary.com/books/অগ্নিপরীক্ষা-আশাপূর্ণা/";
    const encodedFragment =
      "%E0%A6%85%E0%A6%97%E0%A7%8D%E0%A6%A8%E0%A6%BF%E0%A6%AA%E0%A6%B0";

    await boot(
      page,
      "/catalog",
      baseState({
        records: [
          record({
            id: "bangla-record",
            name: "অগ্নিপরীক্ষা",
            url: encodedUrl,
            category: "উপন্যাস",
            writer: "আশাপূর্ণা দেবী",
          }),
        ],
      }),
    );

    const banglaRow = row(page, "catalog", "records", "bangla-record");
    await expect(banglaRow).toContainText(decodedUrl);
    await expect(banglaRow).not.toContainText(encodedFragment);
  });

  test("manual sync completes automatically without an explicit pause", async ({
    page,
  }) => {
    await boot(
      page,
      "/catalog",
      baseState({
        sync: {
          ...baseState().sync,
          remotePages: [
            [record({ id: "sync-a", name: "Sync A", updatedAt: iso(21) })],
            [record({ id: "sync-b", name: "Sync B", updatedAt: iso(22) })],
            [],
          ],
        },
        ui: {
          ...baseState().ui,
          syncDelayMs: 120,
          pipelineDelayMs: 2_000,
        },
      }),
    );

    await page.getByTestId("catalog-sync-start-btn").click();
    await expect(page.getByTestId("catalog-sync-loader")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Sync started" })).toBeVisible();
    await expect(page.getByTestId("catalog-sync-pause-btn")).toHaveAttribute(
      "data-state",
      "syncing",
    );
    await expect(row(page, "catalog", "records", "sync-a")).toBeVisible();
    await expect(row(page, "catalog", "records", "sync-b")).toBeVisible();
    await expect(page.getByTestId("catalog-sync-loader")).toHaveCount(0);
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeEnabled();
    await expect(page.getByTestId("catalog-sync-progress")).toContainText(
      "Sync complete",
    );
  });

  test("manual sync does not repost incomplete automation page ids", async ({
    page,
  }) => {
    const processingApi = await boot(
      page,
      "/catalog",
      baseState({
        sync: {
          ...baseState().sync,
          message: "Incomplete catalog sync complete. Resolved 1 book.",
          remotePages: [["stale-incomplete-record"], []],
        },
        ui: {
          ...baseState().ui,
          syncDelayMs: 5_000,
        },
      }),
    );

    await page.getByTestId("catalog-sync-start-btn").click();
    await expect(page.getByTestId("catalog-sync-loader")).toBeVisible();

    expect(processingApi.getLastSyncStartBody()?.remotePages).toBeUndefined();
  });

  test("automated catalog sync creates eligible requests and auto-advances them", async ({
    page,
  }) => {
    const records = [
      record({ id: "auto-new", name: "Auto New", bookCreationState: "not_created" }),
      record({ id: "auto-failed", name: "Auto Failed", bookCreationState: "failed" }),
      record({ id: "auto-deleted", name: "Auto Deleted", bookCreationState: "deleted" }),
      record({ id: "auto-created", name: "Auto Created", bookCreationState: "created" }),
      record({ id: "auto-paused", name: "Auto Paused", bookCreationState: "paused" }),
    ];

    await boot(
      page,
      "/catalog",
      baseState({
        records,
        requests: [
          request({ id: "failed-old", bookRecordId: "auto-failed", state: "failed" }),
          request({ id: "deleted-old", bookRecordId: "auto-deleted", state: "deleted" }),
          request({ id: "created-old", bookRecordId: "auto-created", state: "created" }),
          request({ id: "paused-old", bookRecordId: "auto-paused", state: "paused" }),
        ],
      }),
    );

    await page.getByTestId("catalog-automation-enabled").check();
    await page.getByTestId("catalog-automation-interval").selectOption("weekly");
    await page.getByTestId("catalog-automation-time").fill("04:30");
    await page.getByTestId("catalog-automation-save-btn").click();
    await expect(page.getByTestId("catalog-automation-status")).toContainText(
      "Saved",
    );

    await page.getByTestId("catalog-automation-run-btn").click();
    await expect(page.getByTestId("catalog-automation-run-btn")).toHaveAttribute(
      "data-state",
      "syncing",
    );
    await expect(page.getByTestId("catalog-automation-status")).toContainText(
      "Created 3 request",
    );

    await page.goto("/create");
    await expect(row(page, "create", "created", "request-auto-new")).toBeVisible();
    await expect(row(page, "create", "requests", "request-auto-new")).toHaveCount(0);
    await expect(row(page, "create", "queue", "request-auto-new")).toHaveCount(0);
    await expect(row(page, "create", "processing", "request-auto-new")).toHaveCount(0);
    await expect(row(page, "create", "created", "request-auto-failed")).toBeVisible();
    await expect(row(page, "create", "created", "request-auto-deleted")).toBeVisible();
    await expect(row(page, "create", "created", "created-old")).toBeVisible();
    await expect(row(page, "create", "paused", "paused-old")).toHaveCount(0);
  });

  test("paused catalog sync keeps manual and automation runtime ownership isolated", async ({
    page,
  }) => {
    const remainingPage = record({
      id: "resume-remote",
      name: "Resume Remote Book",
      updatedAt: iso(25),
    });
    await boot(
      page,
      "/catalog",
      baseState({
        records: [
          record({ id: "resume-a", name: "Resume A", updatedAt: iso(20) }),
          record({ id: "resume-b", name: "Resume B", updatedAt: iso(21) }),
          record({ id: "resume-c", name: "Resume C", updatedAt: iso(22) }),
        ],
        sync: {
          ...baseState().sync,
          status: "paused",
          phase: "sync",
          runMode: SYNC_RUN_MODE_CATALOG_AUTOMATION,
          remotePages: [[], [], [remainingPage], []],
          fetchedCount: 3,
          progress: {
            runMode: SYNC_RUN_MODE_CATALOG_AUTOMATION,
            phase: "sync",
            savedData: {
              runMode: SYNC_RUN_MODE_CATALOG_AUTOMATION,
              nextPageIndex: 2,
              fetchedCount: 3,
              sessionId: "catalog-session-1",
              checkpointToken: "catalog-session-1:0:2:3",
            },
          },
          message: "Sync progress saved. Catalog now has 3 book records.",
        },
      }),
    );

    await expect(page.getByTestId("catalog-automation-run-btn")).toHaveAttribute(
      "data-state",
      "paused",
    );
    await expect(page.getByTestId("catalog-automation-run-btn")).toHaveAttribute(
      "aria-label",
      "Resume automated catalog sync",
    );
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeVisible();
    await expect(page.getByTestId("catalog-sync-start-btn")).toHaveAttribute(
      "aria-label",
      "Start sync",
    );
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeDisabled();

    await page.getByTestId("catalog-automation-run-btn").click();

    await expect(page.getByTestId("catalog-automation-run-btn")).toHaveAttribute(
      "data-state",
      "syncing",
    );
    await expect(page.getByTestId("catalog-automation-status")).toContainText(
      "Continuing automated catalog sync from the saved endpoint.",
    );
  });

  test("catalog cards normalize stale record totals against the live overview count", async ({
    page,
  }) => {
    await boot(
      page,
      "/catalog",
      baseState({
        records: [
          record({ id: "count-a", name: "Count A", updatedAt: iso(20) }),
          record({ id: "count-b", name: "Count B", updatedAt: iso(21) }),
          record({ id: "count-c", name: "Count C", updatedAt: iso(22) }),
        ],
        sync: {
          ...baseState().sync,
          status: "idle",
          phase: "sync",
          message: "Catalog now has 1 book record.",
          progress: {
            runMode: SYNC_RUN_MODE_MANUAL,
            phase: "sync",
            savedData: {
              runMode: SYNC_RUN_MODE_MANUAL,
              nextPageIndex: 3,
              fetchedCount: 3,
              sessionId: "catalog-session-counts",
              checkpointToken: "catalog-session-counts:0:3:3",
            },
            phaseStatuses: {
              sync: "completed",
              request_creation: "not_started",
            },
          },
        },
        automation: {
          ...baseState().automation,
          catalog: {
            ...baseState().automation.catalog,
            statusMessage: "Catalog now has 1 book record.",
          },
        },
      }),
    );

    await expect(page.getByTestId("catalog-overview-stat-records")).toContainText("3");
    await expect(page.getByTestId("catalog-sync-progress")).toContainText(
      "Catalog now has 3 book records.",
    );
    await expect(page.getByTestId("catalog-automation-status")).toContainText(
      "Catalog now has 3 book records.",
    );
  });

  test("create, on hold, and incomplete pages use shared processing state for overview cards", async ({
    page,
  }) => {
    const processingApi = await boot(
      page,
      "/create",
      baseState({
        requests: [
          request({ id: "req-initial", bookRecordId: "record-1", state: "initial" }),
          request({ id: "req-created", bookRecordId: "record-2", state: "created" }),
          request({ id: "req-paused", bookRecordId: "record-3", state: "paused" }),
        ],
        records: [
          record({ id: "record-1", name: "Record One", updatedAt: iso(20) }),
          record({ id: "record-2", name: "Record Two", updatedAt: iso(21) }),
          record({
            id: "record-3",
            name: "Record Three",
            updatedAt: iso(22),
            wasIncomplete: true,
            resolvedFromIncomplete: false,
          }),
        ],
      }),
    );

    await expect(page.getByTestId("create-overview-stat-requests")).toContainText("1");
    expect(processingApi.getRequestCount("state")).toBeGreaterThan(0);
    expect(processingApi.getRequestCount("card:create-overview")).toBe(0);

    await page.goto("/on-hold");
    await expect(page.getByTestId("on-hold-overview-stat-paused")).toContainText("1");
    expect(processingApi.getRequestCount("card:on-hold-overview")).toBe(0);

    await page.goto("/incomplete");
    await expect(page.getByTestId("incomplete-overview-stat-incomplete")).toContainText("1");
    expect(processingApi.getRequestCount("card:incomplete-overview")).toBe(0);
    expect(processingApi.getRequestCount("card:incomplete-automation")).toBe(0);
  });

  test("unsupported live updates fall back to polling shared state", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const realSetInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) =>
        realSetInterval(callback, delay >= 15000 ? 25 : delay, ...args);
    });

    const processingApi = await boot(
      page,
      "/create",
      baseState({
        requests: [
          request({ id: "req-unsupported", bookRecordId: "record-1", state: "initial" }),
        ],
        records: [
          record({ id: "record-1", name: "Record One", updatedAt: iso(20) }),
        ],
      }),
      { eventSourceMode: "unsupported" },
    );

    await expect(page.getByTestId("create-stream-status")).toContainText(
      "Live updates are unavailable in this browser.",
    );
    await expect(page.getByTestId("create-overview-stat-requests")).toContainText("1");

    const initialStateRequests = processingApi.getRequestCount("state");
    processingApi.updateRequest("req-unsupported", { state: "paused" });

    await expect(page.getByTestId("create-overview-stat-requests")).toContainText("0");
    await expect
      .poll(() => processingApi.getRequestCount("state"))
      .toBeGreaterThan(initialStateRequests);
  });

  test("manual start from paused automated request creation restarts sync from the beginning", async ({
    page,
  }) => {
    await boot(
      page,
      "/catalog",
      baseState({
        records: [
          record({ id: "carry-a", name: "Carry A", bookCreationState: "created" }),
          record({ id: "carry-b", name: "Carry B", updatedAt: iso(24) }),
        ],
        requests: [
          request({
            id: "request-carry-a",
            bookRecordId: "carry-a",
            state: "created",
          }),
        ],
        sync: {
          ...baseState().sync,
          status: "paused",
          phase: "request_creation",
          runMode: SYNC_RUN_MODE_CATALOG_AUTOMATION,
          remotePages: [[record({ id: "carry-b", name: "Carry B", updatedAt: iso(24) })], []],
          pageIndex: 1,
          fetchedCount: 1,
          progress: {
            runMode: SYNC_RUN_MODE_CATALOG_AUTOMATION,
            phase: "request_creation",
            phaseStatuses: {
              sync: "completed",
              request_creation: "paused",
            },
            savedData: {
              runMode: SYNC_RUN_MODE_CATALOG_AUTOMATION,
              nextPageIndex: 1,
              fetchedCount: 1,
              sessionId: "catalog-session-9",
              checkpointToken: "catalog-session-9:0:1:1",
            },
            requestCreation: {
              baseCheckpointToken: "catalog-session-9:0:1:1",
              lastRecordId: "carry-a",
              processedCount: 1,
              createdCount: 1,
              unsupportedCount: 0,
            },
          },
          message: "Saved request creation progress after scanning 1 record.",
        },
        automation: {
          ...baseState().automation,
          catalog: {
            ...baseState().automation.catalog,
            statusMessage: "Saved request creation progress after scanning 1 record.",
          },
        },
        ui: {
          ...baseState().ui,
          syncDelayMs: 120,
          pipelineDelayMs: 120,
        },
      }),
    );

    await expect(page.getByTestId("catalog-sync-start-btn")).toBeEnabled();
    await expect(page.getByTestId("catalog-automation-run-btn")).toHaveAttribute(
      "aria-label",
      "Resume automated request creation",
    );
    await page.getByTestId("catalog-sync-start-btn").click();
    await expect(page.getByTestId("catalog-sync-progress")).toContainText("Sync complete.");
    await expect(page.getByTestId("catalog-sync-progress")).not.toContainText(
      "Continuing catalog sync from the saved endpoint.",
    );
    await expect(page.getByTestId("catalog-sync-loader")).toHaveCount(0);

    await expect(page.getByTestId("catalog-automation-run-btn")).toHaveAttribute(
      "aria-label",
      "Run automated catalog sync",
    );

    await page.getByTestId("catalog-automation-run-btn").click();
    await expect(page.getByTestId("catalog-automation-status")).toContainText(
      "Automated catalog sync is running.",
    );
    await expect(page.getByTestId("catalog-automation-status")).toContainText("Created 1 request");

    await page.goto("/create");
    await expect(row(page, "create", "created", "request-carry-a")).toBeVisible();
    await expect(row(page, "create", "created", "request-carry-b")).toBeVisible();
  });

  test("create cards show only status-scoped rows and remove the details column", async ({
    page,
  }) => {
    await boot(
      page,
      "/create",
      baseState({
        records: [
          record({ id: "initial-only", name: "Initial Only", category: "Poetry" }),
          record({ id: "queued-only", name: "Queued Only", category: "Science" }),
          record({ id: "processing-only", name: "Processing Only", category: "Drama" }),
          record({ id: "created-only", name: "Created Only", category: "History" }),
        ],
        requests: [
          request({ id: "initial-only-request", bookRecordId: "initial-only", state: "initial" }),
          request({ id: "queued-only-request", bookRecordId: "queued-only", state: "queued" }),
          request({
            id: "processing-only-request",
            bookRecordId: "processing-only",
            state: "processing",
          }),
          request({
            id: "created-only-request",
            bookRecordId: "created-only",
            state: "created",
            linkedBookId: "created-only-book-id",
            linkedBookSlug: "created-only-book",
          }),
        ],
        ui: {
          ...baseState().ui,
          pipelineDelayMs: 60_000,
        },
      }),
    );

    for (const cardId of ["requests", "queue", "processing"]) {
      await expect(
        page.getByTestId(`create-${cardId}-table`).getByRole("columnheader", {
          name: "Details",
        }),
      ).toHaveCount(0);
      await expect(page.getByTestId(`create-${cardId}-table`).locator("thead th")).toHaveCount(6);
    }
    await expect(
      page.getByTestId("create-created-table").getByRole("columnheader", {
        name: "Details",
      }),
    ).toHaveCount(0);
    await expect(
      page
        .getByTestId("create-created-table")
        .locator("thead th")
        .filter({ hasText: "Open" }),
    ).toHaveCount(1);
    await expect(page.getByTestId("create-created-table").locator("thead th")).toHaveCount(7);

    await expectVisibleCount(page, "create", "requests", 1);
    await expectVisibleCount(page, "create", "queue", 1);
    await expectVisibleCount(page, "create", "processing", 1);
    await expectVisibleCount(page, "create", "created", 1);

    await expect(row(page, "create", "requests", "initial-only-request")).toBeVisible();
    await expect(row(page, "create", "requests", "initial-only-request")).toContainText("Initial");
    await expect(
      row(page, "create", "requests", "initial-only-request").locator(".processing-col-details"),
    ).toHaveCount(0);
    await expect(row(page, "create", "requests", "queued-only-request")).toHaveCount(0);
    await expect(row(page, "create", "requests", "processing-only-request")).toHaveCount(0);
    await expect(row(page, "create", "requests", "created-only-request")).toHaveCount(0);

    await expect(row(page, "create", "queue", "queued-only-request")).toBeVisible();
    await expect(row(page, "create", "queue", "queued-only-request")).toContainText("Queued");
    await expect(
      row(page, "create", "queue", "queued-only-request").locator(".processing-col-details"),
    ).toHaveCount(0);
    await expect(row(page, "create", "queue", "initial-only-request")).toHaveCount(0);
    await expect(row(page, "create", "queue", "processing-only-request")).toHaveCount(0);
    await expect(row(page, "create", "queue", "created-only-request")).toHaveCount(0);

    await expect(row(page, "create", "processing", "processing-only-request")).toBeVisible();
    await expect(row(page, "create", "processing", "processing-only-request")).toContainText(
      "Processing",
    );
    await expect(
      row(page, "create", "processing", "processing-only-request").locator(
        ".processing-col-details",
      ),
    ).toHaveCount(0);
    await expect(row(page, "create", "processing", "initial-only-request")).toHaveCount(0);
    await expect(row(page, "create", "processing", "queued-only-request")).toHaveCount(0);
    await expect(row(page, "create", "processing", "created-only-request")).toHaveCount(0);

    await expect(row(page, "create", "created", "created-only-request")).toBeVisible();
    await expect(row(page, "create", "created", "created-only-request")).toContainText("Created");
    await expect(
      row(page, "create", "created", "created-only-request").locator(".processing-col-details"),
    ).toHaveCount(0);
    await expect(
      row(page, "create", "created", "created-only-request").getByRole("link", {
        name: "Open",
      }),
    ).toHaveAttribute("href", "/books/created-only-book");
    await expect(row(page, "create", "created", "initial-only-request")).toHaveCount(0);
    await expect(row(page, "create", "created", "queued-only-request")).toHaveCount(0);
    await expect(row(page, "create", "created", "processing-only-request")).toHaveCount(0);
  });

  test("create card skeleton rows match the visible status-only table structure", async ({
    page,
  }) => {
    await boot(
      page,
      "/create",
      baseState({
        records: [
          record({ id: "queued-skeleton", name: "Queued Skeleton", category: "Science" }),
        ],
        requests: [
          request({
            id: "queued-skeleton-request",
            bookRecordId: "queued-skeleton",
            state: "queued",
          }),
        ],
        ui: {
          ...baseState().ui,
          loadDelayMs: 450,
          pipelineDelayMs: 60_000,
        },
      }),
    );

    const queueTable = page.getByTestId("create-queue-table");
    const queueSkeletonRow = page.getByTestId("create-queue-table-skeleton");

    await expect(queueSkeletonRow).toBeVisible();
    await expect(
      queueTable.getByRole("columnheader", {
        name: "Details",
      }),
    ).toHaveCount(0);
    await expect(queueTable.locator("thead th")).toHaveCount(6);
  });

  test("empty create cards keep their empty state after the first load", async ({
    page,
  }) => {
    await boot(
      page,
      "/create",
      baseState({
        records: [
          record({ id: "initial-lone", name: "Initial Lone", category: "Reference" }),
        ],
        requests: [
          request({
            id: "initial-lone-request",
            bookRecordId: "initial-lone",
            state: "initial",
          }),
        ],
        ui: {
          ...baseState().ui,
          loadDelayMs: 450,
          pipelineDelayMs: 20_000,
        },
      }),
    );

    const emptyCreatedCell = page
      .getByTestId("create-created-table")
      .locator("tbody td")
      .filter({ hasText: "No records." });

    await expect(emptyCreatedCell).toBeVisible();
    await expect(page.getByTestId("create-created-table-skeleton")).toHaveCount(0);
    await expect(
      page
        .getByTestId("create-created-count")
        .locator(".processing-card-count-skeleton"),
    ).toHaveCount(0);

    await page.waitForTimeout(200);

    await expect(emptyCreatedCell).toBeVisible();
    await expect(page.getByTestId("create-created-table-skeleton")).toHaveCount(0);
    await expect(
      page
        .getByTestId("create-created-count")
        .locator(".processing-card-count-skeleton"),
    ).toHaveCount(0);
  });

  test("offscreen create cards wait to fetch rows until they enter view", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 430, height: 520 });
    const processingApi = await boot(
      page,
      "/create",
      baseState({
        requests: [
          request({ id: "req-initial", bookRecordId: "record-1", state: "initial" }),
          request({ id: "req-queued", bookRecordId: "record-2", state: "queued" }),
          request({ id: "req-processing", bookRecordId: "record-3", state: "processing" }),
          request({ id: "req-created", bookRecordId: "record-4", state: "created" }),
        ],
        records: [
          record({ id: "record-1", name: "Record One", updatedAt: iso(20) }),
          record({ id: "record-2", name: "Record Two", updatedAt: iso(21) }),
          record({ id: "record-3", name: "Record Three", updatedAt: iso(22) }),
          record({ id: "record-4", name: "Record Four", updatedAt: iso(23) }),
        ],
      }),
    );

    await expect(page.getByTestId("create-created-count")).toContainText("1");
    expect(processingApi.getRequestCount("table:create-created")).toBe(0);
    processingApi.updateRequest(
      "req-created",
      { updatedAt: iso(99) },
      ["create-created"],
    );
    await page.waitForTimeout(150);
    expect(processingApi.getRequestCount("table:create-created")).toBe(0);

    await card(page, "create", "created").scrollIntoViewIfNeeded();
    await expect(
      row(page, "create", "created", "req-created"),
    ).toContainText("Record Four");
    expect(processingApi.getRequestCount("table:create-created")).toBeGreaterThan(0);
  });

  test("visible card version bumps refetch only the changed table card", async ({
    page,
  }) => {
    const processingApi = await boot(
      page,
      "/create",
      baseState({
        requests: [
          request({ id: "req-initial", bookRecordId: "record-1", state: "initial" }),
          request({ id: "req-queued", bookRecordId: "record-2", state: "queued" }),
        ],
        records: [
          record({ id: "record-1", name: "Record One", updatedAt: iso(20) }),
          record({ id: "record-2", name: "Record Two", updatedAt: iso(21) }),
        ],
        ui: {
          ...baseState().ui,
          pipelineDelayMs: 60_000,
        },
      }),
    );

    await expect(row(page, "create", "requests", "req-initial")).toBeVisible();
    await expect(row(page, "create", "queue", "req-queued")).toBeVisible();

    const initialRequestsLoads = processingApi.getRequestCount("table:create-requests");
    const initialQueueLoads = processingApi.getRequestCount("table:create-queue");

    processingApi.updateRequest(
      "req-initial",
      { errorMessage: "Updated row without leaving Requests." },
      ["create-requests"],
    );

    await expect
      .poll(() => processingApi.getRequestCount("table:create-requests"))
      .toBe(initialRequestsLoads + 1);
    await page.waitForTimeout(150);
    expect(processingApi.getRequestCount("table:create-queue")).toBe(
      initialQueueLoads,
    );
  });

  test("visible cards keep loaded rows during version-driven background refreshes", async ({
    page,
  }) => {
    const processingApi = await boot(
      page,
      "/create",
      baseState({
        requests: [
          request({ id: "req-initial", bookRecordId: "record-1", state: "initial" }),
        ],
        records: [
          record({ id: "record-1", name: "Record One", updatedAt: iso(20) }),
        ],
        ui: {
          ...baseState().ui,
          stateLoadDelayMs: 50,
          tableLoadDelayMs: 400,
          pipelineDelayMs: 60_000,
        },
      }),
    );

    await expect(row(page, "create", "requests", "req-initial")).toBeVisible();
    const initialLoads = processingApi.getRequestCount("table:create-requests");

    processingApi.updateRequest(
      "req-initial",
      { state: "paused" },
      ["create-requests", "create-overview", "on-hold-overview"],
    );

    await page.waitForTimeout(150);
    await expect(row(page, "create", "requests", "req-initial")).toBeVisible();
    await expect(page.getByTestId("create-requests-table-skeleton")).toHaveCount(0);

    await expect
      .poll(() => processingApi.getRequestCount("table:create-requests"))
      .toBe(initialLoads + 1);
    await expect(row(page, "create", "requests", "req-initial")).toHaveCount(0);
    await expect(page.getByTestId("create-overview-stat-requests")).toContainText("0");
  });

  test("later equal-version SSE events do not duplicate an action-driven refresh", async ({
    page,
  }) => {
    const processingApi = await boot(
      page,
      "/create",
      baseState({
        requests: [
          request({ id: "req-initial", bookRecordId: "record-1", state: "initial" }),
        ],
        records: [
          record({ id: "record-1", name: "Record One", updatedAt: iso(20) }),
        ],
        ui: {
          ...baseState().ui,
          pipelineDelayMs: 60_000,
        },
      }),
    );

    await expect(row(page, "create", "requests", "req-initial")).toBeVisible();
    const initialLoads = processingApi.getRequestCount("table:create-requests");

    await checkbox(page, "create", "requests", "req-initial").check();
    await page.getByTestId("create-requests-delete-btn").click();
    await expect(row(page, "create", "requests", "req-initial")).toHaveCount(0);
    await expect
      .poll(() => processingApi.getRequestCount("table:create-requests"))
      .toBe(initialLoads + 1);

    const currentVersion = processingApi.getVersion("create-requests");
    await processingApi.emitVersionsPayload({
      eventId: Date.now(),
      versions: {
        "create-requests": currentVersion,
      },
    });

    await page.waitForTimeout(150);
    expect(processingApi.getRequestCount("table:create-requests")).toBe(
      initialLoads + 1,
    );
  });

  test("card search, filters, counts, and actions stay scoped to their own cards", async ({
    page,
  }) => {
    await boot(
      page,
      "/create",
      baseState({
        records: [
          record({ id: "initial-alpha", name: "Initial Alpha", category: "Poetry" }),
          record({ id: "initial-beta", name: "Initial Beta", category: "Science" }),
          record({ id: "queued-alpha", name: "Queued Alpha", category: "Poetry" }),
          record({ id: "queued-beta", name: "Queued Beta", category: "Science" }),
        ],
        requests: [
          request({ id: "initial-alpha-request", bookRecordId: "initial-alpha", state: "initial" }),
          request({ id: "initial-beta-request", bookRecordId: "initial-beta", state: "initial" }),
          request({ id: "queued-alpha-request", bookRecordId: "queued-alpha", state: "queued" }),
          request({ id: "queued-beta-request", bookRecordId: "queued-beta", state: "queued" }),
        ],
        ui: { actionDelayMs: 400, pipelineDelayMs: 2_000 },
      }),
    );

    await expectVisibleCount(page, "create", "requests", 2);
    await expectVisibleCount(page, "create", "queue", 2);

    await page.getByTestId("create-requests-search").fill("alpha");
    await expectVisibleCount(page, "create", "requests", 1);
    await expect(row(page, "create", "requests", "initial-alpha-request")).toBeVisible();
    await expect(row(page, "create", "requests", "initial-beta-request")).toHaveCount(0);
    await expectVisibleCount(page, "create", "queue", 2);

    await openCardFilters(page, "create", "queue");
    await page.getByTestId("create-queue-category-filter").selectOption("Science");
    await expect(page.getByTestId("create-queue-active-filters")).toContainText(
      "Science",
    );
    await expectVisibleCount(page, "create", "queue", 1);
    await expect(row(page, "create", "queue", "queued-beta-request")).toBeVisible();
    await expect(row(page, "create", "queue", "queued-alpha-request")).toHaveCount(0);
    await expectVisibleCount(page, "create", "requests", 1);

    await checkbox(page, "create", "queue", "queued-beta-request").check();
    await page.getByTestId("create-queue-delete-btn").click();
    await expect(page.getByTestId("create-queue-loader")).toBeVisible();
    await expect(page.getByTestId("create-requests-search")).toHaveValue("alpha");
    await expectVisibleCount(page, "create", "requests", 1);
    await expect(
      checkbox(page, "create", "requests", "initial-alpha-request"),
    ).toBeEnabled();
    await expect(page.getByTestId("create-queue-loader")).toHaveCount(0);
  });

  test("create page cards isolate loaders and move requests between states", async ({
    page,
  }) => {
    await boot(
      page,
      "/create",
      baseState({
        records: [
          record({ id: "initial-a", name: "Initial A", category: "Poetry" }),
          record({ id: "initial-b", name: "Initial B", category: "Poetry" }),
          record({ id: "queued-a", name: "Queued A", category: "Science" }),
          record({ id: "processing-a", name: "Processing A", category: "Science" }),
          record({ id: "created-a", name: "Created A", category: "History" }),
        ],
        requests: [
          request({ id: "initial-a-request", bookRecordId: "initial-a", state: "initial" }),
          request({ id: "initial-b-request", bookRecordId: "initial-b", state: "initial" }),
          request({ id: "queued-a-request", bookRecordId: "queued-a", state: "queued" }),
          request({ id: "processing-a-request", bookRecordId: "processing-a", state: "processing" }),
          request({
            id: "created-a-request",
            bookRecordId: "created-a",
            state: "created",
            linkedBookId: "created-a-book-id",
            linkedBookSlug: "created-a-book",
          }),
        ],
        ui: { actionDelayMs: 400, pipelineDelayMs: 20_000 },
      }),
    );

    await expect(page.getByTestId("create-overview-stat-requests")).toContainText(
      "2",
    );
    await expectVisibleCount(page, "create", "requests", 2);
    await expectVisibleCount(page, "create", "queue", 1);
    await expectVisibleCount(page, "create", "processing", 1);
    await expectVisibleCount(page, "create", "created", 1);
    await expect(
      row(page, "create", "created", "created-a-request").getByRole("link", {
        name: "Open",
      }),
    ).toHaveAttribute("href", "/books/created-a-book");

    await page.getByTestId("create-requests-search").fill("initial a");
    await expectVisibleCount(page, "create", "requests", 1);
    await page.getByTestId("create-requests-search").fill("");
    await openCardFilters(page, "create", "requests");
    await page.getByTestId("create-requests-category-filter").selectOption("Poetry");
    await expect(page.getByTestId("create-requests-active-filters")).toContainText(
      "Poetry",
    );
    await expectVisibleCount(page, "create", "requests", 2);

    await checkbox(page, "create", "requests", "initial-a-request").check();
    await checkbox(page, "create", "requests", "initial-b-request").check();
    await page.getByTestId("create-requests-delete-btn").click();
    await expect(page.getByTestId("create-requests-loader")).toBeVisible();
    await expect(page.getByTestId("create-requests-delete-btn")).toBeDisabled();
    await expect(checkbox(page, "create", "queue", "queued-a-request")).toBeEnabled();
    await expect(page.getByTestId("create-requests-loader")).toHaveCount(0);
    await expectVisibleCount(page, "create", "requests", 0);

    await checkbox(page, "create", "processing", "processing-a-request").check();
    await page.getByTestId("create-processing-pause-btn").click();
    await expect(page.getByTestId("create-processing-loader")).toBeVisible();
    await expect(row(page, "create", "processing", "processing-a-request")).toHaveCount(0);
    await page.goto("/on-hold");
    await expect(row(page, "on-hold", "paused", "processing-a-request")).toBeVisible();
    await expect(row(page, "on-hold", "paused", "processing-a-request")).toContainText(
      "Paused at processing",
    );

    await page.goto("/create");
    await checkbox(page, "create", "created", "created-a-request").check();
    await page.getByTestId("create-created-delete-btn").click();
    await expect(row(page, "create", "created", "created-a-request")).toHaveCount(0);
    await page.goto("/on-hold");
    await expect(row(page, "on-hold", "deleted", "created-a-request")).toBeVisible();
  });

  test("on-hold page resumes, retries, resolves duplicates, deletes, and recreates", async ({
    page,
  }) => {
    await boot(
      page,
      "/on-hold",
      baseState({
        records: [
          record({ id: "paused-book", name: "Paused Book" }),
          record({ id: "failed-book", name: "Failed Book" }),
          record({ id: "duplicate-book", name: "Duplicate Book" }),
          record({ id: "deleted-book", name: "Deleted Book" }),
          record({ id: "original-book", name: "Original Book", bookCreationState: "processing" }),
        ],
        requests: [
          request({
            id: "paused-request",
            bookRecordId: "paused-book",
            state: "paused",
            progress: {
              savedAt: iso(20),
              checkpoint: "chapter-4",
              savedData: { chapters: 4 },
            },
          }),
          request({
            id: "failed-request",
            bookRecordId: "failed-book",
            state: "failed",
            errorMessage: "Retry threshold exceeded",
          }),
          request({
            id: "duplicate-request",
            bookRecordId: "duplicate-book",
            state: "duplicate",
            duplicateOfRequestId: "original-request",
            duplicateOfRecordId: "original-book",
          }),
          request({ id: "deleted-request", bookRecordId: "deleted-book", state: "deleted" }),
          request({ id: "original-request", bookRecordId: "original-book", state: "processing" }),
        ],
        ui: { actionDelayMs: 120, pipelineDelayMs: 20_000 },
      }),
    );

    await expect(page.getByTestId("on-hold-overview-stat-paused")).toContainText(
      "1",
    );
    await expect(page.getByTestId("on-hold-failed-table")).toContainText(
      "Error Reason",
    );
    await expect(row(page, "on-hold", "paused", "paused-request")).toContainText(
      "chapter-4",
    );
    await expect(row(page, "on-hold", "failed", "failed-request")).toContainText(
      "Retry threshold exceeded",
    );

    await checkbox(page, "on-hold", "paused", "paused-request").check();
    await page.getByTestId("on-hold-paused-resume-btn").click();
    await expect(page.getByTestId("on-hold-paused-loader")).toBeVisible();
    await expect(row(page, "on-hold", "paused", "paused-request")).toHaveCount(0);
    await page.goto("/create");
    await expect(row(page, "create", "requests", "paused-request")).toBeVisible();

    await page.goto("/on-hold");
    await checkbox(page, "on-hold", "failed", "failed-request").check();
    await page.getByTestId("on-hold-failed-retry-btn").click();
    await expect(row(page, "on-hold", "failed", "failed-request")).toHaveCount(0);
    await page.goto("/create");
    await expect(row(page, "create", "requests", "failed-request")).toBeVisible();

    await page.goto("/on-hold");
    await checkbox(page, "on-hold", "duplicate", "duplicate-request").check();
    await page.getByTestId("on-hold-duplicate-new-btn").click();
    await expect(row(page, "on-hold", "duplicate", "duplicate-request")).toHaveCount(0);
    await page.goto("/create");
    await expect(row(page, "create", "requests", "duplicate-request")).toBeVisible();

    await page.goto("/on-hold");
    await checkbox(page, "on-hold", "deleted", "deleted-request").check();
    await page.getByTestId("on-hold-deleted-create-again-btn").click();
    await expect(row(page, "on-hold", "deleted", "deleted-request")).toHaveCount(0);
    await page.goto("/create");
    await expect(row(page, "create", "requests", "deleted-request")).toBeVisible();
  });

  test("on-hold cards show only their own status records", async ({
    page,
  }) => {
    await boot(
      page,
      "/on-hold",
      baseState({
        records: [
          record({ id: "paused-only-book", name: "Paused Only" }),
          record({ id: "failed-only-book", name: "Failed Only" }),
          record({ id: "duplicate-only-book", name: "Duplicate Only" }),
          record({ id: "deleted-only-book", name: "Deleted Only" }),
        ],
        requests: [
          request({
            id: "paused-only-request",
            bookRecordId: "paused-only-book",
            state: "paused",
            progress: {
              savedAt: iso(21),
              checkpoint: "saved-chapter",
              savedData: { chapter: 7 },
            },
          }),
          request({
            id: "failed-only-request",
            bookRecordId: "failed-only-book",
            state: "failed",
            errorMessage: "Pipeline failed after retries.",
          }),
          request({
            id: "duplicate-only-request",
            bookRecordId: "duplicate-only-book",
            state: "duplicate",
            duplicateOfRequestId: "original-request",
            duplicateOfRecordId: "original-book",
          }),
          request({
            id: "deleted-only-request",
            bookRecordId: "deleted-only-book",
            state: "deleted",
          }),
        ],
        ui: {
          ...baseState().ui,
          pipelineDelayMs: 60_000,
        },
      }),
    );

    await expectVisibleCount(page, "on-hold", "paused", 1);
    await expectVisibleCount(page, "on-hold", "failed", 1);
    await expectVisibleCount(page, "on-hold", "duplicate", 1);
    await expectVisibleCount(page, "on-hold", "deleted", 1);

    await expect(row(page, "on-hold", "paused", "paused-only-request")).toBeVisible();
    await expect(row(page, "on-hold", "paused", "paused-only-request")).toContainText("Paused");
    await expect(row(page, "on-hold", "paused", "paused-only-request")).toContainText(
      "saved-chapter",
    );
    await expect(row(page, "on-hold", "paused", "failed-only-request")).toHaveCount(0);
    await expect(row(page, "on-hold", "paused", "duplicate-only-request")).toHaveCount(0);
    await expect(row(page, "on-hold", "paused", "deleted-only-request")).toHaveCount(0);

    await expect(row(page, "on-hold", "failed", "failed-only-request")).toBeVisible();
    await expect(row(page, "on-hold", "failed", "failed-only-request")).toContainText("Failed");
    await expect(row(page, "on-hold", "failed", "failed-only-request")).toContainText(
      "Pipeline failed after retries.",
    );
    await expect(row(page, "on-hold", "failed", "paused-only-request")).toHaveCount(0);
    await expect(row(page, "on-hold", "failed", "duplicate-only-request")).toHaveCount(0);
    await expect(row(page, "on-hold", "failed", "deleted-only-request")).toHaveCount(0);

    await expect(row(page, "on-hold", "duplicate", "duplicate-only-request")).toBeVisible();
    await expect(row(page, "on-hold", "duplicate", "duplicate-only-request")).toContainText(
      "Duplicate",
    );
    await expect(row(page, "on-hold", "duplicate", "paused-only-request")).toHaveCount(0);
    await expect(row(page, "on-hold", "duplicate", "failed-only-request")).toHaveCount(0);
    await expect(row(page, "on-hold", "duplicate", "deleted-only-request")).toHaveCount(0);

    await expect(row(page, "on-hold", "deleted", "deleted-only-request")).toBeVisible();
    await expect(row(page, "on-hold", "deleted", "deleted-only-request")).toContainText("Deleted");
    await expect(row(page, "on-hold", "deleted", "paused-only-request")).toHaveCount(0);
    await expect(row(page, "on-hold", "deleted", "failed-only-request")).toHaveCount(0);
    await expect(row(page, "on-hold", "deleted", "duplicate-only-request")).toHaveCount(0);
  });

  test("duplicate confirmation locks catalog rows until original request is terminal", async ({
    page,
  }) => {
    const processingApi = await boot(
      page,
      "/on-hold",
      baseState({
        records: [
          record({ id: "duplicate-book", name: "Duplicate Candidate" }),
          record({ id: "original-book", name: "Original Candidate", bookCreationState: "processing" }),
        ],
        requests: [
          request({
            id: "duplicate-request",
            bookRecordId: "duplicate-book",
            state: "duplicate",
            duplicateOfRequestId: "original-request",
            duplicateOfRecordId: "original-book",
          }),
          request({ id: "original-request", bookRecordId: "original-book", state: "processing" }),
        ],
        ui: { actionDelayMs: 80, pipelineDelayMs: 20_000 },
      }),
    );

    await checkbox(page, "on-hold", "duplicate", "duplicate-request").check();
    await page.getByTestId("on-hold-duplicate-duplicate-btn").click();
    await expect(row(page, "on-hold", "duplicate", "duplicate-request")).toContainText(
      "Confirmed duplicate",
    );
    await page.goto("/catalog");
    await expect(checkbox(page, "catalog", "records", "duplicate-book")).toBeDisabled();

    processingApi.updateRequest("original-request", { state: "failed" });
    await page.reload();
    await expect(checkbox(page, "catalog", "records", "duplicate-book")).toBeEnabled();
  });

  test("incomplete page automation, read-only records, and completed-book actions", async ({
    page,
  }) => {
    await boot(
      page,
      "/incomplete",
      baseState({
        records: [
          record({
            id: "incomplete-book",
            name: "Incomplete Book",
            category: "Incomplete",
            writer: "Missing Writer",
            wasIncomplete: true,
            willResolveToCategory: "Novel",
          }),
          record({
            id: "completed-book",
            name: "Resolved Book",
            category: "Novel",
            writer: "Done Writer",
            wasIncomplete: true,
            resolvedFromIncomplete: true,
            bookCreationState: "created",
          }),
        ],
        requests: [
          request({
            id: "completed-request",
            bookRecordId: "completed-book",
            state: "created",
          }),
        ],
        ui: { actionDelayMs: 80, pipelineDelayMs: 2_000 },
      }),
    );

    await expect(page.getByTestId("incomplete-overview-stat-incomplete")).toContainText(
      "1",
    );
    await expect(page.getByTestId("incomplete-overview-stat-resolved")).toContainText(
      "1",
    );
    await expect(row(page, "incomplete", "records", "incomplete-book")).toBeVisible();
    await expect(page.getByTestId("incomplete-records-table")).toBeVisible();
    await expect(
      page.locator('[data-testid="incomplete-records-table"] thead'),
    ).toContainText("Name");
    await expect(
      page.locator('[data-testid="incomplete-records-table"] thead'),
    ).toContainText("URL");
    await expect(
      page.locator('[data-testid="incomplete-records-table"] thead'),
    ).not.toContainText("Book");
    await expect(
      page.locator('[data-testid="incomplete-records-table"] tbody tr').first(),
    ).toContainText("https://example.test/books/reusable-systems");
    await expect(page.getByTestId("incomplete-automation-interval")).toHaveValue(
      "weekly",
    );
    await expect(page.getByTestId("incomplete-automation-time")).toHaveValue("03:00");
    await expect(page.getByTestId("incomplete-automation-status")).toHaveCount(0);
    expect(await automationControlHeights(page, "incomplete")).toEqual({
      button: 30,
      toggle: 30,
    });
    await expect(page.getByTestId("incomplete-records-select-all")).toHaveCount(0);
    await expect(
      page.getByTestId("incomplete-records-select-incomplete-book"),
    ).toHaveCount(0);
    await expect(page.getByTestId("incomplete-records-recreate-btn")).toHaveCount(0);

    await page.getByTestId("incomplete-records-search").fill("missing writer");
    await expectVisibleCount(page, "incomplete", "records", 1);
    await openCardFilters(page, "incomplete", "records");
    await page.getByTestId("incomplete-records-category-filter").selectOption("Incomplete");
    await expect(page.getByTestId("incomplete-records-active-filters")).toContainText(
      "Incomplete",
    );

    await page.getByTestId("incomplete-automation-enabled").check();
    await page.getByTestId("incomplete-automation-save-btn").click();
    await expect(page.getByTestId("incomplete-automation-status")).toContainText(
      "Saved",
    );
    await page.getByTestId("incomplete-automation-run-btn").click();
    await expect(
      page.getByTestId("incomplete-automation-run-btn"),
    ).toHaveAttribute("data-state", "syncing");
    await expect(row(page, "incomplete", "completed", "request-incomplete-book")).toBeVisible();
    await expect(page.getByTestId("incomplete-overview-stat-incomplete")).toContainText(
      "0",
    );

    await checkbox(page, "incomplete", "completed", "completed-request").check();
    await page.getByTestId("incomplete-completed-recreate-btn").click();
    await expect(page.getByTestId("incomplete-completed-loader")).toBeVisible();
    await expect(row(page, "incomplete", "completed", "completed-request")).toHaveCount(0);
    await page.goto("/create");
    await expect(row(page, "create", "requests", "completed-request")).toBeVisible();

    await page.goto("/incomplete");
    await checkbox(page, "incomplete", "completed", "request-incomplete-book").check();
    await page.getByTestId("incomplete-completed-delete-btn").click();
    await expect(page.getByTestId("incomplete-completed-loader")).toBeVisible();
    await expect(row(page, "incomplete", "completed", "request-incomplete-book")).toHaveCount(0);
    await page.goto("/on-hold");
    await expect(row(page, "on-hold", "deleted", "request-incomplete-book")).toBeVisible();
  });

  test("incomplete automation exposes resume after pausing", async ({ page }) => {
    await boot(
      page,
      "/incomplete",
      baseState({
        sync: {
          ...baseState().sync,
          status: "paused",
          runMode: SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
          fetchedCount: 6,
          progress: {
            runMode: SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            savedData: {
              runMode: SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
              nextPageIndex: 1,
              fetchedCount: 6,
            },
          },
          message: "Saved progress for 6 records before pausing.",
        },
      }),
    );

    await expect(page.getByTestId("incomplete-automation-run-btn")).toHaveAttribute(
      "data-state",
      "paused",
    );
    await expect(page.getByTestId("incomplete-automation-run-btn")).toHaveAttribute(
      "aria-label",
      "Resume incomplete catalog sync",
    );

    await page.getByTestId("incomplete-automation-run-btn").click();

    await expect(page.getByTestId("incomplete-automation-run-btn")).toHaveAttribute(
      "data-state",
      "syncing",
    );
    await expect(page.getByTestId("incomplete-automation-status")).toContainText(
      "Restarting incomplete catalog sync from the beginning.",
    );
  });

  test("notifications play sounds and profile menu mute suppresses audio while keeping toasts visible", async ({
    page,
  }) => {
    await installNotificationAudioSpy(page);
    await boot(
      page,
      "/catalog",
      baseState({
        records: [
          record({ id: "sound-record", name: "Sound Record" }),
          record({ id: "failed-record", name: "Failed Record" }),
        ],
        requests: [
          request({
            id: "failed-request",
            bookRecordId: "failed-record",
            state: "failed",
            errorMessage: "Retry threshold exceeded",
          }),
        ],
        ui: {
          ...baseState().ui,
          pipelineDelayMs: 20_000,
        },
      }),
    );

    await checkbox(page, "catalog", "records", "sound-record").check();
    await page.getByTestId("catalog-records-create-btn").click();
    await expect(
      page.getByRole("status").filter({ hasText: "Requests created" }),
    ).toBeVisible();
    await expect(page.getByTestId("notification-mute-toggle")).toHaveCount(0);
    const initialSoundCount = await notificationSoundEventCount(page);
    expect(initialSoundCount).toBeGreaterThan(0);

    await page.getByTestId("profile-menu-trigger").click();
    await page.getByTestId("profile-alerts-toggle").click();
    await expect(page.getByTestId("profile-alerts-toggle")).not.toBeChecked();

    await page.getByTestId("catalog-automation-enabled").check();
    await page.getByTestId("catalog-automation-save-btn").click();
    await expect(
      page.getByRole("status").filter({ hasText: "Catalog automation saved" }),
    ).toBeVisible();
    await expect(await notificationSoundEventCount(page)).toBe(initialSoundCount);
  });

  test("card actions stay isolated while separate cards are busy", async ({
    page,
  }) => {
    await boot(
      page,
      "/on-hold",
      baseState({
        records: [
          record({ id: "failed-book", name: "Slow Failed" }),
          record({ id: "duplicate-book", name: "Fast Duplicate" }),
        ],
        requests: [
          request({
            id: "failed-request",
            bookRecordId: "failed-book",
            state: "failed",
            errorMessage: "Network retries exhausted",
          }),
          request({
            id: "duplicate-request",
            bookRecordId: "duplicate-book",
            state: "duplicate",
          }),
        ],
        ui: { actionDelayMs: 700, pipelineDelayMs: 2_000 },
      }),
    );

    await checkbox(page, "on-hold", "failed", "failed-request").check();
    await page.getByTestId("on-hold-failed-retry-btn").click();
    await expect(page.getByTestId("on-hold-failed-loader")).toBeVisible();
    await expect(checkbox(page, "on-hold", "failed", "failed-request")).toBeDisabled();
    await expect(checkbox(page, "on-hold", "duplicate", "duplicate-request")).toBeEnabled();

    await checkbox(page, "on-hold", "duplicate", "duplicate-request").check();
    await page.getByTestId("on-hold-duplicate-new-btn").click();
    await expect(page.getByTestId("on-hold-duplicate-loader")).toBeVisible();
    await expect(page.getByTestId("on-hold-failed-loader")).toBeVisible();
    await expect(row(page, "on-hold", "duplicate", "duplicate-request")).toHaveCount(0);
    await expect(row(page, "on-hold", "failed", "failed-request")).toHaveCount(0);
  });

  test("processing notifications surface action completion, duplicate detection, and stale failures", async ({
    page,
  }) => {
    const processingApi = await boot(
      page,
      "/catalog",
      baseState({
        records: [
          record({ id: "toast-record", name: "Toast Record" }),
          record({ id: "duplicate-record", name: "Duplicate Record" }),
          record({ id: "failed-record", name: "Failed Record" }),
          record({ id: "stale-record", name: "Stale Record" }),
        ],
        requests: [
          request({
            id: "duplicate-processing-request",
            bookRecordId: "duplicate-record",
            state: "initial",
            updatedAt: iso(15),
            pipelineOutcome: "duplicate",
          }),
          request({
            id: "failed-processing-request",
            bookRecordId: "failed-record",
            state: "processing",
            updatedAt: iso(39),
            pipelineOutcome: "failed",
          }),
          request({
            id: "stale-processing-request",
            bookRecordId: "stale-record",
            state: "processing",
            updatedAt: iso(5),
          }),
        ],
        ui: {
          ...baseState().ui,
          pipelineDelayMs: 120,
        },
      }),
    );

    processingApi.setNowIso(iso(40));

    await checkbox(page, "catalog", "records", "toast-record").check();
    await page.getByTestId("catalog-records-create-btn").click();
    await expect(
      page.getByRole("status").filter({ hasText: "Requests created" }),
    ).toBeVisible();

    await page.goto("/on-hold");
    await expect(
      row(page, "on-hold", "duplicate", "duplicate-processing-request"),
    ).toBeVisible();
    await expect(
      row(page, "on-hold", "failed", "failed-processing-request"),
    ).toContainText("Pipeline failed after retries.");
    await expect(
      row(page, "on-hold", "failed", "stale-processing-request"),
    ).toContainText("Processing exceeded 20 minutes without completing.");
  });
});
