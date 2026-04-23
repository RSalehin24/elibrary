import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiFetch } from "../../api/client";
import BookRouteLink from "../../components/BookRouteLink";
import LoadingSpinner from "../../components/LoadingSpinner";
import {
  ProcessingCountSkeleton,
  ProcessingValueSkeleton,
} from "../../components/ProcessingCardSkeleton";
import {
  countActiveFilters,
  renderField,
} from "../../components/catalog-toolbar/fields.jsx";
import {
  FilterIcon,
  SearchIcon,
} from "../../components/catalog-toolbar/icons.jsx";
import { useBookProcessing } from "./BookProcessingStore";
import { REQUEST_STATE_LABELS } from "./types";

const SEARCH_PLACEHOLDER =
  "Search name, URL, category, writer, translator, or publisher";
const PROCESSING_TABLE_BATCH_SIZE = 60;
const PROCESSING_TABLE_PREFETCH_TRIGGER = 30;
const PROCESSING_CARD_VISIBILITY_ROOT_MARGIN = "300px 0px";
const SYNC_RUN_MODE_MANUAL = "manual";
const SYNC_RUN_MODE_CATALOG_AUTOMATION = "catalog_automation";
const SYNC_RUN_MODE_INCOMPLETE_AUTOMATION = "incomplete_automation";
const CATALOG_SYNC_PHASE = "sync";
const CATALOG_REQUEST_CREATION_PHASE = "request_creation";
const CATALOG_PHASE_STATUS_NOT_STARTED = "not_started";
const CATALOG_PHASE_STATUS_RUNNING = "running";
const CATALOG_PHASE_STATUS_PAUSING = "pausing";
const CATALOG_PHASE_STATUS_PAUSED = "paused";
const CATALOG_PHASE_STATUS_COMPLETED = "completed";
const OPTIMISTIC_SYNC_MIN_MS = 2_000;
const OPTIMISTIC_SYNC_MAX_MS = 4_000;
const INCOMPLETE_CATEGORY_KEYWORDS = [
  "incomplete",
  "unfinished",
  "অসম্পূর্ণ",
  "অসম্পূর্ণ বই",
];
const DEFAULT_SYNC_CARD = {
  status: "idle",
  runMode: SYNC_RUN_MODE_MANUAL,
  message: "Ready to sync.",
};
const DEFAULT_AUTOMATION_CARD = {
  enabled: false,
  interval: "weekly",
  time: "03:00",
  saved: false,
  lastRunAt: null,
  statusMessage: "",
};

function formatDate(value) {
  if (!value) {
    return "Never";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function splitSyncMessage(message) {
  const trimmed = String(message || "").trim();
  if (!trimmed) {
    return [];
  }

  const parts = trimmed.match(/^(.+?[.!?])\s+(.+)$/);
  if (!parts) {
    return [trimmed];
  }

  return [parts[1], parts[2]];
}

function catalogRecordCountMessage(recordCount) {
  const total = Number.isFinite(recordCount) ? recordCount : 0;
  return `Catalog now has ${total} ${total === 1 ? "book record" : "book records"}.`;
}

function processingStreamStatusMessage(streamMode) {
  if (streamMode === "reconnecting") {
    return "Live updates reconnecting. Refresh checks continue every 15 seconds.";
  }
  if (streamMode === "unsupported") {
    return "Live updates are unavailable in this browser.";
  }
  return "";
}

function normalizeCatalogCountMessage(message, recordCount) {
  const trimmed = String(message || "").trim();
  if (!trimmed || !Number.isFinite(recordCount)) {
    return trimmed;
  }
  return trimmed.replace(
    /Catalog now has \d+ book records?\./g,
    catalogRecordCountMessage(recordCount),
  );
}

function catalogRuntimePhase(sync) {
  return sync?.phase || sync?.progress?.phase || CATALOG_SYNC_PHASE;
}

function catalogPhaseState(sync, phase) {
  const explicit =
    sync?.progress?.phaseStates &&
    typeof sync.progress.phaseStates[phase] === "object"
      ? sync.progress.phaseStates[phase]
      : null;
  if (explicit) {
    return explicit;
  }
  return null;
}

function catalogPhaseStatus(sync, phase) {
  const explicitState = catalogPhaseState(sync, phase);
  if (explicitState?.status) {
    return explicitState.status;
  }
  const syncPhase = catalogRuntimePhase(sync);
  const runtimeStatus = sync?.status || "idle";
  const explicit = sync?.progress?.phaseStatuses?.[phase];
  if (explicit) {
    if (phase === syncPhase) {
      if (runtimeStatus === "pausing" && explicit === CATALOG_PHASE_STATUS_RUNNING) {
        return CATALOG_PHASE_STATUS_PAUSING;
      }
      if (
        runtimeStatus === "paused" &&
        (explicit === CATALOG_PHASE_STATUS_RUNNING ||
          explicit === CATALOG_PHASE_STATUS_PAUSING)
      ) {
        return CATALOG_PHASE_STATUS_PAUSED;
      }
    }
    return explicit;
  }
  const savedData = sync?.progress?.savedData;
  if (phase === CATALOG_SYNC_PHASE) {
    if (syncPhase === CATALOG_REQUEST_CREATION_PHASE) {
      return CATALOG_PHASE_STATUS_COMPLETED;
    }
    if (runtimeStatus === "paused") {
      return CATALOG_PHASE_STATUS_PAUSED;
    }
    if (runtimeStatus === "pausing") {
      return CATALOG_PHASE_STATUS_PAUSING;
    }
    if (runtimeStatus === "syncing") {
      return CATALOG_PHASE_STATUS_RUNNING;
    }
    return savedData ? CATALOG_PHASE_STATUS_COMPLETED : CATALOG_PHASE_STATUS_NOT_STARTED;
  }
  if (phase === CATALOG_REQUEST_CREATION_PHASE) {
    if (syncPhase === CATALOG_REQUEST_CREATION_PHASE) {
      if (runtimeStatus === "paused") {
        return CATALOG_PHASE_STATUS_PAUSED;
      }
      if (runtimeStatus === "pausing") {
        return CATALOG_PHASE_STATUS_PAUSING;
      }
      if (runtimeStatus === "syncing") {
        return CATALOG_PHASE_STATUS_RUNNING;
      }
    }
    return CATALOG_PHASE_STATUS_NOT_STARTED;
  }
  return CATALOG_PHASE_STATUS_NOT_STARTED;
}

function catalogPhaseIsActive(status) {
  return (
    status === CATALOG_PHASE_STATUS_RUNNING ||
    status === CATALOG_PHASE_STATUS_PAUSING
  );
}

function catalogPhaseOwner(sync, phase) {
  const explicitState = catalogPhaseState(sync, phase);
  if (explicitState?.owner) {
    return explicitState.owner;
  }
  const status = catalogPhaseStatus(sync, phase);
  if (status === CATALOG_PHASE_STATUS_NOT_STARTED) {
    return "";
  }
  if (phase === CATALOG_REQUEST_CREATION_PHASE) {
    return SYNC_RUN_MODE_CATALOG_AUTOMATION;
  }
  const savedDataRunMode = sync?.progress?.savedData?.runMode;
  return savedDataRunMode || sync?.runMode || "";
}

function catalogActivePhase(sync) {
  const requestCreationStatus = catalogPhaseStatus(
    sync,
    CATALOG_REQUEST_CREATION_PHASE,
  );
  if (catalogPhaseIsActive(requestCreationStatus)) {
    return CATALOG_REQUEST_CREATION_PHASE;
  }
  const syncStatus = catalogPhaseStatus(sync, CATALOG_SYNC_PHASE);
  if (catalogPhaseIsActive(syncStatus)) {
    return CATALOG_SYNC_PHASE;
  }
  const runtimeStatus = sync?.status || "idle";
  return runtimeStatus === "syncing" || runtimeStatus === "pausing"
    ? catalogRuntimePhase(sync)
    : "";
}

function requestDetails(request) {
  if (!request) {
    return "";
  }
  const checkpoint =
    request.progress?.checkpoint || request.progressCheckpoint || "";
  const savedAt = request.progress?.savedAt || request.progressSavedAt || "";
  if (checkpoint) {
    return savedAt ? `${checkpoint} (${formatDate(savedAt)})` : checkpoint;
  }
  if (request.errorMessage) {
    return request.errorMessage;
  }
  if (request.duplicateConfirmed) {
    return "Confirmed duplicate";
  }
  if (request.isConfirmedNotDuplicate) {
    return "Confirmed new";
  }
  if (request.isResumed) {
    return "Resumed from saved progress";
  }
  return "";
}

function decodeUrlForDisplay(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  try {
    return decodeURIComponent(rawValue);
  } catch {
    return rawValue;
  }
}

function OverviewStat({ testId, label, value, loading = false }) {
  return (
    <div className="processing-summary-stat" data-testid={testId}>
      <span>{label}</span>
      <strong>{loading ? <ProcessingValueSkeleton /> : value}</strong>
    </div>
  );
}

function ProcessingStatusSkeleton({ lines = 1, variant = "automation" }) {
  return (
    <span
      className={`processing-status-skeleton processing-status-skeleton--${variant}`}
      aria-hidden="true"
    >
      <span className="processing-status-line-skeleton processing-status-line-skeleton--wide" />
      {lines > 1 ? (
        <span className="processing-status-line-skeleton processing-status-line-skeleton--short" />
      ) : null}
    </span>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M6.5 4.5v11l8.75-5.5-8.75-5.5Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M6.25 4.75h2.75v10.5H6.25zM11 4.75h2.75v10.5H11z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M5.75 5.75h8.5v8.5h-8.5z" />
    </svg>
  );
}

function IconOnlyActionButton({
  testId,
  label,
  icon,
  state = "idle",
  disabled = false,
  onClick,
  className = "",
}) {
  const visualStateClass =
    state === "pausing"
      ? " is-pending"
      : state === "paused"
        ? " is-paused"
      : state === "running" || state === "syncing"
        ? " is-running"
        : "";

  return (
    <button
      type="button"
      className={`toolbar-icon-button toolbar-icon-button-accent is-icon-only processing-icon-button${visualStateClass}${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      data-state={state}
    >
      <span className="toolbar-icon-button-art">{icon}</span>
      <span className="toolbar-icon-button-text">{label}</span>
    </button>
  );
}

function IconOnlyActionSkeleton({ testId, label, className = "" }) {
  return (
    <button
      type="button"
      className={`toolbar-icon-button toolbar-icon-button-accent is-icon-only processing-icon-button processing-skeleton-control${
        className ? ` ${className}` : ""
      }`}
      aria-hidden="true"
      tabIndex={-1}
      data-testid={testId}
    >
      <span className="toolbar-icon-button-art" />
      <span className="toolbar-icon-button-text">{label}</span>
    </button>
  );
}

function ButtonSkeleton({ testId, label, className = "" }) {
  return (
    <button
      type="button"
      className={`primary-button processing-skeleton-control processing-skeleton-button${
        className ? ` ${className}` : ""
      }`}
      aria-hidden="true"
      tabIndex={-1}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

function SwitchSkeleton({ testId, label = "Off" }) {
  return (
    <label
      className="processing-switch processing-switch-skeleton"
      aria-hidden="true"
      data-testid={testId}
    >
      <input type="checkbox" checked={false} readOnly tabIndex={-1} />
      <span className="processing-switch-track processing-skeleton-control">
        <span className="processing-switch-state">{label}</span>
        <span className="processing-switch-thumb processing-skeleton-control" />
      </span>
    </label>
  );
}

function AutomationFieldSkeleton({ testId, label, controlClassName = "" }) {
  return (
    <label className="processing-automation-field processing-form-field-skeleton">
      <span className="processing-automation-field-label">{label}</span>
      <span
        className={`processing-automation-field-control processing-automation-field-control--skeleton processing-skeleton-control${
          controlClassName ? ` ${controlClassName}` : ""
        }`}
        aria-hidden="true"
        data-testid={testId}
      />
    </label>
  );
}

function PageFrame({ pageId, title, children }) {
  const { streamMode } = useBookProcessing();
  const streamStatusMessage = processingStreamStatusMessage(streamMode);

  return (
    <div className="processing-page page-stack" data-testid={`${pageId}-page`}>
      <section className="detail-card processing-page-header">
        <div className="panel-header">
          <div>
            <h1>{title}</h1>
            {streamStatusMessage ? (
              <p
                className="processing-table-muted"
                data-testid={`${pageId}-stream-status`}
              >
                {streamStatusMessage}
              </p>
            ) : null}
          </div>
        </div>
      </section>
      {children}
    </div>
  );
}

function OverviewPanel({ pageId, stats, loading = false }) {
  return (
    <section className="detail-card processing-summary-card">
      <div className="processing-summary-bar">
        {stats.map((stat) => (
          <OverviewStat
            key={stat.id}
            testId={`${pageId}-overview-stat-${stat.id}`}
            label={stat.label}
            value={stat.value}
            loading={loading}
          />
        ))}
      </div>
    </section>
  );
}

function ActiveFilters({ pageId, cardId, categoryFilter, statusFilter }) {
  const labels = [];
  if (categoryFilter) {
    labels.push(categoryFilter);
  }
  if (statusFilter) {
    labels.push(REQUEST_STATE_LABELS[statusFilter] || statusFilter);
  }

  if (!labels.length) {
    return null;
  }

  return (
    <div
      className="processing-active-filters"
      data-testid={`${pageId}-${cardId}-active-filters`}
    >
      {labels.map((label) => (
        <span key={label} className="processing-active-filter-chip">
          {label}
        </span>
      ))}
    </div>
  );
}

function ContributorsCell({ row }) {
  const items = [
    { label: "Writer", value: row.writer },
    { label: "Translator", value: row.translator },
    { label: "Publisher", value: row.publisher },
  ].filter((item) => item.value);

  if (!items.length) {
    return <span className="processing-table-muted">-</span>;
  }

  return (
    <div className="processing-contributors-list">
      {items.map((item) => (
        <div key={item.label} className="processing-contributor-entry">
          <span className="processing-contributor-label">{item.label}</span>
          <span>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function processingCardFromState(cardKey, statePayload) {
  const sharedCard = statePayload?.cards?.[cardKey];
  if (sharedCard) {
    return sharedCard;
  }

  const summary = statePayload?.summary || {};
  const syncStates = statePayload?.syncStates || {};
  const catalogSync = syncStates.catalog || statePayload?.sync || null;
  const incompleteSync = syncStates.incomplete || statePayload?.sync || null;
  const automation = statePayload?.automation || {};

  const cards = {
    "catalog-overview": {
      card: "catalog-overview",
      summary: summary.catalog || {},
    },
    "catalog-sync": {
      card: "catalog-sync",
      sync: catalogSync || DEFAULT_SYNC_CARD,
    },
    "catalog-automation": {
      card: "catalog-automation",
      sync: catalogSync || DEFAULT_SYNC_CARD,
      automation: automation.catalog || DEFAULT_AUTOMATION_CARD,
    },
    "create-overview": {
      card: "create-overview",
      summary: summary.create || {},
    },
    "on-hold-overview": {
      card: "on-hold-overview",
      summary: summary.onHold || {},
    },
    "incomplete-overview": {
      card: "incomplete-overview",
      summary: summary.incomplete || {},
    },
    "incomplete-automation": {
      card: "incomplete-automation",
      sync: incompleteSync || DEFAULT_SYNC_CARD,
      automation: automation.incomplete || DEFAULT_AUTOMATION_CARD,
    },
  };

  return cards[cardKey] || null;
}

function processingCardCountFromState(cardKey, statePayload) {
  const summary = statePayload?.summary || {};
  const catalogSummary = summary.catalog || {};
  const createSummary = summary.create || {};
  const onHoldSummary = summary.onHold || {};
  const incompleteSummary = summary.incomplete || {};

  const counts = {
    "catalog-records": catalogSummary.records,
    "create-requests": createSummary.requests,
    "create-queue": createSummary.queue,
    "create-processing": createSummary.processing,
    "create-created": createSummary.created,
    "on-hold-paused": onHoldSummary.paused,
    "on-hold-failed": onHoldSummary.failed,
    "on-hold-duplicate": onHoldSummary.duplicate,
    "on-hold-deleted": onHoldSummary.deleted,
    "incomplete-records": incompleteSummary.incomplete,
    "incomplete-completed": incompleteSummary.resolved,
  };

  return Number.isFinite(counts[cardKey]) ? counts[cardKey] : null;
}

function normalizeSortValue(value) {
  return String(value || "").trim().toLowerCase();
}

function categoryIsIncomplete(value) {
  const normalizedValue = normalizeSortValue(value);
  return INCOMPLETE_CATEGORY_KEYWORDS.some((keyword) =>
    normalizedValue.includes(normalizeSortValue(keyword)),
  );
}

function sortedUniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    normalizeSortValue(left).localeCompare(normalizeSortValue(right)),
  );
}

function compareRequestDates(left, right) {
  const rightUpdated = Date.parse(right?.updatedAt || "") || 0;
  const leftUpdated = Date.parse(left?.updatedAt || "") || 0;
  if (rightUpdated !== leftUpdated) {
    return rightUpdated - leftUpdated;
  }

  const rightCreated = Date.parse(right?.createdAt || "") || 0;
  const leftCreated = Date.parse(left?.createdAt || "") || 0;
  if (rightCreated !== leftCreated) {
    return rightCreated - leftCreated;
  }

  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function latestRequestByRecordId(requests) {
  const nextMap = new Map();
  const sortedRequests = [...requests].sort(compareRequestDates);

  sortedRequests.forEach((request) => {
    if (!nextMap.has(request.bookRecordId)) {
      nextMap.set(request.bookRecordId, request);
    }
  });

  return nextMap;
}

function requestBlocksSelection(request) {
  return request && !["failed", "deleted"].includes(request.state);
}

function recordSelectable(record, requests, latestRequests) {
  const recordRequests = requests.filter(
    (request) => request.bookRecordId === record.id,
  );
  const confirmedDuplicate = recordRequests.find(
    (request) => request.state === "duplicate" && request.duplicateConfirmed,
  );
  if (confirmedDuplicate) {
    const original = requests.find(
      (request) => request.id === confirmedDuplicate.duplicateOfRequestId,
    );
    return !original || ["failed", "deleted"].includes(original.state);
  }

  if (recordRequests.some(requestBlocksSelection)) {
    return false;
  }

  if (typeof record.selectable === "boolean") {
    return record.selectable;
  }

  const latestRequest = latestRequests.get(record.id);
  return !requestBlocksSelection(latestRequest);
}

function rowFromRecord(record, latestRequest, requests, latestRequests) {
  return {
    id: record.id,
    recordId: record.id,
    requestId: latestRequest?.id || record.latestRequestId || null,
    title: record.name,
    url: record.url,
    displayUrl: record.displayUrl || decodeUrlForDisplay(record.url),
    displayPath: record.displayPath || "",
    category: record.category,
    writer: record.writer,
    translator: record.translator,
    publisher: record.publisher,
    status: latestRequest?.state || record.bookCreationState || "not_created",
    updatedAt: latestRequest?.updatedAt || record.updatedAt,
    selectable: recordSelectable(record, requests, latestRequests),
    progressCheckpoint: latestRequest?.progress?.checkpoint || "",
    progressSavedAt: latestRequest?.progress?.savedAt || "",
    errorMessage: latestRequest?.errorMessage || "",
    isResumed: Boolean(latestRequest?.isResumed),
    isConfirmedNotDuplicate: Boolean(latestRequest?.isConfirmedNotDuplicate),
    linkedBookId: latestRequest?.linkedBookId || record.linkedBookId || null,
    linkedBookSlug: latestRequest?.linkedBookSlug || record.linkedBookSlug || null,
    duplicateOfRequestId: latestRequest?.duplicateOfRequestId || null,
    duplicateOfRecordId:
      latestRequest?.duplicateOfRecordId || record.duplicateOfRecordId || null,
    duplicateConfirmed: Boolean(latestRequest?.duplicateConfirmed),
  };
}

function rowFromRequest(request, record, requests, latestRequests) {
  if (!record) {
    return null;
  }

  const baseRow = rowFromRecord(record, request, requests, latestRequests);
  return {
    ...baseRow,
    id: request.id,
    requestId: request.id,
    status: request.state,
    updatedAt: request.updatedAt,
    selectable: true,
    progressCheckpoint: request.progress?.checkpoint || "",
    progressSavedAt: request.progress?.savedAt || "",
    errorMessage: request.errorMessage || "",
    isResumed: Boolean(request.isResumed),
    isConfirmedNotDuplicate: Boolean(request.isConfirmedNotDuplicate),
    linkedBookId: request.linkedBookId || record.linkedBookId || null,
    linkedBookSlug: request.linkedBookSlug || record.linkedBookSlug || null,
    duplicateOfRequestId: request.duplicateOfRequestId || null,
    duplicateOfRecordId: request.duplicateOfRecordId || record.duplicateOfRecordId || null,
    duplicateConfirmed: Boolean(request.duplicateConfirmed),
  };
}

function tableRowsForCard(cardKey, records, requests) {
  const latestRequests = latestRequestByRecordId(requests);
  const recordsById = new Map(records.map((record) => [record.id, record]));

  if (cardKey === "catalog-records") {
    return [...records]
      .map((record) =>
        rowFromRecord(record, latestRequests.get(record.id), requests, latestRequests),
      )
      .sort((left, right) => {
        const leftPriority = left.status === "not_created" ? 0 : 1;
        const rightPriority = right.status === "not_created" ? 0 : 1;
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }

        const titleComparison = normalizeSortValue(left.title).localeCompare(
          normalizeSortValue(right.title),
        );
        if (titleComparison !== 0) {
          return titleComparison;
        }

        return String(left.id || "").localeCompare(String(right.id || ""));
      });
  }

  const requestStateMap = {
    "create-requests": ["initial"],
    "create-queue": ["queued"],
    "create-processing": ["processing"],
    "create-created": ["created"],
    "on-hold-paused": ["paused"],
    "on-hold-failed": ["failed"],
    "on-hold-duplicate": ["duplicate"],
    "on-hold-deleted": ["deleted"],
  };

  if (requestStateMap[cardKey]) {
    return [...requests]
      .filter((request) => requestStateMap[cardKey].includes(request.state))
      .sort(compareRequestDates)
      .map((request) =>
        rowFromRequest(
          request,
          recordsById.get(request.bookRecordId),
          requests,
          latestRequests,
        ),
      )
      .filter(Boolean);
  }

  if (cardKey === "incomplete-records") {
    return [...records]
      .filter(
        (record) =>
          (record.wasIncomplete || categoryIsIncomplete(record.category)) &&
          !record.resolvedFromIncomplete,
      )
      .map((record) => ({
        ...rowFromRecord(
          record,
          latestRequests.get(record.id),
          requests,
          latestRequests,
        ),
        selectable: false,
      }));
  }

  if (cardKey === "incomplete-completed") {
    return [...requests]
      .filter((request) => request.state === "created")
      .sort(compareRequestDates)
      .map((request) =>
        rowFromRequest(
          request,
          recordsById.get(request.bookRecordId),
          requests,
          latestRequests,
        ),
      )
      .filter((row) => {
        const record = recordsById.get(row.recordId);
        return Boolean(record?.wasIncomplete && record?.resolvedFromIncomplete);
      });
  }

  return [];
}

function filterTableRows(rows, filters) {
  const normalizedQuery = normalizeSortValue(filters.q);

  return rows.filter((row) => {
    const searchText = normalizeSortValue(
      [
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
        .join(" "),
    );

    if (normalizedQuery && !searchText.includes(normalizedQuery)) {
      return false;
    }
    if (filters.category && row.category !== filters.category) {
      return false;
    }
    if (filters.status && row.status !== filters.status) {
      return false;
    }
    return true;
  });
}

function processingCardPath(cardKey) {
  const search = new URLSearchParams({ card: cardKey });
  return `/processing/card/?${search.toString()}`;
}

function processingTablePath(cardKey, filters, offset, limit, includeFacets = true) {
  const search = new URLSearchParams({
    card: cardKey,
    offset: String(offset),
    limit: String(limit),
    includeFacets: includeFacets ? "1" : "0",
  });
  if (filters.q) {
    search.set("q", filters.q);
  }
  if (filters.category) {
    search.set("category", filters.category);
  }
  if (filters.status) {
    search.set("status", filters.status);
  }
  return `/processing/table/?${search.toString()}`;
}

function useProcessingCardData({ cardKey, enabled }) {
  const {
    getDomainVersion,
    isSharedProcessingCard,
    processingState,
    processingStateLoaded,
    processingStateInitialLoading,
    processingStateRefreshing,
    processingStateError,
  } = useBookProcessing();
  const usesSharedState = enabled && isSharedProcessingCard(cardKey);
  const latestKnownVersion = getDomainVersion(cardKey);
  const requestIdRef = useRef(0);
  const loadedVersionRef = useRef(latestKnownVersion);
  const [cardState, setCardState] = useState({
    data: null,
    loadedOnce: false,
    initialLoading: false,
    refreshing: false,
    error: "",
  });
  const sharedCardData = useMemo(
    () =>
      usesSharedState
        ? processingCardFromState(cardKey, processingState)
        : null,
    [cardKey, processingState, usesSharedState],
  );

  const loadCard = useCallback(() => {
    if (!enabled || usesSharedState) {
      setCardState({
        data: null,
        loadedOnce: false,
        initialLoading: false,
        refreshing: false,
        error: "",
      });
      return Promise.resolve(null);
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setCardState((current) => ({
      ...current,
      initialLoading: !current.loadedOnce,
      refreshing: current.loadedOnce,
      error: "",
    }));

    return apiFetch(processingCardPath(cardKey), { cache: "no-store" })
      .then((payload) => {
        if (requestIdRef.current !== requestId) {
          return payload;
        }
        setCardState({
          data: payload,
          loadedOnce: true,
          initialLoading: false,
          refreshing: false,
          error: "",
        });
        return payload;
      })
      .catch((loadError) => {
        if (requestIdRef.current !== requestId) {
          return null;
        }
        setCardState((current) => ({
          ...current,
          loadedOnce: true,
          initialLoading: false,
          refreshing: false,
          error: loadError.message || "Unable to load processing card.",
        }));
        return null;
      });
  }, [cardKey, enabled, usesSharedState]);

  useEffect(() => {
    if (usesSharedState) {
      return undefined;
    }
    loadCard();
    return undefined;
  }, [loadCard, usesSharedState]);

  useEffect(() => {
    if (
      usesSharedState ||
      !enabled ||
      !["syncing", "pausing"].includes(cardState.data?.sync?.status || "")
    ) {
      return undefined;
    }

    const timerId = window.setInterval(() => {
      loadCard();
    }, 2000);
    return () => {
      window.clearInterval(timerId);
    };
  }, [cardState.data?.sync?.status, enabled, loadCard, usesSharedState]);

  useEffect(() => {
    if (usesSharedState || !enabled || !cardState.loadedOnce) {
      loadedVersionRef.current = latestKnownVersion;
      return undefined;
    }
    if (latestKnownVersion <= loadedVersionRef.current) {
      return undefined;
    }
    loadedVersionRef.current = latestKnownVersion;
    loadCard();
    return undefined;
  }, [cardState.loadedOnce, enabled, latestKnownVersion, loadCard, usesSharedState]);

  if (usesSharedState) {
    return {
      data: sharedCardData,
      loadedOnce: enabled ? processingStateLoaded : false,
      initialLoading: Boolean(enabled && processingStateInitialLoading),
      refreshing: Boolean(enabled && processingStateRefreshing),
      error: enabled ? processingStateError : "",
    };
  }

  return {
    data: cardState.data,
    loadedOnce: enabled ? cardState.loadedOnce : false,
    initialLoading: Boolean(enabled && cardState.initialLoading),
    refreshing: Boolean(enabled && cardState.refreshing),
    error: enabled ? cardState.error : "",
  };
}

function TableSkeletonRows({
  pageId,
  cardId,
  showSelectionColumn,
  splitBookColumn,
  showDetailsColumn = true,
  showActionColumn = false,
  count = 5,
  incremental = false,
}) {
  return Array.from({ length: count }, (_, index) => (
    <tr
      key={`${incremental ? "more" : "initial"}-skeleton-${index}`}
      className={`processing-skeleton-row processing-table-skeleton-row${
        splitBookColumn ? " processing-skeleton-row--split" : ""
      }`}
      data-testid={
        index === 0
          ? `${pageId}-${cardId}-${incremental ? "load-more" : "table"}-skeleton`
          : undefined
      }
      aria-hidden="true"
    >
      {showSelectionColumn ? (
        <td className="processing-col-select">
          <span className="processing-checkbox-skeleton processing-skeleton-control" />
        </td>
      ) : null}
      {splitBookColumn ? (
        <>
          <td className="processing-col-name">
            <div className="processing-table-primary">
              <strong>
                <span className="skeleton-line skeleton-line-xl" />
              </strong>
            </div>
          </td>
          <td className="processing-col-url">
            <span className="processing-table-link">
              <span className="processing-table-skeleton-stack">
                <span className="skeleton-line skeleton-line-lg" />
                <span className="skeleton-line skeleton-line-sm" />
              </span>
            </span>
          </td>
        </>
      ) : (
        <td className="processing-col-book-wide">
          <div className="processing-table-skeleton-stack">
            <span className="skeleton-line skeleton-line-xl" />
            <span className="skeleton-line skeleton-line-sm" />
          </div>
        </td>
      )}
      <td className="processing-col-contributors-wide">
        <div
          className="processing-contributors-list"
          style={splitBookColumn ? { minHeight: "81px" } : undefined}
        >
          <div className="processing-contributor-entry">
            <span className="processing-contributor-label">
              <span className="skeleton-line skeleton-line-sm" />
            </span>
            <span className="processing-table-muted">
              <span className="skeleton-line skeleton-line-sm" />
            </span>
          </div>
          <div className="processing-contributor-entry">
            <span className="processing-contributor-label">
              <span className="skeleton-line skeleton-line-sm" />
            </span>
            <span className="processing-table-muted">
              <span className="skeleton-line skeleton-line-sm" />
            </span>
          </div>
        </div>
      </td>
      <td className="processing-col-category">
        <span className="skeleton-line skeleton-line-sm" />
      </td>
      <td className="processing-col-status">
        <span className="skeleton-line skeleton-line-sm" />
      </td>
      {showDetailsColumn ? (
        <td className="processing-col-details">
          <span className="skeleton-line skeleton-line-lg" />
        </td>
      ) : null}
      <td className="processing-col-updated">
        <span className="skeleton-line skeleton-line-sm" />
      </td>
      {showActionColumn ? (
        <td className="processing-col-action">
          <span className="ghost-button skeleton-button skeleton-button-sm" />
        </td>
      ) : null}
    </tr>
  ));
}

function useProcessingTableData({ cardKey, filters, enabled }) {
  const { getDomainVersion, processingState, processingStateLoaded } =
    useBookProcessing();
  const visibilityObserverRef = useRef(null);
  const fetchInFlightRequestIdRef = useRef(0);
  const [visibilityNode, setVisibilityNode] = useState(null);
  const tableShellRef = useRef(null);
  const observerRef = useRef(null);
  const loadMoreTimerRef = useRef(null);
  const requestIdRef = useRef(0);
  const latestKnownVersion = getDomainVersion(cardKey);
  const filtersActive = Boolean(filters.q || filters.category || filters.status);
  const sharedCount = filtersActive
    ? null
    : processingCardCountFromState(cardKey, processingState);
  const filterSignature = `${filters.q}::${filters.category}::${filters.status}`;
  const [isVisible, setIsVisible] = useState(
    typeof window === "undefined" || typeof IntersectionObserver === "undefined",
  );
  const [tableState, setTableState] = useState({
    rows: [],
    totalCount: 0,
    categoryOptions: [],
    statusOptions: [],
    hasMore: false,
    latestKnownVersion,
    loadedVersion: 0,
    loadedOnce: false,
    initialLoading: false,
    refreshing: false,
    error: "",
  });
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchTable = useCallback(
    async ({
      offset = 0,
      limit = PROCESSING_TABLE_BATCH_SIZE,
      append = false,
      includeFacets = true,
      hardReload = false,
    }) => {
      if (!enabled) {
        return null;
      }

      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      fetchInFlightRequestIdRef.current = requestId;
      setTableState((current) => ({
        ...current,
        latestKnownVersion: Math.max(current.latestKnownVersion, latestKnownVersion),
        loadedOnce: append ? current.loadedOnce : hardReload ? false : current.loadedOnce,
        initialLoading:
          !append && (!current.loadedOnce || hardReload),
        refreshing:
          !append && current.loadedOnce && !hardReload,
        error: "",
      }));

      try {
        const payload = await apiFetch(
          processingTablePath(cardKey, filters, offset, limit, includeFacets),
          { cache: "no-store" },
        );
        if (requestIdRef.current !== requestId) {
          return payload;
        }
        const loadedVersion = Number(payload?.version || latestKnownVersion || 0);
        setTableState((current) => ({
          rows: append ? [...current.rows, ...(payload.rows || [])] : payload.rows || [],
          totalCount:
            payload?.pagination?.totalCount ??
            payload?.totalCount ??
            current.totalCount,
          categoryOptions:
            payload?.filters?.categoryOptions || current.categoryOptions,
          statusOptions:
            payload?.filters?.statusOptions || current.statusOptions,
          hasMore: Boolean(payload?.pagination?.hasMore),
          latestKnownVersion: Math.max(current.latestKnownVersion, loadedVersion),
          loadedVersion,
          loadedOnce: true,
          initialLoading: false,
          refreshing: false,
          error: "",
        }));
        return payload;
      } catch (loadError) {
        if (requestIdRef.current !== requestId) {
          return null;
        }
        setTableState((current) => ({
          ...current,
          initialLoading: false,
          refreshing: false,
          error: loadError.message || "Unable to load processing table.",
        }));
        return null;
      } finally {
        if (fetchInFlightRequestIdRef.current === requestId) {
          fetchInFlightRequestIdRef.current = 0;
        }
      }
    },
    [cardKey, enabled, filters, latestKnownVersion],
  );

  const loadMore = useCallback(() => {
    if (
      !enabled ||
      !tableState.hasMore ||
      loadingMore ||
      fetchInFlightRequestIdRef.current
    ) {
      return;
    }
    setLoadingMore(true);
    if (typeof window === "undefined") {
      fetchTable({
        offset: tableState.rows.length,
        limit: PROCESSING_TABLE_BATCH_SIZE,
        append: true,
        includeFacets: false,
      }).finally(() => setLoadingMore(false));
      return;
    }
    if (loadMoreTimerRef.current) {
      window.clearTimeout(loadMoreTimerRef.current);
    }
    loadMoreTimerRef.current = window.setTimeout(() => {
      fetchTable({
        offset: tableState.rows.length,
        limit: PROCESSING_TABLE_BATCH_SIZE,
        append: true,
        includeFacets: false,
      }).finally(() => setLoadingMore(false));
      loadMoreTimerRef.current = null;
    }, 120);
  }, [enabled, fetchTable, loadingMore, tableState.hasMore, tableState.rows.length]);

  const observeLoadTrigger = useCallback(
    (node) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      if (
        !node ||
        !enabled ||
        !tableState.loadedOnce ||
        loadingMore ||
        !tableState.hasMore ||
        fetchInFlightRequestIdRef.current
      ) {
        return;
      }

      observerRef.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            loadMore();
          }
        },
        {
          root: tableShellRef.current,
          rootMargin: "0px 0px 240px 0px",
        },
      );
      observerRef.current.observe(node);
    },
    [
      enabled,
      fetchInFlightRequestIdRef,
      loadingMore,
      loadMore,
      tableState.hasMore,
      tableState.loadedOnce,
    ],
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return undefined;
    }

    if (visibilityObserverRef.current) {
      visibilityObserverRef.current.disconnect();
      visibilityObserverRef.current = null;
    }

    if (!visibilityNode || !enabled) {
      return undefined;
    }

    visibilityObserverRef.current = new IntersectionObserver(
      (entries) => {
        if (entries.length) {
          setIsVisible(entries.some((entry) => entry.isIntersecting));
        }
      },
      {
        root: null,
        rootMargin: PROCESSING_CARD_VISIBILITY_ROOT_MARGIN,
        threshold: 0.1,
      },
    );
    visibilityObserverRef.current.observe(visibilityNode);

    return () => {
      if (visibilityObserverRef.current) {
        visibilityObserverRef.current.disconnect();
        visibilityObserverRef.current = null;
      }
    };
  }, [enabled, visibilityNode]);

  useEffect(() => {
    setLoadingMore(false);
    if (typeof window !== "undefined" && loadMoreTimerRef.current) {
      window.clearTimeout(loadMoreTimerRef.current);
      loadMoreTimerRef.current = null;
    }
    requestIdRef.current += 1;
    fetchInFlightRequestIdRef.current = 0;
    if (!enabled) {
      setTableState({
        rows: [],
        totalCount: 0,
        categoryOptions: [],
        statusOptions: [],
        hasMore: false,
        latestKnownVersion,
        loadedVersion: 0,
        loadedOnce: false,
        initialLoading: false,
        refreshing: false,
        error: "",
      });
      return undefined;
    }
    setTableState((current) => ({
      ...current,
      rows: [],
      totalCount: 0,
      categoryOptions: [],
      statusOptions: [],
      hasMore: false,
      latestKnownVersion,
      loadedVersion: 0,
      loadedOnce: false,
      initialLoading: false,
      refreshing: false,
      error: "",
    }));
    return undefined;
  }, [cardKey, enabled, filterSignature]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    setTableState((current) => ({
      ...current,
      latestKnownVersion: Math.max(current.latestKnownVersion, latestKnownVersion),
    }));
    if (
      !tableState.loadedOnce &&
      !filtersActive &&
      processingStateLoaded &&
      sharedCount === 0
    ) {
      setTableState((current) => ({
        ...current,
        rows: [],
        totalCount: 0,
        categoryOptions: [],
        statusOptions: [],
        hasMore: false,
        latestKnownVersion: Math.max(current.latestKnownVersion, latestKnownVersion),
        loadedVersion: latestKnownVersion,
        loadedOnce: true,
        initialLoading: false,
        refreshing: false,
        error: "",
      }));
      return undefined;
    }
    if (!tableState.loadedOnce) {
      if (!filtersActive && !processingStateLoaded) {
        return undefined;
      }
      if (!isVisible) {
        return undefined;
      }
      if (fetchInFlightRequestIdRef.current) {
        return undefined;
      }
      fetchTable({
        offset: 0,
        limit: PROCESSING_TABLE_BATCH_SIZE,
        includeFacets: true,
        hardReload: false,
      });
      return undefined;
    }
    if (!isVisible) {
      return undefined;
    }
    if (latestKnownVersion <= tableState.loadedVersion) {
      return undefined;
    }
    if (fetchInFlightRequestIdRef.current) {
      return undefined;
    }
    fetchTable({
      offset: 0,
      limit:
        tableState.rows.length > 0
          ? tableState.rows.length
          : PROCESSING_TABLE_BATCH_SIZE,
      includeFacets: false,
      hardReload: false,
    });
    return undefined;
  }, [
    enabled,
    fetchTable,
    filtersActive,
    isVisible,
    latestKnownVersion,
    processingStateLoaded,
    sharedCount,
    tableState.loadedOnce,
    tableState.loadedVersion,
    tableState.rows.length,
  ]);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && loadMoreTimerRef.current) {
        window.clearTimeout(loadMoreTimerRef.current);
      }
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
      if (visibilityObserverRef.current) {
        visibilityObserverRef.current.disconnect();
      }
    };
  }, []);

  return {
    rows: tableState.rows,
    totalCount: tableState.totalCount,
    categoryOptions: tableState.categoryOptions,
    statusOptions: tableState.statusOptions,
    hasMore: tableState.hasMore,
    loadedOnce: enabled ? tableState.loadedOnce : false,
    initialLoading: Boolean(enabled && tableState.initialLoading),
    loadingMore,
    refreshing: Boolean(enabled && tableState.refreshing),
    error: enabled ? tableState.error : "",
    loadMore,
    setCardVisibilityNode: setVisibilityNode,
    tableShellRef,
    observeLoadTrigger,
  };
}

function ProcessingDataCard({
  pageId,
  cardId,
  cardKey,
  title,
  actions = [],
  busy = false,
  readOnly = false,
  detailsLabel = "Details",
  showDetailsColumn = true,
  emptyLabel = "No records.",
  className = "",
  fullSpan = false,
  bookColumnMode = "combined",
  actionLabel = "Action",
  renderRowAction = null,
  countPlacement = "title",
}) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [filters, setFilters] = useState({
    q: "",
    category: "",
    status: "",
  });
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const { canLoadProcessingState, processingState } = useBookProcessing();
  const showSelectionColumn = actions.length > 0 && !readOnly;
  const splitBookColumn = bookColumnMode === "split";
  const showActionColumn = typeof renderRowAction === "function";
  const defaultFilters = useMemo(
    () => ({
      q: "",
      category: "",
      status: "",
    }),
    [],
  );
  const {
    rows,
    totalCount,
    categoryOptions,
    statusOptions,
    hasMore,
    loadedOnce,
    initialLoading,
    loadingMore,
    refreshing,
    error: tableError,
    setCardVisibilityNode,
    tableShellRef,
    observeLoadTrigger,
  } = useProcessingTableData({
    cardKey,
    filters,
    enabled: canLoadProcessingState,
  });

  const filterFields = useMemo(
    () => [
      {
        key: "category",
        label: "Category",
        testId: `${pageId}-${cardId}-category-filter`,
        type: "select",
        options: [
          { value: "", label: "All categories" },
          ...categoryOptions.map((category) => ({
            value: category,
            label: category,
          })),
        ],
      },
      {
        key: "status",
        label: "Status",
        testId: `${pageId}-${cardId}-status-filter`,
        type: "select",
        options: [
          { value: "", label: "All statuses" },
          ...statusOptions.map((status) => ({
            value: status,
            label: REQUEST_STATE_LABELS[status] || status,
          })),
        ],
      },
    ],
    [cardId, categoryOptions, pageId, statusOptions],
  );
  const activeFilterCount = useMemo(
    () => countActiveFilters(filters, filterFields, defaultFilters),
    [defaultFilters, filterFields, filters],
  );
  const sharedCount = useMemo(
    () =>
      !filters.q && !filters.category && !filters.status
        ? processingCardCountFromState(cardKey, processingState)
        : null,
    [cardKey, filters.category, filters.q, filters.status, processingState],
  );
  const visibleRows = rows;
  const visibleColumnCount =
    (showSelectionColumn ? 1 : 0) +
    (splitBookColumn ? 6 : 5) +
    (showDetailsColumn ? 1 : 0) +
    (showActionColumn ? 1 : 0);
  const showInitialTableSkeleton =
    initialLoading || (!loadedOnce && Number(sharedCount) > 0);
  const showRefreshSkeletonRows = loadingMore && visibleRows.length > 0;
  const countValue =
    loadedOnce || sharedCount === null ? totalCount : sharedCount;

  useEffect(() => {
    const visibleIds = new Set(visibleRows.map((row) => row.id));
    setSelectedIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [visibleRows]);

  const selectedRows = visibleRows.filter((row) =>
    selectedIds.includes(row.id),
  );
  const selectableRows = visibleRows.filter((row) => row.selectable);
  const allSelectableSelected =
    selectableRows.length > 0 &&
    selectableRows.every((row) => selectedIds.includes(row.id));

  function toggleRow(rowId, checked) {
    setSelectedIds((current) => {
      if (checked) {
        return current.includes(rowId) ? current : [...current, rowId];
      }
      return current.filter((id) => id !== rowId);
    });
  }

  function toggleAll(checked) {
    if (!checked) {
      setSelectedIds([]);
      return;
    }
    setSelectedIds(selectableRows.map((row) => row.id));
  }

  async function runAction(action) {
    const ids = selectedRows.map((row) => row.id);
    const result = await action.onAction(ids, selectedRows);
    if (result) {
      setSelectedIds([]);
    }
  }

  function handleQueryChange(event) {
    const nextQuery = event.target.value;
    setFilters((current) => ({ ...current, q: nextQuery }));
  }

  const bulkActions = actions.length ? (
    <div className="processing-bulk-actions">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className={
            action.danger ? "ghost-button danger-button" : "primary-button"
          }
          disabled={busy || initialLoading || selectedRows.length === 0}
          onClick={() => runAction(action)}
          data-testid={`${pageId}-${cardId}-${action.id}-btn`}
        >
          {action.label}
          {selectedRows.length ? ` (${selectedRows.length})` : ""}
        </button>
      ))}
    </div>
  ) : null;

  const countBadge = (
    <span
      className="catalog-result-count processing-card-title-count"
      aria-label={`${countValue} results`}
      data-testid={`${pageId}-${cardId}-count`}
    >
      {showInitialTableSkeleton && sharedCount === null ? (
        <ProcessingCountSkeleton />
      ) : (
        countValue
      )}
    </span>
  );

  return (
    <section
      ref={setCardVisibilityNode}
      className={`detail-card processing-card processing-list-card processing-replacement-card${
        fullSpan ? " processing-card-span-full" : ""
      }${className ? ` ${className}` : ""}`}
      data-testid={`${pageId}-${cardId}-card`}
    >
      <div className="processing-card-head processing-card-head--list">
        <div className="processing-card-head-line">
          <div className="processing-card-head-meta">
            <div className="processing-card-title-row">
              <h2>{title}</h2>
              {countPlacement === "title" ? countBadge : null}
            </div>
          </div>
          <div className="processing-card-head-search">
            <label
              className="catalog-search-field processing-search-field"
              aria-label={SEARCH_PLACEHOLDER}
            >
              <span className="catalog-search-icon">
                <SearchIcon />
              </span>
              <input
                type="search"
                value={filters.q || ""}
                onChange={handleQueryChange}
                placeholder={SEARCH_PLACEHOLDER}
                autoComplete="off"
                data-testid={`${pageId}-${cardId}-search`}
                disabled={busy}
              />
            </label>
          </div>
          <div className="processing-card-head-inline-tools">
            <button
              type="button"
              className={`catalog-filter-toggle${
                filtersExpanded ? " is-active" : ""
              }`}
              onClick={() => setFiltersExpanded((current) => !current)}
              aria-expanded={filtersExpanded}
              aria-controls={`${pageId}-${cardId}-filters`}
              disabled={busy || showInitialTableSkeleton}
            >
              <FilterIcon />
              <span>Filters</span>
              {activeFilterCount ? (
                <span className="catalog-filter-count">
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
            {countPlacement === "inline-tools" ? countBadge : null}
          </div>
          {bulkActions ? (
            <div className="processing-card-head-actions">{bulkActions}</div>
          ) : null}
        </div>
      </div>

      <div
        id={`${pageId}-${cardId}-filters`}
        className={`catalog-filter-drawer processing-filter-drawer${
          filtersExpanded ? " is-open" : ""
        }`}
        aria-hidden={filtersExpanded ? "false" : "true"}
      >
        <div className="catalog-filter-grid processing-filter-grid">
          {filterFields.map((field) => (
            <label key={field.key} className="catalog-filter-field">
              <span className="fact-label">{field.label}</span>
              {renderField(field, filters, setFilters)}
            </label>
          ))}
        </div>
      </div>
      <ActiveFilters
        pageId={pageId}
        cardId={cardId}
        categoryFilter={filters.category}
        statusFilter={filters.status}
      />

      {busy ? (
        <div className="processing-bulk-bar">
          <div className="processing-bulk-status">
            <span
              className="processing-inline-loader"
              data-testid={`${pageId}-${cardId}-loader`}
            >
              <LoadingSpinner size={14} /> Working
            </span>
          </div>
        </div>
      ) : null}

      <div
        ref={tableShellRef}
        className="processing-table-shell processing-table-shell--mobile-cards"
        aria-busy={initialLoading || loadingMore}
      >
        <table
          className="simple-table processing-table table-mobile-cards"
          data-testid={`${pageId}-${cardId}-table`}
        >
          <colgroup>
            {showSelectionColumn ? (
              <col className="processing-col-select" />
            ) : null}
            {splitBookColumn ? (
              <>
                <col className="processing-col-name" />
                <col className="processing-col-url" />
              </>
            ) : (
              <col className="processing-col-book-wide" />
            )}
            <col className="processing-col-contributors-wide" />
            <col className="processing-col-category" />
            <col className="processing-col-status" />
            {showDetailsColumn ? (
              <col className="processing-col-details" />
            ) : null}
            <col className="processing-col-updated" />
            {showActionColumn ? (
              <col className="processing-col-action" />
            ) : null}
          </colgroup>
          <thead>
            <tr>
              {showSelectionColumn ? (
                <th className="processing-col-select">
                  <input
                    type="checkbox"
                    className="processing-checkbox"
                    aria-label={`Select all ${title}`}
                    checked={allSelectableSelected}
                    disabled={
                      busy ||
                      showInitialTableSkeleton ||
                      selectableRows.length === 0
                    }
                    onChange={(event) => toggleAll(event.target.checked)}
                    data-testid={`${pageId}-${cardId}-select-all`}
                  />
                </th>
              ) : null}
              {splitBookColumn ? (
                <>
                  <th className="processing-col-name">Name</th>
                  <th className="processing-col-url">URL</th>
                </>
              ) : (
                <th className="processing-col-book-wide">Book</th>
              )}
              <th className="processing-col-contributors-wide">Credits</th>
              <th className="processing-col-category">Category</th>
              <th className="processing-col-status">Status</th>
              {showDetailsColumn ? (
                <th className="processing-col-details">{detailsLabel}</th>
              ) : null}
              <th className="processing-col-updated">Updated</th>
              {showActionColumn ? (
                <th className="processing-col-action">{actionLabel}</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {showInitialTableSkeleton ? (
              <TableSkeletonRows
                pageId={pageId}
                cardId={cardId}
                showSelectionColumn={showSelectionColumn}
                splitBookColumn={splitBookColumn}
                showDetailsColumn={showDetailsColumn}
                showActionColumn={showActionColumn}
              />
            ) : visibleRows.length ? (
              visibleRows.map((row, rowIndex) => (
                <tr
                  key={row.id}
                  data-testid={`${pageId}-${cardId}-row-${row.id}`}
                  ref={
                    hasMore &&
                    rowIndex ===
                      Math.max(
                        0,
                        visibleRows.length - PROCESSING_TABLE_PREFETCH_TRIGGER,
                      )
                      ? observeLoadTrigger
                      : undefined
                  }
                >
                  {showSelectionColumn ? (
                    <td
                      className="processing-col-select"
                      data-label="Select"
                    >
                      <input
                        type="checkbox"
                        className="processing-checkbox"
                        aria-label={`Select ${row.title}`}
                        checked={selectedIds.includes(row.id)}
                        disabled={busy || !row.selectable}
                        onChange={(event) =>
                          toggleRow(row.id, event.target.checked)
                        }
                        data-testid={`${pageId}-${cardId}-select-${row.id}`}
                      />
                    </td>
                  ) : null}
                  {splitBookColumn ? (
                    <>
                      <td
                        className="processing-col-name"
                        data-label="Name"
                      >
                        <div className="processing-table-primary">
                          <strong>{row.title}</strong>
                        </div>
                      </td>
                      <td className="processing-col-url" data-label="URL">
                        {row.url ? (
                          <span className="processing-table-link">
                            {row.displayUrl || row.url}
                          </span>
                        ) : (
                          <span className="processing-table-muted">-</span>
                        )}
                      </td>
                    </>
                  ) : (
                    <td
                      className="processing-col-book-wide"
                      data-label="Book"
                    >
                      <div className="processing-table-primary">
                        <strong>{row.title}</strong>
                        {row.url ? (
                          <span className="processing-table-secondary">
                            {row.displayUrl || row.url}
                          </span>
                        ) : null}
                      </div>
                    </td>
                  )}
                  <td
                    className="processing-col-contributors-wide"
                    data-label="Credits"
                  >
                    <ContributorsCell row={row} />
                  </td>
                  <td className="processing-col-category" data-label="Category">
                    {row.category || "Uncategorized"}
                  </td>
                  <td className="processing-col-status" data-label="Status">
                    {REQUEST_STATE_LABELS[row.status] || row.status}
                  </td>
                  {showDetailsColumn ? (
                    <td
                      className="processing-col-details"
                      data-label={detailsLabel}
                    >
                      {requestDetails(row) || "Ready"}
                    </td>
                  ) : null}
                  <td className="processing-col-updated" data-label="Updated">
                    {formatDate(row.updatedAt)}
                  </td>
                  {showActionColumn ? (
                    <td
                      className="processing-col-action"
                      data-label={actionLabel}
                    >
                      {renderRowAction(row) || (
                        <span className="processing-table-muted">-</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={visibleColumnCount} className="table-empty-cell">
                  {tableError || emptyLabel}
                </td>
              </tr>
            )}
            {showRefreshSkeletonRows ? (
              <TableSkeletonRows
                pageId={pageId}
                cardId={cardId}
                showSelectionColumn={showSelectionColumn}
                splitBookColumn={splitBookColumn}
                showDetailsColumn={showDetailsColumn}
                showActionColumn={showActionColumn}
                count={3}
                incremental
              />
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AutomationPanel({
  pageId,
  title,
  automation = DEFAULT_AUTOMATION_CARD,
  sync = DEFAULT_SYNC_CARD,
  blockedByExternalRuntime = false,
  onOptimisticSyncChange = null,
  recordCount,
  loading = false,
  saving = false,
  running = false,
  onSave,
  onRun,
  onPause,
  onResume,
  className = "",
}) {
  const [form, setForm] = useState({
    enabled: automation.enabled,
    interval: automation.interval,
    time: automation.time,
  });
  const [optimisticSync, setOptimisticSync] = useState(null);
  const [pendingNonCatalogSync, setPendingNonCatalogSync] = useState(null);
  const runMode =
    pageId === "catalog"
      ? SYNC_RUN_MODE_CATALOG_AUTOMATION
      : SYNC_RUN_MODE_INCOMPLETE_AUTOMATION;
  const effectiveSync = optimisticSync
    ? {
        ...sync,
        status: optimisticSync.status,
        message: optimisticSync.message,
        runMode,
        phase: optimisticSync.phase,
      }
    : sync;
  const displaySync =
    pageId === "catalog" || !pendingNonCatalogSync
      ? effectiveSync
      : {
          ...effectiveSync,
          status: pendingNonCatalogSync.status,
          message: pendingNonCatalogSync.message,
          runMode,
          phase: pendingNonCatalogSync.phase,
        };
  const syncPhaseStatus =
    pageId === "catalog"
      ? catalogPhaseStatus(displaySync, CATALOG_SYNC_PHASE)
      : CATALOG_PHASE_STATUS_NOT_STARTED;
  const requestCreationPhaseStatus =
    pageId === "catalog"
      ? catalogPhaseStatus(displaySync, CATALOG_REQUEST_CREATION_PHASE)
      : CATALOG_PHASE_STATUS_NOT_STARTED;
  const activePhase =
    pageId === "catalog" ? catalogActivePhase(displaySync) : "";
  const activePhaseOwner =
    pageId === "catalog" && activePhase
      ? catalogPhaseOwner(displaySync, activePhase)
      : displaySync.runMode;
  const activePhaseStatus =
    pageId === "catalog" && activePhase
      ? catalogPhaseStatus(displaySync, activePhase)
      : "";
  const hasActiveSync = Boolean(activePhase) && catalogPhaseIsActive(activePhaseStatus);
  const runningCurrentPhase = hasActiveSync && activePhaseOwner === runMode;
  const blockedByOtherRuntime =
    pageId === "catalog"
      ? hasActiveSync && activePhaseOwner !== runMode
      : displaySync.status !== "idle" && displaySync.runMode !== runMode;
  const canResumeRequestCreation =
    pageId === "catalog" &&
    requestCreationPhaseStatus === CATALOG_PHASE_STATUS_PAUSED;
  const canResumeSyncPhase =
    pageId === "catalog"
      ? syncPhaseStatus === CATALOG_PHASE_STATUS_PAUSED
      : displaySync.status === "paused";
  const pausedActionPhase =
    pageId === "catalog"
      ? canResumeRequestCreation
        ? CATALOG_REQUEST_CREATION_PHASE
        : canResumeSyncPhase
          ? CATALOG_SYNC_PHASE
          : ""
      : displaySync.status === "paused"
        ? CATALOG_SYNC_PHASE
        : "";
  const startsRequestCreationDirectly =
    pageId === "catalog" &&
    !canResumeRequestCreation &&
    !canResumeSyncPhase &&
    syncPhaseStatus === CATALOG_PHASE_STATUS_COMPLETED &&
    requestCreationPhaseStatus === CATALOG_PHASE_STATUS_NOT_STARTED;
  const actionPhase =
    pageId === "catalog"
      ? runningCurrentPhase && activePhase
        ? activePhase
        : pausedActionPhase || (startsRequestCreationDirectly
          ? CATALOG_REQUEST_CREATION_PHASE
          : CATALOG_SYNC_PHASE)
      : CATALOG_SYNC_PHASE;
  const isRequestCreationPhase =
    pageId === "catalog" && actionPhase === CATALOG_REQUEST_CREATION_PHASE;
  const runLabel =
    isRequestCreationPhase && !startsRequestCreationDirectly
    ? "automated request creation"
    : pageId === "catalog"
      ? "automated catalog sync"
      : "incomplete catalog sync";
  const runMessage = isRequestCreationPhase
    ? startsRequestCreationDirectly
      ? "Creating book requests from the synced catalog records."
      : "Resuming automated request creation from saved progress."
    : pageId === "catalog"
      ? startsRequestCreationDirectly
        ? "Creating book requests from the synced catalog records."
        : canResumeSyncPhase
        ? "Continuing automated catalog sync from the saved endpoint."
        : "Automated catalog sync is running."
      : "Incomplete catalog sync is running.";
  const pauseMessage = isRequestCreationPhase
    ? "Pausing automated request creation after the current batch finishes."
    : pageId === "catalog"
      ? "Pausing automated catalog sync after the current page finishes."
      : "Pausing incomplete catalog sync after the current batch finishes.";
  const resumeMessage = isRequestCreationPhase
    ? "Resuming automated request creation from saved progress."
    : pageId === "catalog"
      ? canResumeSyncPhase
        ? "Continuing automated catalog sync from the saved endpoint."
        : "Restarting automated catalog sync from the beginning."
      : "Restarting incomplete catalog sync from the beginning.";
  const isRunning =
    pageId === "catalog"
      ? runningCurrentPhase
      : displaySync.runMode === runMode &&
        (displaySync.status === "syncing" || displaySync.status === "pausing");
  const isPausing =
    pageId === "catalog"
      ? runningCurrentPhase &&
        (activePhaseStatus === CATALOG_PHASE_STATUS_PAUSING ||
          displaySync.status === "pausing")
      : displaySync.runMode === runMode && displaySync.status === "pausing";
  const isPaused =
    pageId === "catalog"
      ? !runningCurrentPhase && Boolean(pausedActionPhase)
      : displaySync.status === "paused" && displaySync.runMode === runMode;
  const busy = saving || running;
  const controlsDisabled =
    busy || blockedByOtherRuntime || blockedByExternalRuntime;
  const rawStatusMessage =
    displaySync.status !== "idle"
      ? displaySync.message || ""
      : automation.statusMessage || "";
  const statusMessage =
    pageId === "catalog"
      ? normalizeCatalogCountMessage(rawStatusMessage, recordCount)
      : rawStatusMessage;
  const showFooter = saving || Boolean(statusMessage);

  useEffect(() => {
    setForm({
      enabled: automation.enabled,
      interval: automation.interval,
      time: automation.time,
    });
  }, [automation.enabled, automation.interval, automation.time]);

  useEffect(() => {
    if (!optimisticSync) {
      return undefined;
    }
    if (
      sync.status === optimisticSync.status &&
      catalogRuntimePhase(sync) === (optimisticSync.phase || CATALOG_SYNC_PHASE)
    ) {
      const elapsed = Date.now() - Number(optimisticSync.startedAt || 0);
      if (elapsed >= OPTIMISTIC_SYNC_MIN_MS) {
        setOptimisticSync(null);
        return undefined;
      }
      const timerId = window.setTimeout(() => {
        setOptimisticSync(null);
      }, OPTIMISTIC_SYNC_MIN_MS - elapsed);
      return () => {
        window.clearTimeout(timerId);
      };
    }
    return undefined;
  }, [optimisticSync, sync.status, sync.phase, sync.progress?.phase]);

  useEffect(() => {
    onOptimisticSyncChange?.(
      optimisticSync
        ? {
            ...optimisticSync,
            runMode,
          }
        : null,
    );
  }, [onOptimisticSyncChange, optimisticSync, runMode]);

  useEffect(() => {
    if (
      pageId === "catalog" ||
      !pendingNonCatalogSync ||
      typeof window === "undefined"
    ) {
      return undefined;
    }
    const elapsed = Date.now() - Number(pendingNonCatalogSync.startedAt || 0);
    const timerId = window.setTimeout(() => {
      setPendingNonCatalogSync(null);
    }, Math.max(OPTIMISTIC_SYNC_MIN_MS - elapsed, 0));
    return () => {
      window.clearTimeout(timerId);
    };
  }, [pageId, pendingNonCatalogSync]);

  useEffect(() => {
    if (!optimisticSync || typeof window === "undefined") {
      return undefined;
    }
    const timerId = window.setTimeout(() => {
      setOptimisticSync(null);
    }, OPTIMISTIC_SYNC_MAX_MS);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [optimisticSync]);

  async function runWithOptimisticState(nextOptimisticSync, action) {
    if (pageId !== "catalog") {
      setPendingNonCatalogSync({
        ...nextOptimisticSync,
        startedAt: Date.now(),
      });
    }
    setOptimisticSync({
      ...nextOptimisticSync,
      startedAt: Date.now(),
    });
    const result = await action?.();
    if (!result) {
      setPendingNonCatalogSync(null);
      setOptimisticSync(null);
    }
    return result;
  }

  if (loading) {
    return (
      <section
        className={`detail-card processing-card processing-card-skeleton processing-replacement-card processing-settings-card${
          className ? ` ${className}` : ""
        }`}
        data-testid={`${pageId}-automation-card`}
      >
        <div className="processing-card-head processing-card-head--settings">
          <div className="processing-card-head-meta">
            <h2>{title}</h2>
          </div>
          <div className="processing-card-head-controls">
            <IconOnlyActionSkeleton
              testId={`${pageId}-automation-run-skeleton`}
              label="Run automation"
              className="processing-icon-button--automation"
            />
            <SwitchSkeleton testId={`${pageId}-automation-enabled-skeleton`} />
          </div>
        </div>
        <div className="processing-automation-row">
          <AutomationFieldSkeleton
            testId={`${pageId}-automation-interval-skeleton`}
            label="Interval"
            controlClassName="processing-automation-field-control--select"
          />
          <AutomationFieldSkeleton
            testId={`${pageId}-automation-time-skeleton`}
            label="Time"
            controlClassName="processing-automation-field-control--time"
          />
          <div className="processing-automation-save-slot">
            <ButtonSkeleton
              testId={`${pageId}-automation-save-skeleton`}
              label="Save"
            />
          </div>
        </div>
        {showFooter ? (
          <div className="processing-card-footer">
            <div className="processing-card-status">
              <ProcessingStatusSkeleton variant="automation" />
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  const runControl = isPaused
    ? {
        label:
          pageId === "catalog" && isRequestCreationPhase
            ? "Resume automated request creation"
            : pageId === "catalog"
            ? "Resume automated catalog sync"
            : "Resume incomplete catalog sync",
        icon: <PlayIcon />,
        state: "paused",
        disabled: controlsDisabled,
        onClick: () =>
          runWithOptimisticState(
            {
              status: "syncing",
              message: resumeMessage,
              phase: actionPhase,
            },
            onResume,
          ),
      }
    : isRunning
      ? {
          label: isPausing ? `Pausing ${runLabel}` : `Pause ${runLabel}`,
          icon: <PauseIcon />,
          state: isPausing ? "pausing" : "syncing",
          disabled: busy || isPausing,
          onClick: () =>
            runWithOptimisticState(
            {
              status: "pausing",
              message: pauseMessage,
              phase: actionPhase,
            },
            onPause,
          ),
        }
      : {
          label: `Run ${runLabel}`,
          icon: <PlayIcon />,
          state: "idle",
          disabled: busy || blockedByOtherRuntime || blockedByExternalRuntime,
          onClick: () =>
            runWithOptimisticState(
            {
              status: "syncing",
              message: runMessage,
              phase: actionPhase,
            },
            onRun,
          ),
      };

  return (
    <section
      className={`detail-card processing-card processing-replacement-card processing-settings-card${
        className ? ` ${className}` : ""
      }`}
      data-testid={`${pageId}-automation-card`}
    >
      <div className="processing-card-head processing-card-head--settings">
        <div className="processing-card-head-meta">
          <h2>{title}</h2>
        </div>
        <div className="processing-card-head-controls">
          <IconOnlyActionButton
            testId={`${pageId}-automation-run-btn`}
            label={runControl.label}
            icon={runControl.icon}
            state={runControl.state}
            disabled={runControl.disabled}
            onClick={runControl.onClick}
            className="processing-icon-button--automation"
          />
          <label className="processing-switch">
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={controlsDisabled}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))
              }
              data-testid={`${pageId}-automation-enabled`}
            />
            <span className="processing-switch-track">
              <span className="processing-switch-state">
                {form.enabled ? "On" : "Off"}
              </span>
              <span className="processing-switch-thumb" />
            </span>
          </label>
        </div>
      </div>
      <div className="processing-automation-row">
        <label className="processing-automation-field">
          <span className="processing-automation-field-label">Interval</span>
          <span className="processing-automation-field-control processing-automation-field-control--select">
            <select
              className="processing-automation-input"
              value={form.interval}
              disabled={controlsDisabled}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  interval: event.target.value,
                }))
              }
              data-testid={`${pageId}-automation-interval`}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </span>
        </label>
        <label className="processing-automation-field">
          <span className="processing-automation-field-label">Time</span>
          <span className="processing-automation-field-control processing-automation-field-control--time">
            <input
              className="processing-automation-input processing-automation-time-input"
              type="time"
              value={form.time}
              disabled={controlsDisabled}
              onChange={(event) =>
                setForm((current) => ({ ...current, time: event.target.value }))
              }
              data-testid={`${pageId}-automation-time`}
            />
          </span>
        </label>
        <div className="processing-automation-save-slot">
          <button
            type="button"
            className="primary-button"
            disabled={controlsDisabled}
            onClick={() => onSave(form)}
            data-testid={`${pageId}-automation-save-btn`}
          >
            Save
          </button>
        </div>
      </div>
      {showFooter ? (
        <div className="processing-card-footer">
          <div className="processing-card-status">
            {saving ? (
              <span
                className="processing-inline-loader"
                data-testid={`${pageId}-automation-loader`}
              >
                <LoadingSpinner size={14} /> Saving
              </span>
            ) : null}
            {statusMessage ? (
              <span
                className="processing-automation-status"
                data-testid={`${pageId}-automation-status`}
              >
                {statusMessage}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CatalogSyncPanel({
  className = "",
  loading = false,
  sync = DEFAULT_SYNC_CARD,
  recordCount,
  blockedByExternalRuntime = false,
  onOptimisticSyncChange = null,
}) {
  const [pauseRequested, setPauseRequested] = useState(false);
  const [optimisticSync, setOptimisticSync] = useState(null);
  const { busyCards, startCatalogSync, pauseCatalogSync, resumeCatalogSync } =
    useBookProcessing();
  const syncBusy = Boolean(busyCards["catalog-sync"]);
  const effectiveSync = optimisticSync
    ? {
        ...sync,
        status: optimisticSync.status,
        message: optimisticSync.message,
        runMode: SYNC_RUN_MODE_MANUAL,
        phase: optimisticSync.phase,
      }
    : sync;
  const syncPhaseStatus = catalogPhaseStatus(effectiveSync, CATALOG_SYNC_PHASE);
  const activePhase = catalogActivePhase(effectiveSync);
  const activePhaseOwner = activePhase
    ? catalogPhaseOwner(effectiveSync, activePhase)
    : "";
  const syncPhaseIsActive = activePhase === CATALOG_SYNC_PHASE;
  const requestCreationIsActive = activePhase === CATALOG_REQUEST_CREATION_PHASE;
  const canResumeSync = syncPhaseStatus === CATALOG_PHASE_STATUS_PAUSED;
  const manualOwnsActiveSync =
    syncPhaseIsActive && activePhaseOwner === SYNC_RUN_MODE_MANUAL;
  const otherModeOwnsRuntime =
    requestCreationIsActive ||
    (syncPhaseIsActive && activePhaseOwner !== SYNC_RUN_MODE_MANUAL);
  const isSyncing = manualOwnsActiveSync;
  const isPausing =
    manualOwnsActiveSync &&
    (
      pauseRequested ||
      syncPhaseStatus === CATALOG_PHASE_STATUS_PAUSING ||
      effectiveSync.status === "pausing"
    );
  const statusMessage = normalizeCatalogCountMessage(effectiveSync.message, recordCount);
  const syncMessageLines = splitSyncMessage(statusMessage);

  useEffect(() => {
    if (!isSyncing) {
      setPauseRequested(false);
    }
  }, [isSyncing]);

  useEffect(() => {
    if (!optimisticSync) {
      return undefined;
    }
    if (
      sync.status === optimisticSync.status &&
      catalogRuntimePhase(sync) === (optimisticSync.phase || CATALOG_SYNC_PHASE)
    ) {
      const elapsed = Date.now() - Number(optimisticSync.startedAt || 0);
      if (elapsed >= OPTIMISTIC_SYNC_MIN_MS) {
        setOptimisticSync(null);
        return undefined;
      }
      const timerId = window.setTimeout(() => {
        setOptimisticSync(null);
      }, OPTIMISTIC_SYNC_MIN_MS - elapsed);
      return () => {
        window.clearTimeout(timerId);
      };
    }
    return undefined;
  }, [optimisticSync, sync.status, sync.phase, sync.progress?.phase]);

  useEffect(() => {
    onOptimisticSyncChange?.(
      optimisticSync
        ? {
            ...optimisticSync,
            runMode: SYNC_RUN_MODE_MANUAL,
          }
        : null,
    );
  }, [onOptimisticSyncChange, optimisticSync]);

  useEffect(() => {
    if (!optimisticSync || typeof window === "undefined") {
      return undefined;
    }

    const timerId = window.setTimeout(() => {
      setOptimisticSync(null);
    }, OPTIMISTIC_SYNC_MAX_MS);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [optimisticSync]);

  if (loading) {
    return (
      <section
        className={`detail-card processing-card processing-card-skeleton processing-replacement-card processing-settings-card${
          className ? ` ${className}` : ""
        }`}
        data-testid="catalog-sync-card"
      >
        <div className="processing-card-head">
          <div className="processing-card-head-meta">
            <h2>Manual</h2>
          </div>
        </div>
        <div className="processing-sync-body">
          <IconOnlyActionSkeleton
            testId="catalog-sync-control-skeleton"
            label="Start sync"
            className="processing-icon-button--manual"
          />
        </div>
        <div className="processing-card-footer processing-card-footer--sync">
          <div className="processing-card-status processing-card-status--stack">
            <ProcessingStatusSkeleton
              lines={syncMessageLines.length > 1 ? 2 : 1}
              variant="sync"
            />
          </div>
        </div>
      </section>
    );
  }

  async function handlePauseSync() {
    setPauseRequested(true);
    const result = await runWithOptimisticSync(
      {
        status: "pausing",
        message: "Pausing after the current page finishes.",
        phase: CATALOG_SYNC_PHASE,
      },
      pauseCatalogSync,
    );
    if (!result) {
      setPauseRequested(false);
    }
    return result;
  }

  async function runWithOptimisticSync(nextOptimisticSync, action) {
    setOptimisticSync({
      ...nextOptimisticSync,
      startedAt: Date.now(),
    });
    const result = await action?.();
    if (!result) {
      setOptimisticSync(null);
    }
    return result;
  }

  const control =
    canResumeSync
      ? {
          testId: "catalog-sync-resume-btn",
          label: "Resume sync",
          icon: <PlayIcon />,
          state: "paused",
          disabled:
            syncBusy || otherModeOwnsRuntime || blockedByExternalRuntime,
          onClick: () =>
            runWithOptimisticSync(
              {
                status: "syncing",
                message: "Continuing catalog sync from the saved endpoint.",
                phase: CATALOG_SYNC_PHASE,
              },
              resumeCatalogSync,
            ),
        }
      : isSyncing
        ? {
            testId: "catalog-sync-pause-btn",
            label: isPausing ? "Pausing sync" : "Pause sync",
            icon: <PauseIcon />,
            state: isPausing ? "pausing" : "syncing",
            disabled: isPausing,
            onClick: handlePauseSync,
          }
        : {
            testId: "catalog-sync-start-btn",
            label: "Start sync",
            icon: <PlayIcon />,
            state: "idle",
            disabled:
              syncBusy || otherModeOwnsRuntime || blockedByExternalRuntime,
            onClick: () =>
              runWithOptimisticSync(
                {
                  status: "syncing",
                  message: "Syncing catalog records.",
                  phase: CATALOG_SYNC_PHASE,
                },
                () => startCatalogSync(),
              ),
          };

  return (
    <section
      className={`detail-card processing-card processing-replacement-card processing-settings-card${
        className ? ` ${className}` : ""
      }`}
      data-testid="catalog-sync-card"
    >
      <div className="processing-card-head">
        <div className="processing-card-head-meta">
          <h2>Manual</h2>
        </div>
      </div>
      <div className="processing-sync-body">
        <IconOnlyActionButton
          testId={control.testId}
          label={control.label}
          icon={control.icon}
          state={control.state}
          disabled={control.disabled}
          onClick={control.onClick}
          className="processing-icon-button--manual"
        />
      </div>
      <div className="processing-card-footer processing-card-footer--sync">
        <div className="processing-card-status processing-card-status--stack">
          {syncBusy || isSyncing ? (
            <span
              className="processing-inline-loader"
              data-testid="catalog-sync-loader"
            >
              <LoadingSpinner size={14} /> {isPausing ? "Pausing" : "Syncing"}
            </span>
          ) : null}
          <span
            className="catalog-toolbar-sync-status"
            data-testid="catalog-sync-progress"
          >
            {syncMessageLines.map((line, index) => (
              <span
                key={`${sync.status}-${index}-${line}`}
                className={`catalog-toolbar-sync-status-line${
                  index === 0
                    ? " catalog-toolbar-sync-status-line--summary"
                    : " catalog-toolbar-sync-status-line--details"
                }`}
                data-testid={
                  index === 0
                    ? "catalog-sync-progress-summary"
                    : "catalog-sync-progress-details"
                }
              >
                {line}
              </span>
            ))}
          </span>
        </div>
      </div>
    </section>
  );
}

export function CatalogProcessingPage() {
  const {
    busyCards,
    canLoadProcessingState,
    createRequestsForRecords,
    saveCatalogAutomation,
    runCatalogAutomation,
    pauseCatalogAutomation,
    resumeCatalogAutomation,
  } = useBookProcessing();
  const {
    data: catalogOverviewCard,
    loadedOnce: catalogOverviewLoaded,
  } = useProcessingCardData({
    cardKey: "catalog-overview",
    enabled: canLoadProcessingState,
  });
  const {
    data: catalogSyncCard,
    loadedOnce: catalogSyncLoaded,
  } = useProcessingCardData({
    cardKey: "catalog-sync",
    enabled: canLoadProcessingState,
  });
  const {
    data: catalogAutomationCard,
    loadedOnce: catalogAutomationLoaded,
  } = useProcessingCardData({
    cardKey: "catalog-automation",
    enabled: canLoadProcessingState,
  });
  const [optimisticCatalogRuntime, setOptimisticCatalogRuntime] = useState(null);
  const catalogAutomationSaving = Boolean(busyCards["catalog-automation-save"]);
  const catalogAutomationRunning = Boolean(busyCards["catalog-automation-run"]);
  const summary = catalogOverviewCard?.summary || {};
  const catalogSync = catalogSyncCard?.sync || DEFAULT_SYNC_CARD;
  const catalogAutomation = catalogAutomationCard?.automation || DEFAULT_AUTOMATION_CARD;
  const effectiveCatalogSync = optimisticCatalogRuntime
    ? {
        ...catalogSync,
        status: optimisticCatalogRuntime.status,
        message: optimisticCatalogRuntime.message,
        runMode: optimisticCatalogRuntime.runMode || SYNC_RUN_MODE_MANUAL,
        phase: optimisticCatalogRuntime.phase,
      }
    : catalogSync;
  const catalogRuntimePhase = catalogActivePhase(effectiveCatalogSync);
  const catalogRuntimeOwner = catalogRuntimePhase
    ? catalogPhaseOwner(effectiveCatalogSync, catalogRuntimePhase)
    : "";
  const catalogRuntimeBlocksModeSwitch =
    Boolean(catalogRuntimePhase) &&
    catalogPhaseIsActive(
      catalogPhaseStatus(effectiveCatalogSync, catalogRuntimePhase),
    );
  const manualRuntimeOwnsCatalog =
    catalogRuntimeBlocksModeSwitch &&
    catalogRuntimeOwner === SYNC_RUN_MODE_MANUAL;
  const automationRuntimeOwnsCatalog =
    catalogRuntimeBlocksModeSwitch &&
    catalogRuntimeOwner === SYNC_RUN_MODE_CATALOG_AUTOMATION;

  return (
    <PageFrame pageId="catalog" title="Catalog">
      <OverviewPanel
        pageId="catalog"
        loading={!catalogOverviewLoaded}
        stats={[
          { id: "records", label: "Book Records", value: summary.records || 0 },
          {
            id: "not-created",
            label: "Not Created",
            value: summary.notCreated || 0,
          },
          {
            id: "active",
            label: "Active Requests",
            value: summary.active || 0,
          },
          {
            id: "created",
            label: "Created",
            value: summary.created || 0,
          },
          { id: "on-hold", label: "On Hold", value: summary.onHold || 0 },
        ]}
      />
      <div className="processing-card-grid processing-card-grid--catalog">
        <CatalogSyncPanel
          className="processing-catalog-sync-card"
          loading={!catalogSyncLoaded}
          sync={effectiveCatalogSync}
          recordCount={summary.records}
          blockedByExternalRuntime={automationRuntimeOwnsCatalog}
          onOptimisticSyncChange={setOptimisticCatalogRuntime}
        />
        <AutomationPanel
          pageId="catalog"
          title="Automation"
          automation={catalogAutomation}
          sync={effectiveCatalogSync}
          blockedByExternalRuntime={manualRuntimeOwnsCatalog}
          onOptimisticSyncChange={setOptimisticCatalogRuntime}
          recordCount={summary.records}
          loading={!catalogAutomationLoaded}
          saving={catalogAutomationSaving}
          running={catalogAutomationRunning}
          onSave={saveCatalogAutomation}
          onRun={runCatalogAutomation}
          onPause={pauseCatalogAutomation}
          onResume={resumeCatalogAutomation}
          className="processing-catalog-automation-card"
        />
      </div>
      <ProcessingDataCard
        pageId="catalog"
        cardId="records"
        cardKey="catalog-records"
        title="Book Records"
        description="Synced catalog records ready for book creation."
        busy={Boolean(busyCards["catalog-records"])}
        className="processing-inline-count-card processing-catalog-card processing-catalog-records-card"
        bookColumnMode="split"
        showDetailsColumn={false}
        countPlacement="inline-tools"
        actions={[
          {
            id: "create",
            label: "Create Book",
            onAction: (ids) => createRequestsForRecords(ids),
          },
        ]}
      />
    </PageFrame>
  );
}

function CreateCard({
  cardId,
  cardKey,
  title,
  description,
  actions,
  actionLabel,
  renderRowAction,
}) {
  const { busyCards } = useBookProcessing();
  return (
    <ProcessingDataCard
      pageId="create"
      cardId={cardId}
      cardKey={cardKey}
      title={title}
      description={description}
      busy={Boolean(busyCards[`create-${cardId}`])}
      className="processing-inline-count-card processing-create-card"
      showDetailsColumn={false}
      countPlacement="inline-tools"
      actions={actions}
      actionLabel={actionLabel}
      renderRowAction={renderRowAction}
    />
  );
}

export function CreateProcessingPage() {
  const {
    canLoadProcessingState,
    deleteRequests,
    pauseRequests,
  } = useBookProcessing();
  const { data: createOverviewCard, loadedOnce: createOverviewLoaded } =
    useProcessingCardData({
      cardKey: "create-overview",
      enabled: canLoadProcessingState,
    });
  const summary = createOverviewCard?.summary || {};

  return (
    <PageFrame pageId="create" title="Create">
      <OverviewPanel
        pageId="create"
        loading={!createOverviewLoaded}
        stats={[
          {
            id: "requests",
            label: "Requests",
            value: summary.requests || 0,
          },
          {
            id: "queue",
            label: "Queue",
            value: summary.queue || 0,
          },
          {
            id: "processing",
            label: "Processing",
            value: summary.processing || 0,
          },
          {
            id: "created",
            label: "Created",
            value: summary.created || 0,
          },
        ]}
      />
      <div className="processing-card-grid">
        <CreateCard
          cardId="requests"
          cardKey="create-requests"
          title="Requests"
          description="New book creation requests."
          actions={[
            {
              id: "delete",
              label: "Delete",
              danger: true,
              onAction: (ids) => deleteRequests("create-requests", ids),
            },
          ]}
        />
        <CreateCard
          cardId="queue"
          cardKey="create-queue"
          title="Queue"
          description="Requests waiting for the processor."
          actions={[
            {
              id: "delete",
              label: "Delete",
              danger: true,
              onAction: (ids) => deleteRequests("create-queue", ids),
            },
          ]}
        />
        <CreateCard
          cardId="processing"
          cardKey="create-processing"
          title="Processing"
          description="Requests currently being built."
          actions={[
            {
              id: "pause",
              label: "Pause",
              onAction: (ids) => pauseRequests("create-processing", ids),
            },
            {
              id: "delete",
              label: "Delete",
              danger: true,
              onAction: (ids) => deleteRequests("create-processing", ids),
            },
          ]}
        />
        <CreateCard
          cardId="created"
          cardKey="create-created"
          title="Created"
          description="Completed books."
          actionLabel="Open"
          renderRowAction={(row) =>
            row.linkedBookSlug ? (
              <BookRouteLink
                slug={row.linkedBookSlug}
                className="ghost-button table-row-action"
                data-testid={`create-created-open-${row.id}`}
              >
                Open
              </BookRouteLink>
            ) : null
          }
          actions={[
            {
              id: "delete",
              label: "Delete",
              danger: true,
              onAction: (ids) =>
                deleteRequests("create-created", ids, { deleteBook: true }),
            },
          ]}
        />
      </div>
    </PageFrame>
  );
}

function OnHoldCard({
  cardId,
  cardKey,
  title,
  description,
  actions,
  detailsLabel,
  className = "",
}) {
  const { busyCards } = useBookProcessing();
  return (
    <ProcessingDataCard
      pageId="on-hold"
      cardId={cardId}
      cardKey={cardKey}
      title={title}
      description={description}
      busy={Boolean(busyCards[`on-hold-${cardId}`])}
      countPlacement="inline-tools"
      actions={actions}
      detailsLabel={detailsLabel}
      className={`processing-inline-count-card${className ? ` ${className}` : ""}`}
    />
  );
}

export function OnHoldProcessingPage() {
  const {
    canLoadProcessingState,
    resumePausedRequests,
    retryFailedRequests,
    markDuplicateRequestsAsNew,
    confirmDuplicateRequests,
    createAgainRequests,
    deleteRequests,
  } = useBookProcessing();
  const { data: onHoldOverviewCard, loadedOnce: onHoldOverviewLoaded } =
    useProcessingCardData({
      cardKey: "on-hold-overview",
      enabled: canLoadProcessingState,
    });
  const summary = onHoldOverviewCard?.summary || {};

  return (
    <PageFrame pageId="on-hold" title="On Hold">
      <OverviewPanel
        pageId="on-hold"
        loading={!onHoldOverviewLoaded}
        stats={[
          {
            id: "paused",
            label: "Paused",
            value: summary.paused || 0,
          },
          {
            id: "failed",
            label: "Failed",
            value: summary.failed || 0,
          },
          {
            id: "duplicate",
            label: "Duplicate",
            value: summary.duplicate || 0,
          },
          {
            id: "deleted",
            label: "Deleted",
            value: summary.deleted || 0,
          },
        ]}
      />
      <div className="processing-card-grid">
        <OnHoldCard
          cardId="paused"
          cardKey="on-hold-paused"
          title="Paused"
          description="Requests with saved progress."
          actions={[
            {
              id: "resume",
              label: "Resume",
              onAction: (ids) => resumePausedRequests("on-hold-paused", ids),
            },
            {
              id: "delete",
              label: "Delete",
              danger: true,
              onAction: (ids) => deleteRequests("on-hold-paused", ids),
            },
          ]}
        />
        <OnHoldCard
          cardId="failed"
          cardKey="on-hold-failed"
          title="Failed"
          description="Requests that need retry or deletion."
          detailsLabel="Error Reason"
          className="processing-on-hold-failed-card"
          actions={[
            {
              id: "retry",
              label: "Retry",
              onAction: (ids) => retryFailedRequests("on-hold-failed", ids),
            },
            {
              id: "delete",
              label: "Delete",
              danger: true,
              onAction: (ids) => deleteRequests("on-hold-failed", ids),
            },
          ]}
        />
        <OnHoldCard
          cardId="duplicate"
          cardKey="on-hold-duplicate"
          title="Duplicate"
          description="Requests waiting on duplicate resolution."
          actions={[
            {
              id: "new",
              label: "New",
              onAction: (ids) =>
                markDuplicateRequestsAsNew("on-hold-duplicate", ids),
            },
            {
              id: "duplicate",
              label: "Duplicate",
              onAction: (ids) =>
                confirmDuplicateRequests("on-hold-duplicate", ids),
            },
            {
              id: "delete",
              label: "Delete",
              danger: true,
              onAction: (ids) => deleteRequests("on-hold-duplicate", ids),
            },
          ]}
        />
        <OnHoldCard
          cardId="deleted"
          cardKey="on-hold-deleted"
          title="Deleted"
          description="Deleted requests available for recreation."
          actions={[
            {
              id: "create-again",
              label: "Create Again",
              onAction: (ids) => createAgainRequests("on-hold-deleted", ids),
            },
          ]}
        />
      </div>
    </PageFrame>
  );
}

export function IncompleteProcessingPage() {
  const {
    busyCards,
    canLoadProcessingState,
    saveIncompleteAutomation,
    runIncompleteAutomation,
    pauseIncompleteAutomation,
    resumeIncompleteAutomation,
    recreateCompletedRequests,
    deleteRequests,
  } = useBookProcessing();
  const incompleteAutomationSaving = Boolean(
    busyCards["incomplete-automation-save"],
  );
  const incompleteAutomationRunning = Boolean(
    busyCards["incomplete-automation-run"],
  );
  const {
    data: incompleteOverviewCard,
    loadedOnce: incompleteOverviewLoaded,
  } = useProcessingCardData({
    cardKey: "incomplete-overview",
    enabled: canLoadProcessingState,
  });
  const {
    data: incompleteAutomationCard,
    loadedOnce: incompleteAutomationLoaded,
  } = useProcessingCardData({
    cardKey: "incomplete-automation",
    enabled: canLoadProcessingState,
  });
  const summary = incompleteOverviewCard?.summary || {};
  const incompleteAutomation =
    incompleteAutomationCard?.automation || DEFAULT_AUTOMATION_CARD;
  const incompleteSync = incompleteAutomationCard?.sync || DEFAULT_SYNC_CARD;

  return (
    <PageFrame pageId="incomplete" title="Incomplete">
      <OverviewPanel
        pageId="incomplete"
        loading={!incompleteOverviewLoaded}
        stats={[
          {
            id: "incomplete",
            label: "Incomplete",
            value: summary.incomplete || 0,
          },
          {
            id: "resolved",
            label: "Updated",
            value: summary.resolved || 0,
          },
        ]}
      />
      <div className="processing-card-grid">
        <AutomationPanel
          pageId="incomplete"
          title="Automation"
          automation={incompleteAutomation}
          sync={incompleteSync}
          loading={!incompleteAutomationLoaded}
          saving={incompleteAutomationSaving}
          running={incompleteAutomationRunning}
          onSave={saveIncompleteAutomation}
          onRun={runIncompleteAutomation}
          onPause={pauseIncompleteAutomation}
          onResume={resumeIncompleteAutomation}
          className="processing-card-span-full processing-incomplete-automation-card"
        />
        <ProcessingDataCard
          pageId="incomplete"
          cardId="records"
          cardKey="incomplete-records"
          title="Incomplete"
          description="Records currently classified as incomplete."
          className="processing-inline-count-card processing-incomplete-records-card"
          bookColumnMode="split"
          countPlacement="inline-tools"
          readOnly
        />
        <ProcessingDataCard
          pageId="incomplete"
          cardId="completed"
          cardKey="incomplete-completed"
          title="Updated"
          description="Records updated by incomplete automation."
          className="processing-inline-count-card processing-incomplete-completed-card"
          busy={Boolean(busyCards["incomplete-completed"])}
          countPlacement="inline-tools"
          actions={[
            {
              id: "recreate",
              label: "Recreate Book",
              onAction: (ids) =>
                recreateCompletedRequests("incomplete-completed", ids),
            },
            {
              id: "delete",
              label: "Delete",
              danger: true,
              onAction: (ids) => deleteRequests("incomplete-completed", ids),
            },
          ]}
        />
      </div>
    </PageFrame>
  );
}
