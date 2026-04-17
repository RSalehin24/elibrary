import { useEffect, useMemo, useState } from "react";
import LoadingSpinner from "../../components/LoadingSpinner";
import {
  latestRequestForRecord,
  useBookProcessing,
} from "./BookProcessingStore";
import { REQUEST_STATE_LABELS } from "./types";

const SEARCH_PLACEHOLDER = "Search name, writer, translator, or publisher";

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
  return [
    record?.name,
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

function PageFrame({ pageId, title, children }) {
  return (
    <div className="processing-page page-stack" data-testid={`${pageId}-page`}>
      <section className="detail-card processing-page-header">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Book processing</p>
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

  return (
    <div
      className="processing-active-filters"
      data-testid={`${pageId}-${cardId}-active-filters`}
    >
      {labels.length ? `Active filters: ${labels.join(", ")}` : "No active filters"}
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
}) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const categoryOptions = useMemo(
    () => uniqueOptions(rows.map((row) => row.category)),
    [rows],
  );
  const statusOptions = useMemo(
    () => uniqueOptions(rows.map((row) => row.status)),
    [rows],
  );
  const visibleRows = useMemo(
    () => filterRows(rows, query, categoryFilter, statusFilter),
    [categoryFilter, query, rows, statusFilter],
  );

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

  return (
    <section
      className="detail-card processing-card processing-list-card processing-replacement-card"
      data-testid={`${pageId}-${cardId}-card`}
    >
      <div className="processing-card-head">
        <div className="processing-card-head-meta">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        <span
          className="processing-card-count"
          data-testid={`${pageId}-${cardId}-count`}
        >
          {visibleRows.length} {visibleRows.length === 1 ? "record" : "records"}
        </span>
      </div>

      <div className="processing-card-toolbar processing-replacement-toolbar">
        <label className="catalog-search-field">
          <span>Search</span>
          <input
            type="search"
            placeholder={SEARCH_PLACEHOLDER}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            data-testid={`${pageId}-${cardId}-search`}
          />
        </label>
        <label className="catalog-toolbar-select">
          <span>Book Category</span>
          <select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
            data-testid={`${pageId}-${cardId}-category-filter`}
          >
            <option value="">All categories</option>
            {categoryOptions.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label className="catalog-toolbar-select">
          <span>Request Status</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            data-testid={`${pageId}-${cardId}-status-filter`}
          >
            <option value="">All statuses</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {REQUEST_STATE_LABELS[status] || status}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ActiveFilters
        pageId={pageId}
        cardId={cardId}
        categoryFilter={categoryFilter}
        statusFilter={statusFilter}
      />

      {actions.length ? (
        <div className="processing-bulk-bar">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={action.danger ? "ghost-button danger-button" : "primary-button"}
              disabled={busy || selectedRows.length === 0}
              onClick={() => runAction(action)}
              data-testid={`${pageId}-${cardId}-${action.id}-btn`}
            >
              {action.label}
              {selectedRows.length ? ` (${selectedRows.length})` : ""}
            </button>
          ))}
          {busy ? (
            <span
              className="processing-inline-loader"
              data-testid={`${pageId}-${cardId}-loader`}
            >
              <LoadingSpinner size={14} /> Working
            </span>
          ) : null}
        </div>
      ) : busy ? (
        <div className="processing-bulk-bar">
          <span
            className="processing-inline-loader"
            data-testid={`${pageId}-${cardId}-loader`}
          >
            <LoadingSpinner size={14} /> Working
          </span>
        </div>
      ) : null}

      <div className="processing-table-shell">
        <table
          className="simple-table processing-table"
          data-testid={`${pageId}-${cardId}-table`}
        >
          <thead>
            <tr>
              <th className="processing-col-select">
                {!readOnly ? (
                  <input
                    type="checkbox"
                    className="processing-checkbox"
                    aria-label={`Select all ${title}`}
                    checked={allSelectableSelected}
                    disabled={busy || selectableRows.length === 0}
                    onChange={(event) => toggleAll(event.target.checked)}
                    data-testid={`${pageId}-${cardId}-select-all`}
                  />
                ) : null}
              </th>
              <th>Book</th>
              <th>Category</th>
              <th>Writer</th>
              <th>Translator</th>
              <th>Publisher</th>
              <th>Status</th>
              <th>{detailsLabel}</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length ? (
              visibleRows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`${pageId}-${cardId}-row-${row.id}`}
                >
                  <td className="processing-col-select">
                    {!readOnly ? (
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
                    ) : null}
                  </td>
                  <td>
                    <strong>{row.title}</strong>
                    {row.url ? <span>{row.url}</span> : null}
                  </td>
                  <td>{row.category || "Uncategorized"}</td>
                  <td>{row.writer || "Unknown"}</td>
                  <td>{row.translator || "None"}</td>
                  <td>{row.publisher || "Unknown"}</td>
                  <td>{REQUEST_STATE_LABELS[row.status] || row.status}</td>
                  <td>{row.details || "Ready"}</td>
                  <td>{formatDate(row.updatedAt)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={9}>{emptyLabel}</td>
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
  description,
  automation,
  busy,
  onSave,
  onRun,
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

  return (
    <section
      className="detail-card processing-card processing-replacement-card"
      data-testid={`${pageId}-automation-card`}
    >
      <div className="processing-card-head">
        <div className="processing-card-head-meta">
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {busy ? (
          <span
            className="processing-inline-loader"
            data-testid={`${pageId}-automation-loader`}
          >
            <LoadingSpinner size={14} /> Saving
          </span>
        ) : null}
      </div>
      <div className="processing-automation-grid">
        <label className="processing-switch">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={busy}
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
              {form.enabled ? "Enabled" : "Disabled"}
            </span>
            <span className="processing-switch-thumb" />
          </span>
        </label>
        <label>
          Interval
          <select
            value={form.interval}
            disabled={busy}
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
        </label>
        <label>
          Time
          <input
            type="time"
            value={form.time}
            disabled={busy}
            onChange={(event) =>
              setForm((current) => ({ ...current, time: event.target.value }))
            }
            data-testid={`${pageId}-automation-time`}
          />
        </label>
      </div>
      <div className="processing-card-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={() => onSave(form)}
          data-testid={`${pageId}-automation-save-btn`}
        >
          Save Settings
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={busy}
          onClick={onRun}
          data-testid={`${pageId}-automation-run-btn`}
        >
          Run Automation
        </button>
        <span
          className="processing-automation-status"
          data-testid={`${pageId}-automation-status`}
        >
          {automation.statusMessage || (automation.saved ? "Saved." : "Not configured.")}
        </span>
      </div>
    </section>
  );
}

function CatalogSyncPanel() {
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
  const isSyncing = syncBusy || sync.status === "syncing" || sync.status === "pausing";
  const isPausing = pauseRequested || sync.status === "pausing";

  useEffect(() => {
    if (!isSyncing) {
      setPauseRequested(false);
    }
  }, [isSyncing]);

  async function handlePauseSync() {
    setPauseRequested(true);
    await pauseCatalogSync();
  }

  return (
    <section className="detail-card processing-card processing-replacement-card">
      <div className="processing-card-head">
        <div className="processing-card-head-meta">
          <h2>Manual Syncing</h2>
          <p>Fetch source catalog records and reconcile them with local records.</p>
        </div>
        {isSyncing ? (
          <span
            className="processing-inline-loader"
            data-testid="catalog-sync-loader"
          >
            <LoadingSpinner size={14} /> Syncing
          </span>
        ) : null}
      </div>
      <div className="processing-card-actions">
        <button
          type="button"
          className="primary-button"
          disabled={isSyncing}
          onClick={startCatalogSync}
          data-testid="catalog-sync-start-btn"
        >
          Start Sync
        </button>
        {isSyncing ? (
          <button
            type="button"
            className="ghost-button"
            disabled={isPausing}
            onClick={handlePauseSync}
            data-testid="catalog-sync-pause-btn"
          >
            {isPausing ? "Pausing..." : "Pause"}
          </button>
        ) : null}
        {sync.status === "paused" ? (
          <button
            type="button"
            className="ghost-button"
            onClick={resumeCatalogSync}
            data-testid="catalog-sync-resume-btn"
          >
            Resume
          </button>
        ) : null}
        <span
          className="catalog-toolbar-sync-status"
          data-testid="catalog-sync-progress"
        >
          {sync.message}
        </span>
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
  } = useBookProcessing();

  const rows = useMemo(
    () =>
      records.map((record) =>
        recordRow(
          record,
          latestRequestForRecord(requests, record.id),
          isRecordSelectable(record),
        ),
      ),
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
      <CatalogSyncPanel />
      <AutomationPanel
        pageId="catalog"
        title="Automated Syncing"
        description="Save the schedule and run the same reconciliation used by manual sync."
        automation={state.automation.catalog}
        busy={Boolean(busyCards["catalog-automation"])}
        onSave={saveCatalogAutomation}
        onRun={runCatalogAutomation}
      />
      <ProcessingDataCard
        pageId="catalog"
        cardId="records"
        title="Book Records"
        description="Synced catalog records ready for book creation."
        rows={rows}
        busy={Boolean(busyCards["catalog-records"])}
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
    recreateCompletedRequests,
    deleteRequests,
  } = useBookProcessing();

  const incompleteRows = useMemo(
    () =>
      records
        .filter(
          (record) =>
            normalizeText(record.category) === "incomplete" &&
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
            label: "Resolved",
            value: records.filter(
              (record) => record.wasIncomplete && record.resolvedFromIncomplete,
            ).length,
          },
        ]}
      />
      <AutomationPanel
        pageId="incomplete"
        title="Automation Settings"
        description="Detect incomplete records that moved into a completed category."
        automation={state.automation.incomplete}
        busy={Boolean(busyCards["incomplete-automation"])}
        onSave={saveIncompleteAutomation}
        onRun={runIncompleteAutomation}
      />
      <ProcessingDataCard
        pageId="incomplete"
        cardId="records"
        title="Incomplete Book Records"
        description="Records currently classified as incomplete."
        rows={incompleteRows}
        readOnly
      />
      <ProcessingDataCard
        pageId="incomplete"
        cardId="completed"
        title="Completed Books"
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
    </PageFrame>
  );
}
