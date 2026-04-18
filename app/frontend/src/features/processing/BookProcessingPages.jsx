import { useEffect, useMemo, useState } from "react";
import LoadingSpinner from "../../components/LoadingSpinner";
import {
  countActiveFilters,
  renderField,
} from "../../components/catalog-toolbar/fields.jsx";
import {
  FilterIcon,
  SearchIcon,
} from "../../components/catalog-toolbar/icons.jsx";
import {
  latestRequestForRecord,
  useBookProcessing,
} from "./BookProcessingStore";
import { REQUEST_STATE_LABELS } from "./types";

const SEARCH_PLACEHOLDER =
  "Search name, URL, category, writer, translator, or publisher";
const SYNC_RUN_MODE_MANUAL = "manual";
const SYNC_RUN_MODE_CATALOG_AUTOMATION = "catalog_automation";
const SYNC_RUN_MODE_INCOMPLETE_AUTOMATION = "incomplete_automation";
const INCOMPLETE_CATEGORY_KEYWORDS = [
  "incomplete",
  "unfinished",
  "অসম্পূর্ণ",
  "অসম্পূর্ণ বই",
];

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

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
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

function recordDisplayUrl(record) {
  return record?.displayUrl || decodeUrlForDisplay(record?.url);
}

function isIncompleteCategory(value) {
  const normalized = normalizeText(value);
  return INCOMPLETE_CATEGORY_KEYWORDS.some((keyword) =>
    normalized.includes(keyword.toLowerCase()),
  );
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

function uniqueOptions(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right),
  );
}

function requestDetails(request) {
  if (!request) {
    return "";
  }
  if (request.progress?.checkpoint) {
    return `${request.progress.checkpoint} (${formatDate(request.progress.savedAt)})`;
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

function recordSearchText(record, request) {
  const displayUrl = recordDisplayUrl(record);
  return [
    record?.name,
    record?.url,
    displayUrl,
    record?.displayPath,
    record?.writer,
    record?.translator,
    record?.publisher,
    record?.category,
    REQUEST_STATE_LABELS[request?.state || record?.bookCreationState],
    requestDetails(request),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function OverviewStat({ testId, label, value }) {
  return (
    <div className="processing-summary-stat" data-testid={testId}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6.5 4.5v11l8.75-5.5-8.75-5.5Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6.25 4.75h2.75v10.5H6.25zM11 4.75h2.75v10.5H11z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
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

function PageFrame({ pageId, title, children }) {
  return (
    <div className="processing-page page-stack" data-testid={`${pageId}-page`}>
      <section className="detail-card processing-page-header">
        <div className="panel-header">
          <div>
            <h1>{title}</h1>
          </div>
        </div>
      </section>
      {children}
    </div>
  );
}

function OverviewPanel({ pageId, stats }) {
  return (
    <section className="detail-card processing-summary-card">
      <div className="processing-summary-bar">
        {stats.map((stat) => (
          <OverviewStat
            key={stat.id}
            testId={`${pageId}-overview-stat-${stat.id}`}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>
    </section>
  );
}

function filterRows(rows, query, categoryFilter, statusFilter) {
  const normalizedQuery = normalizeText(query);
  return rows.filter((row) => {
    if (normalizedQuery && !row.searchText.includes(normalizedQuery)) {
      return false;
    }
    if (categoryFilter && row.category !== categoryFilter) {
      return false;
    }
    if (statusFilter && row.status !== statusFilter) {
      return false;
    }
    return true;
  });
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

function ProcessingDataCard({
  pageId,
  cardId,
  title,
  description,
  rows,
  actions = [],
  busy = false,
  readOnly = false,
  detailsLabel = "Details",
  emptyLabel = "No records.",
  className = "",
  fullSpan = false,
  bookColumnMode = "combined",
}) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [filters, setFilters] = useState({
    q: "",
    category: "",
    status: "",
  });
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const showSelectionColumn = actions.length > 0 && !readOnly;
  const splitBookColumn = bookColumnMode === "split";
  const defaultFilters = useMemo(
    () => ({
      q: "",
      category: "",
      status: "",
    }),
    [],
  );

  const categoryOptions = useMemo(
    () => uniqueOptions(rows.map((row) => row.category)),
    [rows],
  );
  const statusOptions = useMemo(
    () => uniqueOptions(rows.map((row) => row.status)),
    [rows],
  );
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
  const visibleRows = useMemo(
    () => filterRows(rows, filters.q, filters.category, filters.status),
    [filters.category, filters.q, filters.status, rows],
  );
  const visibleColumnCount = (showSelectionColumn ? 1 : 0) +
    (splitBookColumn ? 7 : 6);

  useEffect(() => {
    const visibleIds = new Set(visibleRows.map((row) => row.id));
    setSelectedIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [visibleRows]);

  const selectedRows = visibleRows.filter((row) => selectedIds.includes(row.id));
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

  return (
    <section
      className={`detail-card processing-card processing-list-card processing-replacement-card${
        fullSpan ? " processing-card-span-full" : ""
      }${className ? ` ${className}` : ""}`}
      data-testid={`${pageId}-${cardId}-card`}
    >
      <div className="processing-card-head processing-card-head--list">
        <div className="processing-card-head-line">
          <div className="processing-card-head-meta">
            <h2>{title}</h2>
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
              disabled={busy}
            >
              <FilterIcon />
              <span>Filters</span>
              {activeFilterCount ? (
                <span className="catalog-filter-count">
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
            <span
              className="catalog-result-count"
              aria-label={`${visibleRows.length} results`}
              data-testid={`${pageId}-${cardId}-count`}
            >
              {visibleRows.length}
            </span>
          </div>
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

      {actions.length || busy ? (
        <div className="processing-bulk-bar">
          <div className="processing-bulk-status">
            {busy ? (
              <span
                className="processing-inline-loader"
                data-testid={`${pageId}-${cardId}-loader`}
              >
                <LoadingSpinner size={14} /> Working
              </span>
            ) : null}
          </div>
          {actions.length ? (
            <div className="processing-bulk-actions">
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={
                    action.danger ? "ghost-button danger-button" : "primary-button"
                  }
                  disabled={busy || selectedRows.length === 0}
                  onClick={() => runAction(action)}
                  data-testid={`${pageId}-${cardId}-${action.id}-btn`}
                >
                  {action.label}
                  {selectedRows.length ? ` (${selectedRows.length})` : ""}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="processing-table-shell">
        <table
          className="simple-table processing-table"
          data-testid={`${pageId}-${cardId}-table`}
        >
          <thead>
            <tr>
              {showSelectionColumn ? (
                <th className="processing-col-select">
                  <input
                    type="checkbox"
                    className="processing-checkbox"
                    aria-label={`Select all ${title}`}
                    checked={allSelectableSelected}
                    disabled={busy || selectableRows.length === 0}
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
              <th className="processing-col-details">{detailsLabel}</th>
              <th className="processing-col-updated">Updated</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length ? (
              visibleRows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`${pageId}-${cardId}-row-${row.id}`}
                >
                  {showSelectionColumn ? (
                    <td className="processing-col-select">
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
                      <td className="processing-col-name">
                        <div className="processing-table-primary">
                          <strong>{row.title}</strong>
                        </div>
                      </td>
                      <td className="processing-col-url">
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
                    <td className="processing-col-book-wide">
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
                  <td className="processing-col-contributors-wide">
                    <ContributorsCell row={row} />
                  </td>
                  <td className="processing-col-category">
                    {row.category || "Uncategorized"}
                  </td>
                  <td className="processing-col-status">
                    {REQUEST_STATE_LABELS[row.status] || row.status}
                  </td>
                  <td className="processing-col-details">
                    {row.details || "Ready"}
                  </td>
                  <td className="processing-col-updated">
                    {formatDate(row.updatedAt)}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={visibleColumnCount}>{emptyLabel}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function recordRow(record, request, selectable = true) {
  const status = request?.state || record.bookCreationState || "not_created";
  return {
    id: record.id,
    record,
    request,
    title: record.name,
    url: record.url,
    displayUrl: recordDisplayUrl(record),
    displayPath: record?.displayPath || "",
    category: record.category,
    writer: record.writer,
    translator: record.translator,
    publisher: record.publisher,
    status,
    updatedAt: request?.updatedAt || record.updatedAt,
    details: requestDetails(request),
    selectable,
    searchText: recordSearchText(record, request),
  };
}

function requestRow(request, record, selectable = true) {
  return {
    ...recordRow(record, request, selectable),
    id: request.id,
    request,
    status: request.state,
    updatedAt: request.updatedAt,
    details: requestDetails(request),
    searchText: recordSearchText(record, request),
  };
}

function useRequestRows(states) {
  const { requests, recordMap } = useBookProcessing();
  const allowedStates = new Set(states);
  return useMemo(
    () =>
      requests
        .filter((request) => allowedStates.has(request.state))
        .map((request) => {
          const record = recordMap.get(request.bookRecordId);
          return record ? requestRow(request, record) : null;
        })
        .filter(Boolean),
    [allowedStates, recordMap, requests],
  );
}

function AutomationPanel({
  pageId,
  title,
  automation,
  sync,
  saving = false,
  running = false,
  onSave,
  onRun,
  onPause,
  onStop,
  className = "",
}) {
  const [form, setForm] = useState({
    enabled: automation.enabled,
    interval: automation.interval,
    time: automation.time,
  });

  useEffect(() => {
    setForm({
      enabled: automation.enabled,
      interval: automation.interval,
      time: automation.time,
    });
  }, [automation.enabled, automation.interval, automation.time]);

  const runMode =
    pageId === "catalog"
      ? SYNC_RUN_MODE_CATALOG_AUTOMATION
      : SYNC_RUN_MODE_INCOMPLETE_AUTOMATION;
  const runLabel =
    pageId === "catalog"
      ? "automated catalog sync"
      : "incomplete catalog sync";
  const ownsSync = sync.status !== "idle" && sync.runMode === runMode;
  const blockedByOtherSync = sync.status !== "idle" && sync.runMode !== runMode;
  const isRunning = ownsSync && (sync.status === "syncing" || sync.status === "pausing");
  const isPausing = ownsSync && sync.status === "pausing";
  const isPaused = ownsSync && sync.status === "paused";
  const busy = saving || running;
  const controlsDisabled = busy || ownsSync || blockedByOtherSync;
  const statusMessage = ownsSync ? sync.message || "" : automation.statusMessage || "";

  const runControl = isPaused
    ? {
        label: `Stop ${runLabel}`,
        icon: <StopIcon />,
        state: "paused",
        disabled: busy,
        onClick: onStop,
      }
    : isRunning
      ? {
          label: isPausing ? `Pausing ${runLabel}` : `Pause ${runLabel}`,
          icon: <PauseIcon />,
          state: isPausing ? "pausing" : "syncing",
          disabled: busy || isPausing,
          onClick: onPause,
        }
      : {
          label: `Run ${runLabel}`,
          icon: <PlayIcon />,
          state: "idle",
          disabled: busy || blockedByOtherSync,
          onClick: onRun,
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
      {busy || statusMessage ? (
        <div className="processing-card-footer">
          <div className="processing-card-status">
            {busy || isRunning ? (
              <span
                className="processing-inline-loader"
                data-testid={`${pageId}-automation-loader`}
              >
                <LoadingSpinner size={14} />{" "}
                {saving ? "Saving" : isPausing ? "Pausing" : isRunning ? "Running" : ""}
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

function CatalogSyncPanel({ className = "" }) {
  const [pauseRequested, setPauseRequested] = useState(false);
  const {
    state,
    busyCards,
    startCatalogSync,
    pauseCatalogSync,
    resumeCatalogSync,
  } = useBookProcessing();
  const sync = state.sync;
  const syncBusy = Boolean(busyCards["catalog-sync"]);
  const manualOwnsSync =
    sync.runMode === SYNC_RUN_MODE_MANUAL && sync.status !== "idle";
  const automationOwnsSync =
    sync.runMode !== SYNC_RUN_MODE_MANUAL && sync.status !== "idle";
  const isSyncing =
    manualOwnsSync &&
    (sync.status === "syncing" || sync.status === "pausing");
  const isPausing = manualOwnsSync && (pauseRequested || sync.status === "pausing");
  const syncMessageLines = splitSyncMessage(sync.message);

  useEffect(() => {
    if (!isSyncing) {
      setPauseRequested(false);
    }
  }, [isSyncing]);

  async function handlePauseSync() {
    setPauseRequested(true);
    await pauseCatalogSync();
  }

  const control =
    sync.status === "paused"
      ? {
          testId: "catalog-sync-resume-btn",
          label: "Resume sync",
          icon: <PlayIcon />,
          state: "paused",
          disabled: syncBusy,
          onClick: resumeCatalogSync,
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
            disabled: syncBusy || automationOwnsSync,
            onClick: startCatalogSync,
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
    state,
    records,
    requests,
    busyCards,
    isRecordSelectable,
    createRequestsForRecords,
    saveCatalogAutomation,
    runCatalogAutomation,
    pauseCatalogAutomation,
    stopCatalogAutomation,
  } = useBookProcessing();
  const catalogAutomationSaving = Boolean(busyCards["catalog-automation-save"]);
  const catalogAutomationRunning = Boolean(busyCards["catalog-automation-run"]);

  const rows = useMemo(
    () =>
      records
        .map((record) =>
          recordRow(
            record,
            latestRequestForRecord(requests, record.id),
            isRecordSelectable(record),
          ),
        )
        .sort((left, right) => {
          const leftPriority = left.status === "not_created" ? 0 : 1;
          const rightPriority = right.status === "not_created" ? 0 : 1;
          return leftPriority - rightPriority;
        }),
    [isRecordSelectable, records, requests],
  );
  const activeCount = requests.filter((request) =>
    ["initial", "queued", "processing"].includes(request.state),
  ).length;
  const holdCount = requests.filter((request) =>
    ["paused", "failed", "duplicate", "deleted"].includes(request.state),
  ).length;

  return (
    <PageFrame pageId="catalog" title="Catalog">
      <OverviewPanel
        pageId="catalog"
        stats={[
          { id: "records", label: "Book Records", value: records.length },
          {
            id: "not-created",
            label: "Not Created",
            value: records.filter(
              (record) => record.bookCreationState === "not_created",
            ).length,
          },
          { id: "active", label: "Active Requests", value: activeCount },
          {
            id: "created",
            label: "Created",
            value: requests.filter((request) => request.state === "created")
              .length,
          },
          { id: "on-hold", label: "On Hold", value: holdCount },
        ]}
      />
      <div className="processing-card-grid processing-card-grid--catalog">
        <CatalogSyncPanel className="processing-catalog-sync-card" />
        <AutomationPanel
          pageId="catalog"
          title="Automation"
          automation={state.automation.catalog}
          sync={state.sync}
          saving={catalogAutomationSaving}
          running={catalogAutomationRunning}
          onSave={saveCatalogAutomation}
          onRun={runCatalogAutomation}
          onPause={pauseCatalogAutomation}
          onStop={stopCatalogAutomation}
          className="processing-catalog-automation-card"
        />
      </div>
      <ProcessingDataCard
        pageId="catalog"
        cardId="records"
        title="Book Records"
        description="Synced catalog records ready for book creation."
        rows={rows}
        busy={Boolean(busyCards["catalog-records"])}
        className="processing-catalog-card processing-catalog-records-card"
        bookColumnMode="split"
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

function CreateCard({ cardId, title, description, states, actions }) {
  const { busyCards } = useBookProcessing();
  const rows = useRequestRows(states);
  return (
    <ProcessingDataCard
      pageId="create"
      cardId={cardId}
      title={title}
      description={description}
      rows={rows}
      busy={Boolean(busyCards[`create-${cardId}`])}
      actions={actions}
    />
  );
}

export function CreateProcessingPage() {
  const { requests, deleteRequests, pauseRequests } = useBookProcessing();

  return (
    <PageFrame pageId="create" title="Create">
      <OverviewPanel
        pageId="create"
        stats={[
          {
            id: "requests",
            label: "Requests",
            value: requests.filter((request) => request.state === "initial")
              .length,
          },
          {
            id: "queue",
            label: "Queue",
            value: requests.filter((request) => request.state === "queued")
              .length,
          },
          {
            id: "processing",
            label: "Processing",
            value: requests.filter((request) => request.state === "processing")
              .length,
          },
          {
            id: "created",
            label: "Created",
            value: requests.filter((request) => request.state === "created")
              .length,
          },
        ]}
      />
      <div className="processing-card-grid">
        <CreateCard
          cardId="requests"
          title="Requests"
          description="New book creation requests."
          states={["initial"]}
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
          title="Queue"
          description="Requests waiting for the processor."
          states={["queued"]}
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
          title="Processing"
          description="Requests currently being built."
          states={["processing"]}
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
          title="Created"
          description="Completed books."
          states={["created"]}
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
  title,
  description,
  states,
  actions,
  detailsLabel,
}) {
  const { busyCards } = useBookProcessing();
  const rows = useRequestRows(states);
  return (
    <ProcessingDataCard
      pageId="on-hold"
      cardId={cardId}
      title={title}
      description={description}
      rows={rows}
      busy={Boolean(busyCards[`on-hold-${cardId}`])}
      actions={actions}
      detailsLabel={detailsLabel}
    />
  );
}

export function OnHoldProcessingPage() {
  const {
    requests,
    resumePausedRequests,
    retryFailedRequests,
    markDuplicateRequestsAsNew,
    confirmDuplicateRequests,
    createAgainRequests,
    deleteRequests,
  } = useBookProcessing();

  return (
    <PageFrame pageId="on-hold" title="On Hold">
      <OverviewPanel
        pageId="on-hold"
        stats={[
          {
            id: "paused",
            label: "Paused",
            value: requests.filter((request) => request.state === "paused")
              .length,
          },
          {
            id: "failed",
            label: "Failed",
            value: requests.filter((request) => request.state === "failed")
              .length,
          },
          {
            id: "duplicate",
            label: "Duplicate",
            value: requests.filter((request) => request.state === "duplicate")
              .length,
          },
          {
            id: "deleted",
            label: "Deleted",
            value: requests.filter((request) => request.state === "deleted")
              .length,
          },
        ]}
      />
      <div className="processing-card-grid">
        <OnHoldCard
          cardId="paused"
          title="Paused"
          description="Requests with saved progress."
          states={["paused"]}
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
          title="Failed"
          description="Requests that need retry or deletion."
          states={["failed"]}
          detailsLabel="Error Reason"
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
          title="Duplicate"
          description="Requests waiting on duplicate resolution."
          states={["duplicate"]}
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
          title="Deleted"
          description="Deleted requests available for recreation."
          states={["deleted"]}
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
    state,
    records,
    requests,
    recordMap,
    busyCards,
    saveIncompleteAutomation,
    runIncompleteAutomation,
    pauseIncompleteAutomation,
    stopIncompleteAutomation,
    recreateCompletedRequests,
    deleteRequests,
  } = useBookProcessing();
  const incompleteAutomationSaving = Boolean(
    busyCards["incomplete-automation-save"],
  );
  const incompleteAutomationRunning = Boolean(
    busyCards["incomplete-automation-run"],
  );

  const incompleteRows = useMemo(
    () =>
      records
        .filter(
          (record) =>
            (record.wasIncomplete || isIncompleteCategory(record.category)) &&
            !record.resolvedFromIncomplete,
        )
        .map((record) => recordRow(record, latestRequestForRecord(requests, record.id), false)),
    [records, requests],
  );
  const completedRows = useMemo(
    () =>
      requests
        .filter((request) => request.state === "created")
        .map((request) => {
          const record = recordMap.get(request.bookRecordId);
          if (!record?.wasIncomplete || !record.resolvedFromIncomplete) {
            return null;
          }
          return requestRow(request, record);
        })
        .filter(Boolean),
    [recordMap, requests],
  );

  return (
    <PageFrame pageId="incomplete" title="Incomplete">
      <OverviewPanel
        pageId="incomplete"
        stats={[
          {
            id: "incomplete",
            label: "Incomplete",
            value: incompleteRows.length,
          },
          {
            id: "resolved",
            label: "Updated",
            value: records.filter(
              (record) => record.wasIncomplete && record.resolvedFromIncomplete,
            ).length,
          },
        ]}
      />
      <div className="processing-card-grid">
        <AutomationPanel
          pageId="incomplete"
          title="Automation"
          automation={state.automation.incomplete}
          sync={state.sync}
          saving={incompleteAutomationSaving}
          running={incompleteAutomationRunning}
          onSave={saveIncompleteAutomation}
          onRun={runIncompleteAutomation}
          onPause={pauseIncompleteAutomation}
          onStop={stopIncompleteAutomation}
          className="processing-card-span-full processing-incomplete-automation-card"
        />
        <ProcessingDataCard
          pageId="incomplete"
          cardId="records"
          title="Incomplete"
          description="Records currently classified as incomplete."
          rows={incompleteRows}
          bookColumnMode="split"
          readOnly
        />
        <ProcessingDataCard
          pageId="incomplete"
          cardId="completed"
          title="Updated"
          description="Records resolved by incomplete automation."
          rows={completedRows}
          busy={Boolean(busyCards["incomplete-completed"])}
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
