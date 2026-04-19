import {
  useCallback,
  useDeferredValue,
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
const SYNC_RUN_MODE_MANUAL = "manual";
const SYNC_RUN_MODE_CATALOG_AUTOMATION = "catalog_automation";
const SYNC_RUN_MODE_INCOMPLETE_AUTOMATION = "incomplete_automation";

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

function processingTablePath({
  cardKey,
  query,
  category,
  status,
  offset,
  limit,
}) {
  const params = new URLSearchParams({
    card: cardKey,
    offset: String(offset),
    limit: String(limit),
  });
  if (query) {
    params.set("q", query);
  }
  if (category) {
    params.set("category", category);
  }
  if (status) {
    params.set("status", status);
  }
  return `/processing/table/?${params.toString()}`;
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
      className={`processing-skeleton-row${
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

function useProcessingTableData({ cardKey, filters, enabled, stateVersion }) {
  const [tableState, setTableState] = useState({
    rows: [],
    totalCount: 0,
    categoryOptions: [],
    statusOptions: [],
    hasMore: false,
    loadedOnce: false,
    initialLoading: false,
    loadingMore: false,
    refreshing: false,
    error: "",
  });
  const tableShellRef = useRef(null);
  const observerRef = useRef(null);
  const requestSeqRef = useRef(0);
  const deferredQuery = useDeferredValue(filters.q);

  const loadRows = useCallback(
    async ({
      offset = 0,
      limit = PROCESSING_TABLE_BATCH_SIZE,
      append = false,
      preserveRows = false,
    } = {}) => {
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;

      setTableState((current) => ({
        ...current,
        initialLoading: !append && !preserveRows && !current.loadedOnce,
        loadingMore: append,
        refreshing: !append && (preserveRows || current.loadedOnce),
        error: "",
        rows: append || preserveRows || current.loadedOnce ? current.rows : [],
        totalCount:
          append || preserveRows || current.loadedOnce ? current.totalCount : 0,
      }));

      try {
        const payload = await apiFetch(
          processingTablePath({
            cardKey,
            query: deferredQuery,
            category: filters.category,
            status: filters.status,
            offset,
            limit,
          }),
        );
        if (requestSeqRef.current !== requestSeq) {
          return null;
        }

        const nextRows = Array.isArray(payload?.rows) ? payload.rows : [];
        const nextPagination = payload?.pagination || {};
        const nextFilters = payload?.filters || {};

        setTableState((current) => ({
          rows: append ? [...current.rows, ...nextRows] : nextRows,
          totalCount: Number(nextPagination.totalCount) || 0,
          categoryOptions: Array.isArray(nextFilters.categoryOptions)
            ? nextFilters.categoryOptions
            : [],
          statusOptions: Array.isArray(nextFilters.statusOptions)
            ? nextFilters.statusOptions
            : [],
          hasMore: Boolean(nextPagination.hasMore),
          loadedOnce: true,
          initialLoading: false,
          loadingMore: false,
          refreshing: false,
          error: "",
        }));
        return payload;
      } catch (nextError) {
        if (requestSeqRef.current !== requestSeq) {
          return null;
        }
        setTableState((current) => ({
          ...current,
          rows:
            append || preserveRows || current.loadedOnce ? current.rows : [],
          totalCount:
            append || preserveRows || current.loadedOnce
              ? current.totalCount
              : 0,
          loadedOnce: true,
          initialLoading: false,
          loadingMore: false,
          refreshing: false,
          error: nextError.message || "Unable to load records.",
        }));
        return null;
      }
    },
    [cardKey, deferredQuery, filters.category, filters.status],
  );

  const refreshRows = useCallback(
    async ({ preserveLoadedRows = true } = {}) => {
      const nextLimit = preserveLoadedRows
        ? Math.max(PROCESSING_TABLE_BATCH_SIZE, tableState.rows.length || 0)
        : PROCESSING_TABLE_BATCH_SIZE;
      return loadRows({
        offset: 0,
        limit: nextLimit,
        append: false,
        preserveRows: preserveLoadedRows && tableState.rows.length > 0,
      });
    },
    [loadRows, tableState.rows.length],
  );

  const loadMore = useCallback(async () => {
    if (
      !enabled ||
      tableState.initialLoading ||
      tableState.loadingMore ||
      !tableState.hasMore
    ) {
      return null;
    }

    return loadRows({
      offset: tableState.rows.length,
      limit: PROCESSING_TABLE_BATCH_SIZE,
      append: true,
    });
  }, [
    enabled,
    loadRows,
    tableState.hasMore,
    tableState.initialLoading,
    tableState.loadingMore,
    tableState.rows.length,
  ]);

  const observeLoadTrigger = useCallback(
    (node) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      if (
        !node ||
        !enabled ||
        tableState.initialLoading ||
        tableState.loadingMore ||
        !tableState.hasMore
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
      loadMore,
      tableState.hasMore,
      tableState.initialLoading,
      tableState.loadingMore,
    ],
  );

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    loadRows({
      offset: 0,
      limit: PROCESSING_TABLE_BATCH_SIZE,
      append: false,
      preserveRows: false,
    });
    return undefined;
  }, [
    enabled,
    cardKey,
    deferredQuery,
    filters.category,
    filters.status,
    loadRows,
  ]);

  useEffect(() => {
    if (!enabled || !tableState.loadedOnce) {
      return undefined;
    }
    loadRows({
      offset: 0,
      limit: Math.max(PROCESSING_TABLE_BATCH_SIZE, tableState.rows.length),
      append: false,
      preserveRows: tableState.rows.length > 0,
    });
    return undefined;
  }, [
    enabled,
    loadRows,
    stateVersion,
    tableState.loadedOnce,
    tableState.rows.length,
  ]);

  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, []);

  return {
    ...tableState,
    refreshRows,
    loadMore,
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
}) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [filters, setFilters] = useState({
    q: "",
    category: "",
    status: "",
  });
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const { canLoadProcessingState, stateVersion } = useBookProcessing();
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
    refreshRows,
    tableShellRef,
    observeLoadTrigger,
  } = useProcessingTableData({
    cardKey,
    filters,
    enabled: canLoadProcessingState,
    stateVersion,
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
  const visibleRows = rows;
  const visibleColumnCount =
    (showSelectionColumn ? 1 : 0) +
    (splitBookColumn ? 6 : 5) +
    (showDetailsColumn ? 1 : 0) +
    (showActionColumn ? 1 : 0);
  const showInitialTableSkeleton = initialLoading && !loadedOnce;
  const showRefreshSkeletonRows =
    (loadingMore || refreshing) && visibleRows.length > 0;

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
      await refreshRows();
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
            <span
              className="catalog-result-count"
              aria-label={`${totalCount} results`}
              data-testid={`${pageId}-${cardId}-count`}
            >
              {showInitialTableSkeleton ? (
                <ProcessingCountSkeleton />
              ) : (
                totalCount
              )}
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
                    action.danger
                      ? "ghost-button danger-button"
                      : "primary-button"
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
          ) : null}
        </div>
      ) : null}

      <div
        ref={tableShellRef}
        className="processing-table-shell"
        aria-busy={initialLoading || loadingMore || refreshing}
      >
        <table
          className="simple-table processing-table"
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
                  {showDetailsColumn ? (
                    <td className="processing-col-details">
                      {requestDetails(row) || "Ready"}
                    </td>
                  ) : null}
                  <td className="processing-col-updated">
                    {formatDate(row.updatedAt)}
                  </td>
                  {showActionColumn ? (
                    <td className="processing-col-action">
                      {renderRowAction(row) || (
                        <span className="processing-table-muted">-</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={visibleColumnCount}>{tableError || emptyLabel}</td>
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
  automation,
  sync,
  loading = false,
  saving = false,
  running = false,
  onSave,
  onRun,
  onPause,
  onResume,
  onStop,
  className = "",
}) {
  const [form, setForm] = useState({
    enabled: automation.enabled,
    interval: automation.interval,
    time: automation.time,
  });
  const runMode =
    pageId === "catalog"
      ? SYNC_RUN_MODE_CATALOG_AUTOMATION
      : SYNC_RUN_MODE_INCOMPLETE_AUTOMATION;
  const runLabel =
    pageId === "catalog" ? "automated catalog sync" : "incomplete catalog sync";
  const ownsSync = sync.status !== "idle" && sync.runMode === runMode;
  const blockedByOtherSync = sync.status !== "idle" && sync.runMode !== runMode;
  const isRunning =
    ownsSync && (sync.status === "syncing" || sync.status === "pausing");
  const isPausing = ownsSync && sync.status === "pausing";
  const isPaused = ownsSync && sync.status === "paused";
  const busy = saving || running;
  const controlsDisabled = busy || ownsSync || blockedByOtherSync;
  const statusMessage = ownsSync
    ? sync.message || ""
    : automation.statusMessage || "";
  const showFooter = busy || Boolean(statusMessage);

  useEffect(() => {
    setForm({
      enabled: automation.enabled,
      interval: automation.interval,
      time: automation.time,
    });
  }, [automation.enabled, automation.interval, automation.time]);

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
          pageId === "catalog"
            ? "Resume automated catalog sync"
            : "Resume incomplete catalog sync",
        icon: <PlayIcon />,
        state: "paused",
        disabled: busy,
        onClick: onResume,
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
                {saving
                  ? "Saving"
                  : isPausing
                    ? "Pausing"
                    : isRunning
                      ? "Running"
                      : ""}
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

function CatalogSyncPanel({ className = "", loading = false }) {
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
    manualOwnsSync && (sync.status === "syncing" || sync.status === "pausing");
  const isPausing =
    manualOwnsSync && (pauseRequested || sync.status === "pausing");
  const syncMessageLines = splitSyncMessage(sync.message);

  useEffect(() => {
    if (!isSyncing) {
      setPauseRequested(false);
    }
  }, [isSyncing]);

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
    busyCards,
    loaded,
    createRequestsForRecords,
    saveCatalogAutomation,
    runCatalogAutomation,
    pauseCatalogAutomation,
    resumeCatalogAutomation,
    stopCatalogAutomation,
  } = useBookProcessing();
  const catalogAutomationSaving = Boolean(busyCards["catalog-automation-save"]);
  const catalogAutomationRunning = Boolean(busyCards["catalog-automation-run"]);
  const summary = state.summary?.catalog || {};

  return (
    <PageFrame pageId="catalog" title="Catalog">
      <OverviewPanel
        pageId="catalog"
        loading={!loaded}
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
          loading={!loaded}
        />
        <AutomationPanel
          pageId="catalog"
          title="Automation"
          automation={state.automation.catalog}
          sync={state.sync}
          loading={!loaded}
          saving={catalogAutomationSaving}
          running={catalogAutomationRunning}
          onSave={saveCatalogAutomation}
          onRun={runCatalogAutomation}
          onPause={pauseCatalogAutomation}
          onResume={resumeCatalogAutomation}
          onStop={stopCatalogAutomation}
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
      className="processing-create-card"
      showDetailsColumn={false}
      actions={actions}
      actionLabel={actionLabel}
      renderRowAction={renderRowAction}
    />
  );
}

export function CreateProcessingPage() {
  const { state, loaded, deleteRequests, pauseRequests } = useBookProcessing();
  const summary = state.summary?.create || {};

  return (
    <PageFrame pageId="create" title="Create">
      <OverviewPanel
        pageId="create"
        loading={!loaded}
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
      actions={actions}
      detailsLabel={detailsLabel}
      className={className}
    />
  );
}

export function OnHoldProcessingPage() {
  const {
    state,
    loaded,
    resumePausedRequests,
    retryFailedRequests,
    markDuplicateRequestsAsNew,
    confirmDuplicateRequests,
    createAgainRequests,
    deleteRequests,
  } = useBookProcessing();
  const summary = state.summary?.onHold || {};

  return (
    <PageFrame pageId="on-hold" title="On Hold">
      <OverviewPanel
        pageId="on-hold"
        loading={!loaded}
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
    state,
    busyCards,
    loaded,
    saveIncompleteAutomation,
    runIncompleteAutomation,
    pauseIncompleteAutomation,
    resumeIncompleteAutomation,
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
  const summary = state.summary?.incomplete || {};

  return (
    <PageFrame pageId="incomplete" title="Incomplete">
      <OverviewPanel
        pageId="incomplete"
        loading={!loaded}
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
          automation={state.automation.incomplete}
          sync={state.sync}
          loading={!loaded}
          saving={incompleteAutomationSaving}
          running={incompleteAutomationRunning}
          onSave={saveIncompleteAutomation}
          onRun={runIncompleteAutomation}
          onPause={pauseIncompleteAutomation}
          onResume={resumeIncompleteAutomation}
          onStop={stopIncompleteAutomation}
          className="processing-card-span-full processing-incomplete-automation-card"
        />
        <ProcessingDataCard
          pageId="incomplete"
          cardId="records"
          cardKey="incomplete-records"
          title="Incomplete"
          description="Records currently classified as incomplete."
          bookColumnMode="split"
          readOnly
        />
        <ProcessingDataCard
          pageId="incomplete"
          cardId="completed"
          cardKey="incomplete-completed"
          title="Updated"
          description="Records resolved by incomplete automation."
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
