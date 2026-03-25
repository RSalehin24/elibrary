import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import CatalogToolbar, { CatalogSearchRow } from "../components/CatalogToolbar";
import ConfirmationDialog from "../components/ConfirmationDialog";
import EmptyState from "../components/EmptyState";
import LoadingSpinner from "../components/LoadingSpinner";
import StatusPill from "../components/StatusPill";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import { formatBookDateTime } from "../utils/bookPresentation";
import { hasCapability } from "../utils/capabilities";
import { toQueryString } from "../utils/query";

const USER_TAB = "user";
const SOURCE_TAB = "source";
const AUTOMATION_TAB = "automation";
const ALL_TAB = "all";

function normalizeQueueTab(tab, canManageProcessing) {
  const allowedTabs = canManageProcessing
    ? [USER_TAB, SOURCE_TAB, AUTOMATION_TAB, ALL_TAB]
    : [USER_TAB];
  return allowedTabs.includes(tab) ? tab : USER_TAB;
}

const defaultSubmissionFilters = {
  q: "",
  status: "",
  review_state: "",
  resolution_status: "",
  input_type: "",
};

const defaultJobFilters = {
  q: "",
  status: "",
  submission_status: "",
  job_type: "",
};

const defaultCatalogFilters = {
  q: "",
  status: "",
  sort: "status_recent",
  page: 1,
  limit: 180,
};

const defaultCatalogPagination = {
  page: 1,
  limit: 180,
  total_count: 0,
  page_count: 1,
  has_previous: false,
  has_next: false,
};

const defaultRunFilters = {
  q: "",
  status: "",
  mode: "",
};

const defaultReviewFilters = {
  q: "",
  status: "",
};

const defaultCatalogSummary = {
  total: 0,
  new: 0,
  processing: 0,
  unfinished: 0,
  failed: 0,
  ready: 0,
  deleted: 0,
};

const submissionFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "pending_resolution", label: "Resolving" },
      { value: "queued", label: "Queued" },
      { value: "processing", label: "Processing" },
      { value: "needs_review", label: "Needs review" },
      { value: "ready", label: "Ready" },
      { value: "failed", label: "Failed" },
      { value: "cancelled", label: "Stopped" },
      { value: "duplicate", label: "Duplicate" },
    ],
  },
  {
    key: "review_state",
    label: "Review",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "pending", label: "Pending" },
      { value: "needs_review", label: "Needs review" },
      { value: "approved", label: "Approved" },
      { value: "rejected", label: "Rejected" },
    ],
  },
  {
    key: "resolution_status",
    label: "Match",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "resolved", label: "Resolved" },
      { value: "exact_match", label: "Exact match" },
      { value: "ambiguous", label: "Ambiguous" },
      { value: "invalid", label: "Invalid" },
      { value: "unresolved", label: "Unresolved" },
    ],
  },
  {
    key: "input_type",
    label: "Input",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "url", label: "URL" },
      { value: "title", label: "Title" },
      { value: "csv", label: "CSV" },
    ],
  },
];

const jobFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "queued", label: "Queued" },
      { value: "processing", label: "Processing" },
      { value: "failed", label: "Failed" },
      { value: "cancelled", label: "Stopped" },
      { value: "succeeded", label: "Complete" },
    ],
  },
  {
    key: "submission_status",
    label: "Request",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "queued", label: "Queued" },
      { value: "processing", label: "Processing" },
      { value: "needs_review", label: "Needs review" },
      { value: "failed", label: "Failed" },
      { value: "ready", label: "Ready" },
      { value: "cancelled", label: "Stopped" },
    ],
  },
  {
    key: "job_type",
    label: "Step",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "ingestion", label: "Create" },
      { value: "resolution", label: "Match" },
      { value: "reprocess", label: "Regenerate" },
    ],
  },
];

const catalogFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "new", label: "New" },
      { value: "processing", label: "Processing" },
      { value: "failed", label: "Failed" },
      { value: "unfinished", label: "Unfinished" },
      { value: "ready", label: "Ready" },
      { value: "deleted", label: "Deleted" },
    ],
  },
];

const runFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "queued", label: "Queued" },
      { value: "processing", label: "Processing" },
      { value: "failed", label: "Failed" },
      { value: "cancelled", label: "Stopped" },
      { value: "succeeded", label: "Complete" },
    ],
  },
  {
    key: "mode",
    label: "Mode",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "pending", label: "New + unfinished" },
      { value: "all", label: "All tracked" },
    ],
  },
];

const reviewFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "pending", label: "Pending" },
      { value: "confirmed", label: "Confirmed" },
      { value: "dismissed", label: "Dismissed" },
      { value: "merged", label: "Merged" },
    ],
  },
];

function normalizeTimeInput(value) {
  return (value || "02:00:00").slice(0, 5);
}

function getOriginForTab(tab) {
  if (tab === SOURCE_TAB) {
    return "curation";
  }
  if (tab === AUTOMATION_TAB) {
    return "automation";
  }
  if (tab === USER_TAB) {
    return "user";
  }
  return "";
}

function isActiveStatus(value) {
  return ["queued", "processing"].includes(value);
}

function isCatalogSyncActive(value) {
  return ["queued", "processing"].includes(value);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function toggleSelectedId(currentIds, id) {
  return currentIds.includes(id)
    ? currentIds.filter((currentId) => currentId !== id)
    : [...currentIds, id];
}

function toggleVisibleSelection(currentIds, visibleIds, allSelected) {
  const nextIds = new Set(currentIds);
  if (allSelected) {
    visibleIds.forEach((id) => nextIds.delete(id));
  } else {
    visibleIds.forEach((id) => nextIds.add(id));
  }
  return Array.from(nextIds);
}

function selectedActionLabel(label, count) {
  return count ? `${label} (${count})` : label;
}

function isUrlValue(value) {
  return (value || "").trim().startsWith("http");
}

function getRequestPrimaryText(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return "-";
  }
  if (!isUrlValue(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const path = safeDecode(url.pathname).replace(/^\/+|\/+$/g, "");
    const label = path
      .replace(/^books\//, "")
      .replace(/-/g, " ")
      .trim();
    return label || safeDecode(trimmed);
  } catch {
    return safeDecode(trimmed);
  }
}

function getRequestSecondaryText(value) {
  const trimmed = (value || "").trim();
  if (!trimmed || !isUrlValue(trimmed)) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    return `${url.hostname.replace(/^www\./, "")}${safeDecode(url.pathname)}`;
  } catch {
    return safeDecode(trimmed);
  }
}

function jobTypeLabel(jobType) {
  if (jobType === "ingestion") {
    return "Create";
  }
  if (jobType === "resolution") {
    return "Match";
  }
  if (jobType === "reprocess") {
    return "Regenerate";
  }
  return jobType;
}

function runTypeLabel(run) {
  return run.trigger === "scheduled" ? "Scheduled" : "Manual";
}

function runModeLabel(mode) {
  return mode === "all" ? "All tracked" : "New + unfinished";
}

function runSummaryLabel(run) {
  const summary = run.summary || {};
  return [
    `${summary.queued_creates || 0} create`,
    `${summary.queued_updates || 0} update`,
    `${summary.skipped_ready || 0} ready`,
  ].join(" · ");
}

function summarizeResponse(payload, labels) {
  const parts = Object.entries(labels)
    .map(([key, label]) => {
      const value = payload?.[key];
      return typeof value === "number" && value ? `${value} ${label}` : "";
    })
    .filter(Boolean);

  return parts.join(" · ");
}

function getSubmissionActivityAt(submission) {
  return (
    submission.latest_job?.finished_at ||
    submission.latest_job?.started_at ||
    submission.latest_job?.updated_at ||
    submission.updated_at ||
    submission.created_at
  );
}

function getJobActivityAt(job) {
  return job.finished_at || job.started_at || job.updated_at || job.created_at;
}

function getRunActivityAt(run) {
  return run.finished_at || run.started_at || run.updated_at || run.created_at;
}

function getCatalogEntryActivityAt(entry) {
  return entry.activity_at || entry.updated_at || entry.last_seen_at;
}

function getCatalogPageLabel(pagination) {
  const currentPage = pagination?.page || 1;
  const pageCount = pagination?.page_count || 1;
  return `Page ${currentPage} / ${pageCount}`;
}

function canCreateCatalogEntry(entry) {
  return ["new", "failed", "unfinished", "deleted"].includes(
    entry.curation_status,
  );
}

function RequestValue({ value, error }) {
  const primary = getRequestPrimaryText(value);
  const secondary = getRequestSecondaryText(value);

  return (
    <div className="table-cell-stack table-request-cell">
      <strong>{primary}</strong>
      {secondary ? <span className="table-note">{secondary}</span> : null}
      {error ? <span className="processing-row-error">{error}</span> : null}
    </div>
  );
}

function BookLinkCell({ submission }) {
  if (submission.linked_book_deleted) {
    return (
      <span className="table-note">
        {submission.linked_book?.title || "Deleted record"}
      </span>
    );
  }

  if (!submission.linked_book_slug) {
    return <span className="table-note">-</span>;
  }

  return (
    <Link to={`/books/${submission.linked_book_slug}`} className="meta-link">
      {submission.linked_book?.title || submission.linked_book_slug}
    </Link>
  );
}

function CatalogRefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M20 5v5h-5M4 19v-5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 10a8 8 0 0 0-13.66-5.66L4 6.5M4 14a8 8 0 0 0 13.66 5.66L20 17.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CatalogStopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect
        x="6.5"
        y="6.5"
        width="11"
        height="11"
        rx="2.5"
        fill="currentColor"
      />
    </svg>
  );
}

function renderProcessingCardLoader(label) {
  const screenReaderLabel = label || "Loading";
  return (
    <div
      className="processing-inline-loader"
      role="status"
      aria-live="polite"
      aria-label={screenReaderLabel}
    >
      <LoadingSpinner size={16} />
      <span>Loading...</span>
    </div>
  );
}

function QueueTableCard({
  title,
  count,
  headerAside,
  toolbar,
  actions,
  children,
  emptyTitle,
  cardClassName = "",
  loading = false,
  loadingLabel = "",
}) {
  const titleBlock = (
    <div className="section-title-block">
      <h2>{title}</h2>
    </div>
  );
  const countPill =
    count !== undefined && count !== null ? (
      <span className="processing-card-count">{count}</span>
    ) : null;
  const shellContent = loading
    ? renderProcessingCardLoader(
        loadingLabel || `Loading ${title.toLowerCase()}`,
      )
    : children || <EmptyState title={emptyTitle} />;

  return (
    <section
      className={`detail-card processing-card processing-list-card ${cardClassName}`.trim()}
    >
      <div className="processing-card-head">
        {headerAside ? (
          <div className="processing-card-head-meta">
            {titleBlock}
            {countPill}
          </div>
        ) : (
          titleBlock
        )}
        {headerAside ? null : countPill}
        {headerAside ? (
          <div className="processing-card-head-aside">{headerAside}</div>
        ) : null}
      </div>
      {toolbar ? (
        <div className="processing-card-toolbar">{toolbar}</div>
      ) : null}
      {actions ? <div className="processing-bulk-bar">{actions}</div> : null}
      <div className={`processing-table-shell${loading ? " is-loading" : ""}`}>
        {shellContent}
      </div>
    </section>
  );
}

export default function QueuePage() {
  const { user } = useSession();
  const toast = useToast();
  const canManageProcessing = hasCapability(user, "processing:manage");
  const [searchParams, setSearchParams] = useSearchParams();

  const [activeTab, setActiveTab] = useState(() =>
    normalizeQueueTab(searchParams.get("tab"), false),
  );
  const [jobs, setJobs] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [duplicateReviews, setDuplicateReviews] = useState([]);
  const [catalogEntries, setCatalogEntries] = useState([]);
  const [curationRuns, setCurationRuns] = useState([]);
  const [catalogSyncState, setCatalogSyncState] = useState(null);
  const [catalogPagination, setCatalogPagination] = useState(
    defaultCatalogPagination,
  );
  const [catalogSummary, setCatalogSummary] = useState(defaultCatalogSummary);
  const [submissionFilters, setSubmissionFilters] = useState(
    defaultSubmissionFilters,
  );
  const [jobFilters, setJobFilters] = useState(defaultJobFilters);
  const [catalogFilters, setCatalogFilters] = useState(defaultCatalogFilters);
  const [runFilters, setRunFilters] = useState(defaultRunFilters);
  const [reviewFilters, setReviewFilters] = useState(defaultReviewFilters);
  const [submissionFiltersExpanded, setSubmissionFiltersExpanded] =
    useState(false);
  const [jobFiltersExpanded, setJobFiltersExpanded] = useState(false);
  const [catalogFiltersExpanded, setCatalogFiltersExpanded] = useState(false);
  const [runFiltersExpanded, setRunFiltersExpanded] = useState(false);
  const [reviewFiltersExpanded, setReviewFiltersExpanded] = useState(false);
  const [selectedSubmissionIds, setSelectedSubmissionIds] = useState([]);
  const [selectedJobIds, setSelectedJobIds] = useState([]);
  const [selectedCatalogEntryIds, setSelectedCatalogEntryIds] = useState([]);
  const [selectedRunIds, setSelectedRunIds] = useState([]);
  const [automationState, setAutomationState] = useState(null);
  const [automationForm, setAutomationForm] = useState({
    enabled: false,
    daily_run_time: "02:00",
    frequency: "daily",
    mode: "pending",
    refresh_max_pages: "80",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reviewSubmission, setReviewSubmission] = useState(null);
  const [creatingCatalog, setCreatingCatalog] = useState(false);
  const [catalogActionMode, setCatalogActionMode] = useState("");
  const [savingAutomation, setSavingAutomation] = useState(false);
  const [busyActionId, setBusyActionId] = useState("");
  const [busyRunId, setBusyRunId] = useState("");
  const [busyDeleteId, setBusyDeleteId] = useState("");
  const [bulkActionKey, setBulkActionKey] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [stoppingCatalogSync, setStoppingCatalogSync] = useState(false);
  const [catalogSyncDismissed, setCatalogSyncDismissed] = useState(false);

  const tabs = useMemo(
    () =>
      canManageProcessing
        ? [
            { id: USER_TAB, label: "My Requests" },
            { id: SOURCE_TAB, label: "Catalog Books" },
            { id: AUTOMATION_TAB, label: "Automation" },
            { id: ALL_TAB, label: "All Activity" },
          ]
        : [{ id: USER_TAB, label: "My Requests" }],
    [canManageProcessing],
  );

  function applyActiveTab(nextTab, options = {}) {
    const { replace = false } = options;
    const normalizedTab = normalizeQueueTab(nextTab, canManageProcessing);
    setActiveTab(normalizedTab);

    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", normalizedTab);
    setSearchParams(nextParams, { replace });
  }

  useEffect(() => {
    const normalizedTab = normalizeQueueTab(
      searchParams.get("tab"),
      canManageProcessing,
    );
    if (activeTab !== normalizedTab) {
      setActiveTab(normalizedTab);
      return;
    }

    if (searchParams.get("tab") !== normalizedTab) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("tab", normalizedTab);
      setSearchParams(nextParams, { replace: true });
    }
  }, [activeTab, canManageProcessing, searchParams, setSearchParams]);
  const catalogSyncActive = isCatalogSyncActive(catalogSyncState?.status);
  const refreshingCatalog = catalogSyncActive && !catalogSyncDismissed;
  const automationRunning = isActiveStatus(automationState?.latest_run?.status);
  const sourceTabButtonsDisabled =
    activeTab === SOURCE_TAB && refreshingCatalog;
  const catalogActionsDisabled = refreshingCatalog || automationRunning;
  const creationActionsDisabled = sourceTabButtonsDisabled || automationRunning;
  const catalogActionDisabledReason = automationRunning
    ? "Disabled while scheduled automation is syncing the catalog and creating books."
    : refreshingCatalog
      ? "Disabled while catalog sync is running."
      : "";

  async function load(options = {}) {
    const {
      nextTab = activeTab,
      nextJobFilters = jobFilters,
      nextSubmissionFilters = submissionFilters,
      nextCatalogFilters = catalogFilters,
      nextRunFilters = runFilters,
      nextReviewFilters = reviewFilters,
      preserveAutomationForm = false,
      silent = false,
    } = options;

    if (!silent) {
      setLoading(true);
    }

    try {
      const origin = getOriginForTab(nextTab);
      const nextJobsParams = { ...nextJobFilters, limit: 60 };
      const nextSubmissionParams = { ...nextSubmissionFilters, limit: 60 };
      const nextReviewParams = { ...nextReviewFilters, limit: 40 };
      const nextRunParams = { ...nextRunFilters, limit: 20 };

      if (origin) {
        nextJobsParams.origin = origin;
        nextSubmissionParams.origin = origin;
        nextReviewParams.origin = origin;
      }

      if (nextTab === AUTOMATION_TAB) {
        nextRunParams.trigger = "scheduled";
      }

      const requests = [
        apiFetch(`/ingestion/jobs/${toQueryString(nextJobsParams)}`),
        apiFetch(
          `/ingestion/submissions/${toQueryString(nextSubmissionParams)}`,
        ),
      ];

      if (canManageProcessing) {
        requests.push(
          apiFetch(
            `/ingestion/duplicate-reviews/${toQueryString(nextReviewParams)}`,
          ),
        );

        if (nextTab === SOURCE_TAB) {
          requests.push(
            apiFetch(
              `/ingestion/catalog/entries/${toQueryString({ ...nextCatalogFilters, limit: 180 })}`,
            ),
          );
        }

        if (nextTab === AUTOMATION_TAB || nextTab === ALL_TAB) {
          requests.push(
            apiFetch(
              `/ingestion/catalog/curation-runs/${toQueryString(nextRunParams)}`,
            ),
          );
        }

        requests.push(apiFetch("/ingestion/catalog/automation/"));
      }

      const payloads = await Promise.all(requests);
      setJobs(payloads[0] || []);
      setSubmissions(payloads[1] || []);

      let offset = 2;
      if (canManageProcessing) {
        setDuplicateReviews(payloads[offset] || []);
        offset += 1;
        const automationPayload = payloads[payloads.length - 1] || null;
        setAutomationState(automationPayload);

        if (nextTab === SOURCE_TAB) {
          const catalogPayload = payloads[offset] || null;
          setCatalogEntries(catalogPayload?.entries || []);
          setCatalogSummary(catalogPayload?.summary || defaultCatalogSummary);
          setCatalogPagination(
            catalogPayload?.pagination || defaultCatalogPagination,
          );
          setCatalogSyncState(catalogPayload?.sync_state || null);
          setCurationRuns([]);
        } else if (nextTab === AUTOMATION_TAB) {
          const runPayload = payloads[offset] || [];
          setCurationRuns(runPayload);
          setCatalogEntries([]);
          setCatalogPagination(defaultCatalogPagination);
          setCatalogSyncState(null);
          setCatalogSummary(defaultCatalogSummary);
          if (!preserveAutomationForm && automationPayload?.settings) {
            setAutomationForm({
              enabled: Boolean(automationPayload.settings.enabled),
              daily_run_time: normalizeTimeInput(
                automationPayload.settings.daily_run_time,
              ),
              frequency: automationPayload.settings.frequency || "daily",
              mode: automationPayload.settings.mode || "pending",
              refresh_max_pages: String(
                automationPayload.settings.refresh_max_pages || 80,
              ),
            });
          }
        } else if (nextTab === ALL_TAB) {
          setCurationRuns(payloads[offset] || []);
          setCatalogEntries([]);
          setCatalogPagination(defaultCatalogPagination);
          setCatalogSyncState(null);
          setCatalogSummary(defaultCatalogSummary);
        } else {
          setCatalogEntries([]);
          setCatalogPagination(defaultCatalogPagination);
          setCatalogSyncState(null);
          setCatalogSummary(defaultCatalogSummary);
          setCurationRuns([]);
        }
      } else {
        setDuplicateReviews([]);
        setCatalogEntries([]);
        setCatalogPagination(defaultCatalogPagination);
        setCatalogSyncState(null);
        setCatalogSummary(defaultCatalogSummary);
        setCurationRuns([]);
        setAutomationState(null);
      }

      setError("");
    } catch (nextError) {
      setError(nextError.message);
      toast.error(nextError.message);
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    if (!canManageProcessing && activeTab !== USER_TAB) {
      applyActiveTab(USER_TAB, { replace: true });
    }
  }, [activeTab, canManageProcessing]);

  useEffect(() => {
    load({ nextTab: activeTab }).catch(() => {});
  }, [user?.id, canManageProcessing, activeTab]);

  useEffect(() => {
    const hasActiveJobs = jobs.some((job) => isActiveStatus(job.status));
    const hasActiveRuns = curationRuns.some((run) =>
      isActiveStatus(run.status),
    );
    const hasActiveCatalogSync =
      activeTab === SOURCE_TAB && isCatalogSyncActive(catalogSyncState?.status);
    const hasActiveAutomationRun = isActiveStatus(
      automationState?.latest_run?.status,
    );
    if (
      !hasActiveJobs &&
      !hasActiveRuns &&
      !hasActiveCatalogSync &&
      !hasActiveAutomationRun
    ) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      load({ preserveAutomationForm: true, silent: true }).catch(() => {});
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    jobs,
    curationRuns,
    catalogSyncState,
    automationState,
    activeTab,
    jobFilters,
    submissionFilters,
    catalogFilters,
    runFilters,
    reviewFilters,
  ]);

  useEffect(() => {
    setSelectedSubmissionIds([]);
    setSelectedJobIds([]);
    setSelectedCatalogEntryIds([]);
    setSelectedRunIds([]);
    setCatalogSyncDismissed(false);
  }, [activeTab]);

  useEffect(() => {
    if (!catalogSyncActive) {
      setCatalogSyncDismissed(false);
    }
  }, [catalogSyncActive]);

  useEffect(() => {
    setSelectedSubmissionIds((current) =>
      current.filter((id) =>
        submissions.some((submission) => submission.id === id),
      ),
    );
  }, [submissions]);

  useEffect(() => {
    setSelectedJobIds((current) =>
      current.filter((id) => jobs.some((job) => job.id === id)),
    );
  }, [jobs]);

  useEffect(() => {
    setSelectedRunIds((current) =>
      current.filter((id) => curationRuns.some((run) => run.id === id)),
    );
  }, [curationRuns]);

  function resetWithLoad(nextValue, setter, key) {
    setter(nextValue);
    load({ [key]: nextValue, preserveAutomationForm: true }).catch(() => {});
  }

  function applyCatalogFilters(nextFilters) {
    setCatalogFilters(nextFilters);
    load({
      nextCatalogFilters: nextFilters,
      preserveAutomationForm: true,
    }).catch(() => {});
  }

  function updateCatalogFilters(nextPatch, options = {}) {
    const { resetPage = false } = options;
    const nextFilters = {
      ...catalogFilters,
      ...nextPatch,
      page: resetPage ? 1 : (nextPatch.page ?? catalogFilters.page),
    };
    applyCatalogFilters(nextFilters);
  }

  async function reloadCurrent(options = {}) {
    await load({ preserveAutomationForm: true, ...options });
  }

  async function retrySubmission(submissionId) {
    if (creationActionsDisabled) {
      return;
    }
    setBusyActionId(submissionId);
    try {
      await apiFetch(`/ingestion/submissions/${submissionId}/retry/`, {
        method: "POST",
        body: {},
      });
      toast.success("Request queued.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyActionId("");
    }
  }

  async function confirmCandidate(submissionId, candidateId) {
    if (creationActionsDisabled) {
      return;
    }
    setBusyActionId(submissionId);
    try {
      await apiFetch(
        `/ingestion/submissions/${submissionId}/confirm-candidate/`,
        {
          method: "POST",
          body: { candidate_id: candidateId },
        },
      );
      setReviewSubmission(null);
      toast.success("Source selected.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyActionId("");
    }
  }

  async function resolveDuplicate(reviewId, decision) {
    setBusyActionId(reviewId);
    try {
      await apiFetch(`/ingestion/duplicate-reviews/${reviewId}/resolve/`, {
        method: "POST",
        body: { decision },
      });
      toast.success(
        decision === "confirm_existing"
          ? "Existing book kept."
          : "New book queued.",
      );
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyActionId("");
    }
  }

  async function resumeJob(jobId) {
    if (creationActionsDisabled) {
      return;
    }
    setBusyActionId(jobId);
    try {
      await apiFetch(`/ingestion/jobs/${jobId}/resume/`, {
        method: "POST",
        body: {},
      });
      toast.success("Book creation started.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyActionId("");
    }
  }

  async function stopJob(jobId) {
    setBusyActionId(jobId);
    try {
      await apiFetch(`/ingestion/jobs/${jobId}/stop/`, {
        method: "POST",
        body: {},
      });
      toast.success("Book creation stopped.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyActionId("");
    }
  }

  async function deleteSubmission(submissionId) {
    setBusyDeleteId(`submission:${submissionId}`);
    try {
      await apiFetch(`/ingestion/submissions/${submissionId}/`, {
        method: "DELETE",
      });
      setSelectedSubmissionIds((current) =>
        current.filter((id) => id !== submissionId),
      );
      toast.success("Request deleted.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyDeleteId("");
    }
  }

  async function deleteJob(jobId) {
    setBusyDeleteId(`job:${jobId}`);
    try {
      await apiFetch(`/ingestion/jobs/${jobId}/`, {
        method: "DELETE",
      });
      setSelectedJobIds((current) => current.filter((id) => id !== jobId));
      toast.success("Book creation deleted.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyDeleteId("");
    }
  }

  async function deleteRun(runId) {
    setBusyDeleteId(`run:${runId}`);
    try {
      await apiFetch(`/ingestion/catalog/curation-runs/${runId}/`, {
        method: "DELETE",
      });
      setSelectedRunIds((current) => current.filter((id) => id !== runId));
      toast.success("Run deleted.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyDeleteId("");
    }
  }

  async function deleteCatalogEntry(entryId) {
    setBusyDeleteId(`catalog:${entryId}`);
    try {
      await apiFetch(`/ingestion/catalog/entries/${entryId}/`, {
        method: "DELETE",
      });
      setSelectedCatalogEntryIds((current) =>
        current.filter((id) => id !== entryId),
      );
      toast.success("Catalog row deleted.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyDeleteId("");
    }
  }

  async function runBulkAction(key, requestFactory, successMessage) {
    if (bulkActionKey) {
      return null;
    }

    setBulkActionKey(key);
    try {
      const payload = await requestFactory();
      toast.success(successMessage(payload));
      await reloadCurrent();
      return payload;
    } catch (nextError) {
      toast.error(nextError.message);
      return null;
    } finally {
      setBulkActionKey("");
    }
  }

  async function refreshCatalog() {
    if (automationRunning) {
      return;
    }
    if (refreshingCatalog) {
      return;
    }

    try {
      setCatalogSyncDismissed(false);
      const payload = await apiFetch("/ingestion/catalog/refresh/", {
        method: "POST",
        body: { max_pages: 80 },
      });
      setCatalogSyncState(payload);
      await reloadCurrent({ silent: true });
    } catch (nextError) {
      toast.error(nextError.message);
    }
  }

  async function stopCatalogRefresh() {
    if (!refreshingCatalog || stoppingCatalogSync) {
      return;
    }

    const previousSyncState = catalogSyncState;
    setStoppingCatalogSync(true);
    setCatalogSyncDismissed(true);
    setCatalogSyncState((current) =>
      current
        ? {
            ...current,
            status: "idle",
            task_id: "",
            queue_name: "",
            finished_at: new Date().toISOString(),
          }
        : current,
    );
    try {
      const payload = await apiFetch("/ingestion/catalog/refresh/stop/", {
        method: "POST",
        body: {},
      });
      setCatalogSyncState(payload);
      await reloadCurrent({ silent: true });
    } catch (nextError) {
      setCatalogSyncDismissed(false);
      setCatalogSyncState(previousSyncState);
      toast.error(nextError.message);
      await reloadCurrent({ silent: true }).catch(() => {});
    } finally {
      setStoppingCatalogSync(false);
    }
  }

  async function queueCatalogBooks(entryIds, rowId = "", mode = "") {
    if (catalogActionsDisabled) {
      return;
    }
    if (!entryIds.length || creatingCatalog) {
      return;
    }

    const creatableEntryIds = entryIds.filter((id) => {
      const entry = catalogEntries.find(
        (catalogEntry) => catalogEntry.id === id,
      );
      return !entry || canCreateCatalogEntry(entry);
    });

    if (creatableEntryIds.length !== entryIds.length) {
      const skippedIds = new Set(
        entryIds.filter((id) => !creatableEntryIds.includes(id)),
      );
      setSelectedCatalogEntryIds((current) =>
        current.filter((id) => !skippedIds.has(id)),
      );
    }

    if (!creatableEntryIds.length) {
      toast.info(
        "Only new, failed, or unfinished catalog rows can be created.",
      );
      return;
    }

    if (rowId) {
      setBusyActionId(rowId);
    } else {
      setCreatingCatalog(true);
      setCatalogActionMode(mode || "all");
    }

    try {
      const payload = await apiFetch(
        "/ingestion/catalog/entries/create-books/",
        {
          method: "POST",
          body: { ids: creatableEntryIds },
        },
      );
      toast.success(
        summarizeResponse(payload, {
          queued_creates: "create",
          queued_updates: "update",
          skipped_processing: "busy",
        }) || "Book creation queued.",
      );
      setSelectedCatalogEntryIds([]);
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      if (rowId) {
        setBusyActionId("");
      } else {
        setCreatingCatalog(false);
        setCatalogActionMode("");
      }
    }
  }

  async function stopRun(runId) {
    setBusyRunId(runId);
    try {
      await apiFetch(`/ingestion/catalog/curation-runs/${runId}/stop/`, {
        method: "POST",
        body: {},
      });
      toast.success("Run stopped.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyRunId("");
    }
  }

  async function saveAutomation(event) {
    event.preventDefault();
    setSavingAutomation(true);
    try {
      const payload = await apiFetch("/ingestion/catalog/automation/", {
        method: "PATCH",
        body: {
          enabled: automationForm.enabled,
          daily_run_time: automationForm.daily_run_time,
          frequency: automationForm.frequency,
          mode: automationForm.mode,
          refresh_max_pages: Number(automationForm.refresh_max_pages) || 80,
        },
      });
      setAutomationState(payload);
      if (payload.settings) {
        setAutomationForm({
          enabled: Boolean(payload.settings.enabled),
          daily_run_time: normalizeTimeInput(payload.settings.daily_run_time),
          frequency: payload.settings.frequency || "daily",
          mode: payload.settings.mode || "pending",
          refresh_max_pages: String(payload.settings.refresh_max_pages || 80),
        });
      }
      toast.success("Automation saved.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setSavingAutomation(false);
    }
  }

  function openDeleteDialog(scope, ids, title, body) {
    setConfirmState({ scope, ids, title, body });
  }

  async function handleConfirmDelete() {
    if (!confirmState) {
      return;
    }

    const { scope, ids } = confirmState;
    setConfirmLoading(true);
    try {
      if (scope === "submission-single") {
        await deleteSubmission(ids[0]);
      } else if (scope === "job-single") {
        await deleteJob(ids[0]);
      } else if (scope === "run-single") {
        await deleteRun(ids[0]);
      } else if (scope === "catalog-single") {
        await deleteCatalogEntry(ids[0]);
      } else if (scope === "submission-bulk") {
        const payload = await runBulkAction(
          "submissions:delete",
          () =>
            apiFetch("/ingestion/submissions/bulk-delete/", {
              method: "POST",
              body: { ids },
            }),
          (payload) =>
            summarizeResponse(payload, {
              deleted_count: "deleted",
              skipped_active: "active",
            }) || "Requests deleted.",
        );
        if (payload) {
          const deletedIdSet = new Set(ids);
          setSelectedSubmissionIds((current) =>
            current.filter((id) => !deletedIdSet.has(id)),
          );
        }
      } else if (scope === "job-bulk") {
        const payload = await runBulkAction(
          "jobs:delete",
          () =>
            apiFetch("/ingestion/jobs/bulk-delete/", {
              method: "POST",
              body: { ids },
            }),
          (payload) =>
            summarizeResponse(payload, {
              deleted_count: "deleted",
              skipped_active: "active",
            }) || "Book creation deleted.",
        );
        if (payload) {
          const deletedIdSet = new Set(ids);
          setSelectedJobIds((current) =>
            current.filter((id) => !deletedIdSet.has(id)),
          );
        }
      } else if (scope === "run-bulk") {
        const payload = await runBulkAction(
          "runs:delete",
          () =>
            apiFetch("/ingestion/catalog/curation-runs/bulk-delete/", {
              method: "POST",
              body: { ids },
            }),
          (payload) =>
            summarizeResponse(payload, {
              deleted_count: "deleted",
              skipped_active: "active",
            }) || "Runs deleted.",
        );
        if (payload) {
          const deletedIdSet = new Set(ids);
          setSelectedRunIds((current) =>
            current.filter((id) => !deletedIdSet.has(id)),
          );
        }
      } else if (scope === "catalog-bulk") {
        const payload = await runBulkAction(
          "catalog:delete",
          () =>
            apiFetch("/ingestion/catalog/entries/bulk-delete/", {
              method: "POST",
              body: { ids },
            }),
          (payload) =>
            summarizeResponse(payload, {
              deleted_count: "deleted",
            }) || "Catalog rows deleted.",
        );
        if (payload) {
          const deletedIdSet = new Set(ids);
          setSelectedCatalogEntryIds((current) =>
            current.filter((id) => !deletedIdSet.has(id)),
          );
        }
      }
    } finally {
      setConfirmLoading(false);
      setConfirmState(null);
    }
  }

  const selectedSubmissionIdSet = useMemo(
    () => new Set(selectedSubmissionIds),
    [selectedSubmissionIds],
  );
  const submissionIdsOnPage = useMemo(
    () => submissions.map((submission) => submission.id),
    [submissions],
  );
  const selectedSubmissionCount = selectedSubmissionIds.length;
  const selectedSubmissionCountOnPage = submissionIdsOnPage.filter((id) =>
    selectedSubmissionIdSet.has(id),
  ).length;
  const allSubmissionsSelected =
    submissions.length > 0 &&
    selectedSubmissionCountOnPage === submissions.length;

  const selectedJobIdSet = useMemo(
    () => new Set(selectedJobIds),
    [selectedJobIds],
  );
  const jobIdsOnPage = useMemo(() => jobs.map((job) => job.id), [jobs]);
  const selectedJobCount = selectedJobIds.length;
  const selectedJobCountOnPage = jobIdsOnPage.filter((id) =>
    selectedJobIdSet.has(id),
  ).length;
  const allJobsSelected =
    jobs.length > 0 && selectedJobCountOnPage === jobs.length;

  const selectedCatalogIdSet = useMemo(
    () => new Set(selectedCatalogEntryIds),
    [selectedCatalogEntryIds],
  );
  const catalogEntryIdsOnPage = useMemo(
    () => catalogEntries.map((entry) => entry.id),
    [catalogEntries],
  );
  const creatableCatalogEntryIdsOnPage = useMemo(
    () =>
      catalogEntries
        .filter((entry) => canCreateCatalogEntry(entry))
        .map((entry) => entry.id),
    [catalogEntries],
  );
  const selectedCatalogCount = selectedCatalogEntryIds.length;
  const selectedCatalogCountOnPage = creatableCatalogEntryIdsOnPage.filter(
    (id) => selectedCatalogIdSet.has(id),
  ).length;
  const allCatalogSelected =
    creatableCatalogEntryIdsOnPage.length > 0 &&
    selectedCatalogCountOnPage === creatableCatalogEntryIdsOnPage.length;

  const selectedRunIdSet = useMemo(
    () => new Set(selectedRunIds),
    [selectedRunIds],
  );
  const runIdsOnPage = useMemo(
    () => curationRuns.map((run) => run.id),
    [curationRuns],
  );
  const selectedRunCount = selectedRunIds.length;
  const selectedRunCountOnPage = runIdsOnPage.filter((id) =>
    selectedRunIdSet.has(id),
  ).length;
  const allRunsSelected =
    curationRuns.length > 0 && selectedRunCountOnPage === curationRuns.length;

  const submissionResumeIds = submissions
    .map((submission) => submission.latest_job)
    .filter((job) => job?.status === "queued" && !job.task_id)
    .map((job) => job.id);
  const submissionStopIds = submissions
    .map((submission) => submission.latest_job)
    .filter((job) => job && isActiveStatus(job.status))
    .map((job) => job.id);
  const jobResumeIds = jobs
    .filter((job) => job.status === "queued" && !job.task_id)
    .map((job) => job.id);
  const jobStopIds = jobs
    .filter((job) => isActiveStatus(job.status))
    .map((job) => job.id);
  const runStopIds = curationRuns
    .filter((run) => isActiveStatus(run.status))
    .map((run) => run.id);
  const selectedSubmissionResumeIds = submissions
    .filter((submission) => selectedSubmissionIdSet.has(submission.id))
    .map((submission) => submission.latest_job)
    .filter((job) => job?.status === "queued" && !job.task_id)
    .map((job) => job.id);
  const selectedSubmissionStopIds = submissions
    .filter((submission) => selectedSubmissionIdSet.has(submission.id))
    .map((submission) => submission.latest_job)
    .filter((job) => job && isActiveStatus(job.status))
    .map((job) => job.id);
  const selectedJobResumeIds = jobs
    .filter(
      (job) =>
        selectedJobIdSet.has(job.id) && job.status === "queued" && !job.task_id,
    )
    .map((job) => job.id);
  const selectedJobStopIds = jobs
    .filter((job) => selectedJobIdSet.has(job.id) && isActiveStatus(job.status))
    .map((job) => job.id);
  const selectedRunStopIds = curationRuns
    .filter((run) => selectedRunIdSet.has(run.id) && isActiveStatus(run.status))
    .map((run) => run.id);

  useEffect(() => {
    setSelectedCatalogEntryIds((current) =>
      current.filter((id) => {
        const entry = catalogEntries.find(
          (catalogEntry) => catalogEntry.id === id,
        );
        return !entry || canCreateCatalogEntry(entry);
      }),
    );
  }, [catalogEntries]);

  function renderCardHeaderSearch({
    filters,
    setFilters,
    fields,
    defaultFilters,
    filtersExpanded,
    setFiltersExpanded,
    searchPlaceholder,
    resultCount,
    drawerId,
    onSubmit,
    onSearchClear,
    buttonsDisabled = false,
  }) {
    return (
      <CatalogSearchRow
        filters={filters}
        setFilters={setFilters}
        fields={fields}
        defaultFilters={defaultFilters}
        filtersExpanded={filtersExpanded}
        setFiltersExpanded={setFiltersExpanded}
        searchPlaceholder={searchPlaceholder}
        resultCount={resultCount}
        drawerId={drawerId}
        compact
        onSubmit={onSubmit}
        onSearchClear={onSearchClear}
        buttonsDisabled={buttonsDisabled}
      />
    );
  }

  function renderSubmissionsCard(title, cardClassName = "") {
    return (
      <QueueTableCard
        title={title}
        emptyTitle="No requests"
        cardClassName={cardClassName}
        loading={loading}
        loadingLabel={`Loading ${title.toLowerCase()}`}
        headerAside={renderCardHeaderSearch({
          filters: submissionFilters,
          setFilters: setSubmissionFilters,
          fields: submissionFilterFields,
          defaultFilters: defaultSubmissionFilters,
          filtersExpanded: submissionFiltersExpanded,
          setFiltersExpanded: setSubmissionFiltersExpanded,
          searchPlaceholder: "Search requests",
          resultCount: submissions.length,
          drawerId: `${activeTab}-submission-filters`,
          onSubmit: (event) => {
            event.preventDefault();
            reloadCurrent({ nextSubmissionFilters: submissionFilters }).catch(
              () => {},
            );
          },
          onSearchClear: (nextFilters) => {
            reloadCurrent({ nextSubmissionFilters: nextFilters }).catch(
              () => {},
            );
          },
          buttonsDisabled: sourceTabButtonsDisabled,
        })}
        toolbar={
          <CatalogToolbar
            filters={submissionFilters}
            setFilters={setSubmissionFilters}
            fields={submissionFilterFields}
            defaultFilters={defaultSubmissionFilters}
            filtersExpanded={submissionFiltersExpanded}
            setFiltersExpanded={setSubmissionFiltersExpanded}
            onSubmit={(event) => {
              event.preventDefault();
              reloadCurrent({ nextSubmissionFilters: submissionFilters }).catch(
                () => {},
              );
            }}
            onReset={() =>
              resetWithLoad(
                defaultSubmissionFilters,
                setSubmissionFilters,
                "nextSubmissionFilters",
              )
            }
            searchPlaceholder="Search requests"
            resultCount={submissions.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-submission-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={loading}
          />
        }
        actions={
          <div className="processing-card-actions processing-card-actions-grouped">
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedSubmissionResumeIds.length ||
                  bulkActionKey === "submissions:resume" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "submissions:resume",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-resume/", {
                        method: "POST",
                        body: { ids: selectedSubmissionResumeIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        resumed_count: "started",
                        skipped_invalid: "skipped",
                      }) || "Requests started.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "submissions:resume" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Resume selected",
                    selectedSubmissionResumeIds.length,
                  )}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedSubmissionStopIds.length ||
                  bulkActionKey === "submissions:stop" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "submissions:stop",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-stop/", {
                        method: "POST",
                        body: { ids: selectedSubmissionStopIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        stopped_count: "stopped",
                        skipped_complete: "done",
                      }) || "Requests stopped.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "submissions:stop" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Stop selected",
                    selectedSubmissionStopIds.length,
                  )}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button danger-button processing-inline-danger"
                disabled={
                  !selectedSubmissionCount ||
                  bulkActionKey === "submissions:delete" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  openDeleteDialog(
                    "submission-bulk",
                    selectedSubmissionIds,
                    "Delete selected requests",
                    "This will remove the selected requests in this list.",
                  )
                }
              >
                {selectedActionLabel(
                  "Delete selected",
                  selectedSubmissionCount,
                )}
              </button>
            </div>
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !submissionResumeIds.length ||
                  bulkActionKey === "submissions:resume" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "submissions:resume",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-resume/", {
                        method: "POST",
                        body: { ids: submissionResumeIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        resumed_count: "started",
                        skipped_invalid: "skipped",
                      }) || "Requests started.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "submissions:resume" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Resume all
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !submissionStopIds.length ||
                  bulkActionKey === "submissions:stop" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "submissions:stop",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-stop/", {
                        method: "POST",
                        body: { ids: submissionStopIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        stopped_count: "stopped",
                        skipped_complete: "done",
                      }) || "Requests stopped.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "submissions:stop" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Stop all
                </span>
              </button>
              <button
                type="button"
                className="ghost-button danger-button processing-inline-danger"
                disabled={
                  !submissions.length ||
                  bulkActionKey === "submissions:delete" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  openDeleteDialog(
                    "submission-bulk",
                    submissions.map((submission) => submission.id),
                    "Delete requests",
                    "This will remove every visible request in this list.",
                  )
                }
              >
                Delete all
              </button>
            </div>
          </div>
        }
      >
        {submissions.length ? (
          <table className="simple-table processing-table">
            <thead>
              <tr>
                <th className="processing-col-select">
                  <input
                    type="checkbox"
                    className="processing-checkbox"
                    checked={allSubmissionsSelected}
                    onChange={() =>
                      setSelectedSubmissionIds((current) =>
                        toggleVisibleSelection(
                          current,
                          submissionIdsOnPage,
                          allSubmissionsSelected,
                        ),
                      )
                    }
                    aria-label={
                      allSubmissionsSelected
                        ? "Clear visible request selections"
                        : "Select all visible requests"
                    }
                  />
                </th>
                <th className="processing-col-request">Request</th>
                <th className="processing-col-status">Status</th>
                <th className="processing-col-book">Book</th>
                <th className="processing-col-time">Updated</th>
                <th className="processing-col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((submission) => {
                const latestJob = submission.latest_job || null;
                const isBusy =
                  busyActionId === submission.id ||
                  busyActionId === latestJob?.id;
                const isDeleting =
                  busyDeleteId === `submission:${submission.id}`;
                const isSelected = selectedSubmissionIdSet.has(submission.id);
                const primaryError =
                  submission.error_message || latestJob?.last_error || "";
                const showDelete = true;

                return (
                  <tr key={submission.id}>
                    <td className="processing-col-select">
                      <input
                        type="checkbox"
                        className="processing-checkbox"
                        checked={isSelected}
                        onChange={() =>
                          setSelectedSubmissionIds((current) =>
                            toggleSelectedId(current, submission.id),
                          )
                        }
                        aria-label={`Select request ${getRequestPrimaryText(submission.original_input)}`}
                      />
                    </td>
                    <td className="processing-col-request">
                      <RequestValue
                        value={submission.original_input}
                        error={primaryError}
                      />
                    </td>
                    <td>
                      <StatusPill value={submission.status} />
                    </td>
                    <td>
                      <BookLinkCell submission={submission} />
                    </td>
                    <td>
                      {formatBookDateTime(getSubmissionActivityAt(submission))}
                    </td>
                    <td>
                      <div className="table-actions">
                        {submission.linked_book_slug ? (
                          <Link
                            to={`/books/${submission.linked_book_slug}`}
                            className="ghost-button"
                          >
                            Open
                          </Link>
                        ) : submission.linked_book_deleted ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => retrySubmission(submission.id)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            {isBusy ? "Queueing..." : "Recreate"}
                          </button>
                        ) : submission.resolution_status === "ambiguous" &&
                          submission.candidates?.length ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setReviewSubmission(submission)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            Review
                          </button>
                        ) : latestJob?.status === "queued" &&
                          !latestJob.task_id ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => resumeJob(latestJob.id)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            {isBusy ? "Starting..." : "Start"}
                          </button>
                        ) : latestJob && isActiveStatus(latestJob.status) ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => stopJob(latestJob.id)}
                            disabled={isBusy || sourceTabButtonsDisabled}
                          >
                            {isBusy ? "Stopping..." : "Stop"}
                          </button>
                        ) : [
                            "deleted",
                            "failed",
                            "cancelled",
                            "needs_review",
                          ].includes(submission.status) ||
                          latestJob?.status === "failed" ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => retrySubmission(submission.id)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            {isBusy ? "Queueing..." : "Retry"}
                          </button>
                        ) : (
                          <span className="table-note">-</span>
                        )}
                        {showDelete ? (
                          <button
                            type="button"
                            className="ghost-button danger-button processing-inline-danger"
                            onClick={() =>
                              openDeleteDialog(
                                "submission-single",
                                [submission.id],
                                "Delete request",
                                "This request will be removed from the queue.",
                              )
                            }
                            disabled={isDeleting || sourceTabButtonsDisabled}
                          >
                            {isDeleting ? "Deleting..." : "Delete"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </QueueTableCard>
    );
  }

  function renderJobsCard(title, cardClassName = "") {
    return (
      <QueueTableCard
        title={title}
        emptyTitle="No book creation"
        cardClassName={cardClassName}
        loading={loading}
        loadingLabel={`Loading ${title.toLowerCase()}`}
        headerAside={renderCardHeaderSearch({
          filters: jobFilters,
          setFilters: setJobFilters,
          fields: jobFilterFields,
          defaultFilters: defaultJobFilters,
          filtersExpanded: jobFiltersExpanded,
          setFiltersExpanded: setJobFiltersExpanded,
          searchPlaceholder: "Search book creation",
          resultCount: jobs.length,
          drawerId: `${activeTab}-job-filters`,
          onSubmit: (event) => {
            event.preventDefault();
            reloadCurrent({ nextJobFilters: jobFilters }).catch(() => {});
          },
          onSearchClear: (nextFilters) => {
            reloadCurrent({ nextJobFilters: nextFilters }).catch(() => {});
          },
          buttonsDisabled: sourceTabButtonsDisabled,
        })}
        toolbar={
          <CatalogToolbar
            filters={jobFilters}
            setFilters={setJobFilters}
            fields={jobFilterFields}
            defaultFilters={defaultJobFilters}
            filtersExpanded={jobFiltersExpanded}
            setFiltersExpanded={setJobFiltersExpanded}
            onSubmit={(event) => {
              event.preventDefault();
              reloadCurrent({ nextJobFilters: jobFilters }).catch(() => {});
            }}
            onReset={() =>
              resetWithLoad(defaultJobFilters, setJobFilters, "nextJobFilters")
            }
            searchPlaceholder="Search book creation"
            resultCount={jobs.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-job-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={loading}
          />
        }
        actions={
          <div className="processing-card-actions processing-card-actions-grouped">
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedJobResumeIds.length ||
                  bulkActionKey === "jobs:resume" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "jobs:resume",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-resume/", {
                        method: "POST",
                        body: { ids: selectedJobResumeIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        resumed_count: "started",
                        skipped_invalid: "skipped",
                      }) || "Book creation started.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "jobs:resume" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Resume selected",
                    selectedJobResumeIds.length,
                  )}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedJobStopIds.length ||
                  bulkActionKey === "jobs:stop" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "jobs:stop",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-stop/", {
                        method: "POST",
                        body: { ids: selectedJobStopIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        stopped_count: "stopped",
                        skipped_complete: "done",
                      }) || "Book creation stopped.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "jobs:stop" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Stop selected",
                    selectedJobStopIds.length,
                  )}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button danger-button processing-inline-danger"
                disabled={
                  !selectedJobCount ||
                  bulkActionKey === "jobs:delete" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  openDeleteDialog(
                    "job-bulk",
                    selectedJobIds,
                    "Delete selected book creation rows",
                    "This will remove the selected book creation rows.",
                  )
                }
              >
                {selectedActionLabel("Delete selected", selectedJobCount)}
              </button>
            </div>
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !jobResumeIds.length ||
                  bulkActionKey === "jobs:resume" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "jobs:resume",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-resume/", {
                        method: "POST",
                        body: { ids: jobResumeIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        resumed_count: "started",
                        skipped_invalid: "skipped",
                      }) || "Book creation started.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "jobs:resume" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Resume all
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !jobStopIds.length ||
                  bulkActionKey === "jobs:stop" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "jobs:stop",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-stop/", {
                        method: "POST",
                        body: { ids: jobStopIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        stopped_count: "stopped",
                        skipped_complete: "done",
                      }) || "Book creation stopped.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "jobs:stop" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Stop all
                </span>
              </button>
              <button
                type="button"
                className="ghost-button danger-button processing-inline-danger"
                disabled={
                  !jobs.length ||
                  bulkActionKey === "jobs:delete" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  openDeleteDialog(
                    "job-bulk",
                    jobs.map((job) => job.id),
                    "Delete book creation",
                    "This will remove every visible row in this book creation list.",
                  )
                }
              >
                Delete all
              </button>
            </div>
          </div>
        }
      >
        {jobs.length ? (
          <table className="simple-table processing-table">
            <thead>
              <tr>
                <th className="processing-col-select">
                  <input
                    type="checkbox"
                    className="processing-checkbox"
                    checked={allJobsSelected}
                    onChange={() =>
                      setSelectedJobIds((current) =>
                        toggleVisibleSelection(
                          current,
                          jobIdsOnPage,
                          allJobsSelected,
                        ),
                      )
                    }
                    aria-label={
                      allJobsSelected
                        ? "Clear visible book creation selections"
                        : "Select all visible book creation rows"
                    }
                  />
                </th>
                <th className="processing-col-request">Request</th>
                <th className="processing-col-status">Status</th>
                <th className="processing-col-type">Step</th>
                <th className="processing-col-time">Updated</th>
                <th className="processing-col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const isBusy = busyActionId === job.id;
                const isDeleting = busyDeleteId === `job:${job.id}`;
                const isSelected = selectedJobIdSet.has(job.id);
                return (
                  <tr key={job.id}>
                    <td className="processing-col-select">
                      <input
                        type="checkbox"
                        className="processing-checkbox"
                        checked={isSelected}
                        onChange={() =>
                          setSelectedJobIds((current) =>
                            toggleSelectedId(current, job.id),
                          )
                        }
                        aria-label={`Select job ${getRequestPrimaryText(job.submission_input)}`}
                      />
                    </td>
                    <td className="processing-col-request">
                      <RequestValue
                        value={job.submission_input}
                        error={job.last_error}
                      />
                    </td>
                    <td>
                      <StatusPill value={job.status} />
                    </td>
                    <td>{jobTypeLabel(job.job_type)}</td>
                    <td>{formatBookDateTime(getJobActivityAt(job))}</td>
                    <td>
                      <div className="table-actions">
                        {job.target_book_slug ? (
                          <Link
                            to={`/books/${job.target_book_slug}`}
                            className="ghost-button"
                          >
                            Open
                          </Link>
                        ) : job.target_book_deleted ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => retrySubmission(job.submission_id)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            {isBusy ? "Queueing..." : "Recreate"}
                          </button>
                        ) : null}
                        {job.status === "queued" && !job.task_id ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => resumeJob(job.id)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            {isBusy ? "Starting..." : "Start"}
                          </button>
                        ) : isActiveStatus(job.status) ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => stopJob(job.id)}
                            disabled={isBusy || sourceTabButtonsDisabled}
                          >
                            {isBusy ? "Stopping..." : "Stop"}
                          </button>
                        ) : job.target_book_slug ? null : (
                          <span className="table-note">-</span>
                        )}
                        <button
                          type="button"
                          className="ghost-button danger-button processing-inline-danger"
                          onClick={() =>
                            openDeleteDialog(
                              "job-single",
                              [job.id],
                              "Delete book creation",
                              "This row will be removed from book creation history.",
                            )
                          }
                          disabled={isDeleting || sourceTabButtonsDisabled}
                        >
                          {isDeleting ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </QueueTableCard>
    );
  }

  function renderDuplicateCard(title) {
    if (!canManageProcessing) {
      return null;
    }

    return (
      <QueueTableCard
        title={title}
        emptyTitle="No duplicates"
        loading={loading}
        loadingLabel={`Loading ${title.toLowerCase()}`}
        headerAside={renderCardHeaderSearch({
          filters: reviewFilters,
          setFilters: setReviewFilters,
          fields: reviewFilterFields,
          defaultFilters: defaultReviewFilters,
          filtersExpanded: reviewFiltersExpanded,
          setFiltersExpanded: setReviewFiltersExpanded,
          searchPlaceholder: "Search duplicate checks",
          resultCount: duplicateReviews.length,
          drawerId: `${activeTab}-review-filters`,
          onSubmit: (event) => {
            event.preventDefault();
            reloadCurrent({ nextReviewFilters: reviewFilters }).catch(() => {});
          },
          onSearchClear: (nextFilters) => {
            reloadCurrent({ nextReviewFilters: nextFilters }).catch(() => {});
          },
          buttonsDisabled: sourceTabButtonsDisabled,
        })}
        toolbar={
          <CatalogToolbar
            filters={reviewFilters}
            setFilters={setReviewFilters}
            fields={reviewFilterFields}
            defaultFilters={defaultReviewFilters}
            filtersExpanded={reviewFiltersExpanded}
            setFiltersExpanded={setReviewFiltersExpanded}
            onSubmit={(event) => {
              event.preventDefault();
              reloadCurrent({ nextReviewFilters: reviewFilters }).catch(
                () => {},
              );
            }}
            onReset={() =>
              resetWithLoad(
                defaultReviewFilters,
                setReviewFilters,
                "nextReviewFilters",
              )
            }
            searchPlaceholder="Search duplicate checks"
            resultCount={duplicateReviews.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-review-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={loading}
          />
        }
      >
        {duplicateReviews.length ? (
          <table className="simple-table processing-table">
            <thead>
              <tr>
                <th className="processing-col-request">Request</th>
                <th className="processing-col-book">Existing</th>
                <th className="processing-col-status">Status</th>
                <th className="processing-col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {duplicateReviews.map((review) => (
                <tr key={review.id}>
                  <td className="processing-col-request">
                    <RequestValue value={review.submission?.original_input} />
                  </td>
                  <td>
                    {review.existing_book?.title ||
                      (review.existing_book_deleted ? "Deleted record" : "-")}
                  </td>
                  <td>
                    <StatusPill value={review.status} />
                  </td>
                  <td>
                    <div className="table-actions">
                      {!review.existing_book_deleted ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() =>
                            resolveDuplicate(review.id, "confirm_existing")
                          }
                          disabled={
                            busyActionId === review.id ||
                            creationActionsDisabled
                          }
                        >
                          Use existing
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => resolveDuplicate(review.id, "dismiss")}
                        disabled={
                          busyActionId === review.id || creationActionsDisabled
                        }
                      >
                        {review.existing_book_deleted ? "Recreate" : "Keep new"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </QueueTableCard>
    );
  }

  function renderCatalogSummaryCard() {
    const countPill = (
      <span className="processing-card-count">
        {loading ? <LoadingSpinner size={14} /> : catalogSummary.total}
      </span>
    );

    return (
      <section className="detail-card processing-card processing-summary-card">
        <div className="processing-card-head">
          <div className="section-title-block">
            <h2>Catalog Overview</h2>
          </div>
          {countPill}
        </div>
        {loading ? (
          renderProcessingCardLoader("Loading catalog overview")
        ) : (
          <div className="processing-summary-bar">
            {[
              ["New", catalogSummary.new],
              ["Processing", catalogSummary.processing],
              ["Failed", catalogSummary.failed],
              ["Unfinished", catalogSummary.unfinished],
              ["Ready", catalogSummary.ready],
              ["Deleted", catalogSummary.deleted],
            ].map(([label, value]) => (
              <article key={label} className="processing-summary-stat">
                <span className="fact-label">{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderCatalogCard() {
    const catalogPageCount = catalogPagination.page_count || 1;
    const isFirstCatalogPage = (catalogPagination.page || 1) <= 1;
    const isLastCatalogPage = (catalogPagination.page || 1) >= catalogPageCount;
    const catalogSyncControlLabel = stoppingCatalogSync
      ? "Stopping catalog sync"
      : refreshingCatalog
        ? "Stop catalog sync"
        : "Sync catalog";
    const catalogSyncControlTitle =
      !refreshingCatalog && automationRunning
        ? "Disabled while scheduled automation is syncing the catalog and creating books."
        : catalogSyncControlLabel;

    return (
      <QueueTableCard
        title="Catalog Books"
        emptyTitle="No catalog rows"
        cardClassName="processing-catalog-card"
        loading={loading}
        loadingLabel="Loading catalog books"
        headerAside={
          <CatalogSearchRow
            filters={catalogFilters}
            setFilters={setCatalogFilters}
            fields={catalogFilterFields}
            defaultFilters={defaultCatalogFilters}
            filtersExpanded={catalogFiltersExpanded}
            setFiltersExpanded={setCatalogFiltersExpanded}
            searchPlaceholder="Search catalog books"
            resultCount={catalogPagination.total_count}
            drawerId={`${activeTab}-catalog-filters`}
            compact
            buttonsDisabled={sourceTabButtonsDisabled}
            onSubmit={(event) => {
              event.preventDefault();
              applyCatalogFilters({ ...catalogFilters, page: 1 });
            }}
            onSearchClear={(nextFilters) => {
              applyCatalogFilters({ ...nextFilters, page: 1 });
            }}
          />
        }
        toolbar={
          <CatalogToolbar
            filters={catalogFilters}
            setFilters={setCatalogFilters}
            fields={catalogFilterFields}
            defaultFilters={defaultCatalogFilters}
            filtersExpanded={catalogFiltersExpanded}
            setFiltersExpanded={setCatalogFiltersExpanded}
            onSubmit={(event) => {
              event.preventDefault();
              applyCatalogFilters({ ...catalogFilters, page: 1 });
            }}
            onReset={() =>
              resetWithLoad(
                defaultCatalogFilters,
                setCatalogFilters,
                "nextCatalogFilters",
              )
            }
            searchPlaceholder="Search catalog books"
            resultCount={catalogPagination.total_count}
            showSearchRow={false}
            secondaryContent={
              <div className="catalog-toolbar-secondary-layout">
                <div className="catalog-toolbar-sync-panel">
                  <button
                    type="button"
                    className={`icon-button catalog-toolbar-sync-button${refreshingCatalog || stoppingCatalogSync ? " warning-button" : ""}`}
                    onClick={
                      refreshingCatalog ? stopCatalogRefresh : refreshCatalog
                    }
                    disabled={
                      stoppingCatalogSync ||
                      (!refreshingCatalog && catalogActionsDisabled)
                    }
                    title={catalogSyncControlTitle}
                    aria-label={catalogSyncControlLabel}
                  >
                    {stoppingCatalogSync ? (
                      <LoadingSpinner size={18} />
                    ) : refreshingCatalog ? (
                      <CatalogStopIcon />
                    ) : (
                      <CatalogRefreshIcon />
                    )}
                  </button>
                </div>
                <div className="catalog-toolbar-secondary catalog-toolbar-secondary--catalog-card">
                  <label className="catalog-toolbar-field catalog-toolbar-field-sort">
                    <span className="fact-label">Sort</span>
                    <select
                      className="catalog-toolbar-select"
                      value={catalogFilters.sort}
                      onChange={(event) =>
                        updateCatalogFilters(
                          { sort: event.target.value },
                          { resetPage: true },
                        )
                      }
                      disabled={sourceTabButtonsDisabled}
                    >
                      <option value="status_recent">Status + recent</option>
                      <option value="activity_desc">Recent activity</option>
                      <option value="activity_asc">Oldest activity</option>
                      <option value="created_desc">Newest added</option>
                      <option value="created_asc">Oldest added</option>
                      <option value="title_asc">Title A-Z</option>
                      <option value="title_desc">Title Z-A</option>
                    </select>
                  </label>
                  <label className="catalog-toolbar-field catalog-toolbar-field-rows">
                    <span className="fact-label">Rows</span>
                    <select
                      className="catalog-toolbar-select"
                      value={String(catalogFilters.limit)}
                      onChange={(event) =>
                        updateCatalogFilters(
                          { limit: Number(event.target.value) || 180 },
                          { resetPage: true },
                        )
                      }
                      disabled={sourceTabButtonsDisabled}
                    >
                      <option value="180">180</option>
                      <option value="200">200</option>
                      <option value="400">400</option>
                    </select>
                  </label>
                  <div className="catalog-pagination">
                    <span className="catalog-page-indicator">
                      {getCatalogPageLabel(catalogPagination)}
                    </span>
                    <div className="catalog-pagination-actions">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => updateCatalogFilters({ page: 1 })}
                        disabled={
                          isFirstCatalogPage || sourceTabButtonsDisabled
                        }
                      >
                        First
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() =>
                          updateCatalogFilters({
                            page: Math.max(
                              1,
                              (catalogPagination.page || 1) - 1,
                            ),
                          })
                        }
                        disabled={
                          isFirstCatalogPage || sourceTabButtonsDisabled
                        }
                      >
                        Prev
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() =>
                          updateCatalogFilters({
                            page: Math.min(
                              catalogPageCount,
                              (catalogPagination.page || 1) + 1,
                            ),
                          })
                        }
                        disabled={isLastCatalogPage || sourceTabButtonsDisabled}
                      >
                        Next
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() =>
                          updateCatalogFilters({ page: catalogPageCount })
                        }
                        disabled={isLastCatalogPage || sourceTabButtonsDisabled}
                      >
                        Last
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            }
            inline
            drawerId={`${activeTab}-catalog-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={loading}
          />
        }
        actions={
          <div className="processing-card-actions processing-card-actions-grouped">
            <div className="processing-card-action-row">
              <button
                type="button"
                className="primary-button"
                onClick={() =>
                  queueCatalogBooks(selectedCatalogEntryIds, "", "selected")
                }
                disabled={
                  !selectedCatalogCount ||
                  creatingCatalog ||
                  catalogActionsDisabled
                }
                title={catalogActionDisabledReason || undefined}
              >
                <span className="button-label">
                  {creatingCatalog && catalogActionMode === "selected" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel("Create selected", selectedCatalogCount)}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button danger-button processing-inline-danger"
                onClick={() =>
                  openDeleteDialog(
                    "catalog-bulk",
                    selectedCatalogEntryIds,
                    "Delete selected catalog rows",
                    "This will remove the selected catalog rows.",
                  )
                }
                disabled={
                  !selectedCatalogCount ||
                  bulkActionKey === "catalog:delete" ||
                  sourceTabButtonsDisabled
                }
              >
                {selectedActionLabel("Delete selected", selectedCatalogCount)}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() =>
                  queueCatalogBooks(creatableCatalogEntryIdsOnPage, "", "all")
                }
                disabled={
                  !creatableCatalogEntryIdsOnPage.length ||
                  creatingCatalog ||
                  catalogActionsDisabled
                }
                title={catalogActionDisabledReason || undefined}
              >
                <span className="button-label">
                  {creatingCatalog && catalogActionMode === "all" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Create all
                </span>
              </button>
              <button
                type="button"
                className="ghost-button danger-button processing-inline-danger"
                onClick={() =>
                  openDeleteDialog(
                    "catalog-bulk",
                    catalogEntries.map((entry) => entry.id),
                    "Delete catalog rows",
                    "This will remove every visible catalog row.",
                  )
                }
                disabled={
                  !catalogEntries.length ||
                  bulkActionKey === "catalog:delete" ||
                  sourceTabButtonsDisabled
                }
              >
                Delete all
              </button>
            </div>
          </div>
        }
      >
        {catalogEntries.length ? (
          <table className="simple-table processing-table processing-catalog-table">
            <thead>
              <tr>
                <th className="processing-col-select">
                  <input
                    type="checkbox"
                    className="processing-checkbox"
                    checked={allCatalogSelected}
                    onChange={() =>
                      setSelectedCatalogEntryIds((current) =>
                        toggleVisibleSelection(
                          current,
                          creatableCatalogEntryIdsOnPage,
                          allCatalogSelected,
                        ),
                      )
                    }
                    disabled={
                      !creatableCatalogEntryIdsOnPage.length ||
                      catalogActionsDisabled
                    }
                    aria-label={
                      allCatalogSelected
                        ? "Clear visible catalog selections"
                        : "Select all visible catalog rows"
                    }
                  />
                </th>
                <th className="processing-col-request">Book</th>
                <th className="processing-col-category">Categories</th>
                <th className="processing-col-status">Status</th>
                <th className="processing-col-book">Local Book</th>
                <th className="processing-col-time">Updated</th>
                <th className="processing-col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {catalogEntries.map((entry) => {
                const isSelectable = canCreateCatalogEntry(entry);
                const isSelected = selectedCatalogIdSet.has(entry.id);
                const isBusy = busyActionId === entry.id;
                const isDeleting = busyDeleteId === `catalog:${entry.id}`;
                return (
                  <tr key={entry.id}>
                    <td className="processing-col-select">
                      <input
                        type="checkbox"
                        className="processing-checkbox"
                        checked={isSelected}
                        onChange={() =>
                          setSelectedCatalogEntryIds((current) =>
                            toggleSelectedId(current, entry.id),
                          )
                        }
                        disabled={!isSelectable || catalogActionsDisabled}
                        aria-label={`Select ${entry.title}`}
                      />
                    </td>
                    <td className="processing-col-request">
                      <div className="table-cell-stack table-request-cell">
                        <strong>{entry.title}</strong>
                        {entry.author_line ? (
                          <span className="table-note">
                            {entry.author_line}
                          </span>
                        ) : null}
                        {entry.latest_job_error ? (
                          <span className="processing-row-error">
                            {entry.latest_job_error}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="processing-col-category">
                      {entry.categories ? (
                        <span>{entry.categories}</span>
                      ) : (
                        <span className="table-note">-</span>
                      )}
                    </td>
                    <td>
                      <StatusPill value={entry.curation_status} />
                    </td>
                    <td>
                      {entry.local_book_slug ? (
                        <Link
                          to={`/books/${entry.local_book_slug}`}
                          className="meta-link"
                        >
                          {entry.local_book_title}
                        </Link>
                      ) : (
                        <span className="table-note">-</span>
                      )}
                    </td>
                    <td>
                      {formatBookDateTime(getCatalogEntryActivityAt(entry))}
                    </td>
                    <td>
                      <div className="table-actions">
                        {entry.local_book_slug &&
                        entry.curation_status === "ready" ? (
                          <Link
                            to={`/books/${entry.local_book_slug}`}
                            className="ghost-button"
                          >
                            Open
                          </Link>
                        ) : canCreateCatalogEntry(entry) ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() =>
                              queueCatalogBooks([entry.id], entry.id)
                            }
                            disabled={isBusy || catalogActionsDisabled}
                          >
                            {isBusy ? "Queueing..." : "Create"}
                          </button>
                        ) : (
                          <span className="table-note">-</span>
                        )}
                        <button
                          type="button"
                          className="ghost-button danger-button processing-inline-danger"
                          onClick={() =>
                            openDeleteDialog(
                              "catalog-single",
                              [entry.id],
                              "Delete catalog row",
                              "This catalog row will be removed.",
                            )
                          }
                          disabled={isDeleting || sourceTabButtonsDisabled}
                        >
                          {isDeleting ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </QueueTableCard>
    );
  }

  function renderRunsCard(title, cardClassName = "") {
    if (!canManageProcessing) {
      return null;
    }

    return (
      <QueueTableCard
        title={title}
        emptyTitle="No runs"
        cardClassName={cardClassName}
        loading={loading}
        loadingLabel={`Loading ${title.toLowerCase()}`}
        headerAside={renderCardHeaderSearch({
          filters: runFilters,
          setFilters: setRunFilters,
          fields: runFilterFields,
          defaultFilters: defaultRunFilters,
          filtersExpanded: runFiltersExpanded,
          setFiltersExpanded: setRunFiltersExpanded,
          searchPlaceholder: "Search runs",
          resultCount: curationRuns.length,
          drawerId: `${activeTab}-run-filters`,
          onSubmit: (event) => {
            event.preventDefault();
            reloadCurrent({ nextRunFilters: runFilters }).catch(() => {});
          },
          onSearchClear: (nextFilters) => {
            reloadCurrent({ nextRunFilters: nextFilters }).catch(() => {});
          },
          buttonsDisabled: sourceTabButtonsDisabled,
        })}
        toolbar={
          <CatalogToolbar
            filters={runFilters}
            setFilters={setRunFilters}
            fields={runFilterFields}
            defaultFilters={defaultRunFilters}
            filtersExpanded={runFiltersExpanded}
            setFiltersExpanded={setRunFiltersExpanded}
            onSubmit={(event) => {
              event.preventDefault();
              reloadCurrent({ nextRunFilters: runFilters }).catch(() => {});
            }}
            onReset={() =>
              resetWithLoad(defaultRunFilters, setRunFilters, "nextRunFilters")
            }
            searchPlaceholder="Search runs"
            resultCount={curationRuns.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-run-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={loading}
          />
        }
        actions={
          <div className="processing-card-actions processing-card-actions-grouped">
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedRunStopIds.length ||
                  bulkActionKey === "runs:stop" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "runs:stop",
                    () =>
                      apiFetch("/ingestion/catalog/curation-runs/bulk-stop/", {
                        method: "POST",
                        body: { ids: selectedRunStopIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        stopped_count: "stopped",
                        skipped_complete: "done",
                      }) || "Runs stopped.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "runs:stop" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Stop selected",
                    selectedRunStopIds.length,
                  )}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button danger-button processing-inline-danger"
                disabled={
                  !selectedRunCount ||
                  bulkActionKey === "runs:delete" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  openDeleteDialog(
                    "run-bulk",
                    selectedRunIds,
                    "Delete selected runs",
                    "This will remove the selected runs from history.",
                  )
                }
              >
                {selectedActionLabel("Delete selected", selectedRunCount)}
              </button>
            </div>
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !runStopIds.length ||
                  bulkActionKey === "runs:stop" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "runs:stop",
                    () =>
                      apiFetch("/ingestion/catalog/curation-runs/bulk-stop/", {
                        method: "POST",
                        body: { ids: runStopIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        stopped_count: "stopped",
                        skipped_complete: "done",
                      }) || "Runs stopped.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "runs:stop" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Stop all
                </span>
              </button>
              <button
                type="button"
                className="ghost-button danger-button processing-inline-danger"
                disabled={
                  !curationRuns.length ||
                  bulkActionKey === "runs:delete" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  openDeleteDialog(
                    "run-bulk",
                    curationRuns.map((run) => run.id),
                    "Delete runs",
                    "This will remove every visible run.",
                  )
                }
              >
                Delete all
              </button>
            </div>
          </div>
        }
      >
        {curationRuns.length ? (
          <table className="simple-table processing-table">
            <thead>
              <tr>
                <th className="processing-col-select">
                  <input
                    type="checkbox"
                    className="processing-checkbox"
                    checked={allRunsSelected}
                    onChange={() =>
                      setSelectedRunIds((current) =>
                        toggleVisibleSelection(
                          current,
                          runIdsOnPage,
                          allRunsSelected,
                        ),
                      )
                    }
                    aria-label={
                      allRunsSelected
                        ? "Clear visible run selections"
                        : "Select all visible runs"
                    }
                  />
                </th>
                <th className="processing-col-request">Run</th>
                <th className="processing-col-status">Status</th>
                <th className="processing-col-type">Mode</th>
                <th className="processing-col-time">Updated</th>
                <th className="processing-col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {curationRuns.map((run) => {
                const isDeleting = busyDeleteId === `run:${run.id}`;
                const isSelected = selectedRunIdSet.has(run.id);
                return (
                  <tr key={run.id}>
                    <td className="processing-col-select">
                      <input
                        type="checkbox"
                        className="processing-checkbox"
                        checked={isSelected}
                        onChange={() =>
                          setSelectedRunIds((current) =>
                            toggleSelectedId(current, run.id),
                          )
                        }
                        aria-label={`Select ${runTypeLabel(run)} run`}
                      />
                    </td>
                    <td className="processing-col-request">
                      <div className="table-cell-stack table-request-cell">
                        <strong>{runTypeLabel(run)}</strong>
                        <span className="table-note">
                          {runSummaryLabel(run)}
                        </span>
                        {run.last_error ? (
                          <span className="processing-row-error">
                            {run.last_error}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <StatusPill value={run.status} />
                    </td>
                    <td>{runModeLabel(run.mode)}</td>
                    <td>{formatBookDateTime(getRunActivityAt(run))}</td>
                    <td>
                      <div className="table-actions">
                        {isActiveStatus(run.status) ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => stopRun(run.id)}
                            disabled={
                              busyRunId === run.id || sourceTabButtonsDisabled
                            }
                          >
                            {busyRunId === run.id ? "Stopping..." : "Stop"}
                          </button>
                        ) : (
                          <span className="table-note">-</span>
                        )}
                        <button
                          type="button"
                          className="ghost-button danger-button processing-inline-danger"
                          onClick={() =>
                            openDeleteDialog(
                              "run-single",
                              [run.id],
                              "Delete run",
                              "This run will be removed from history.",
                            )
                          }
                          disabled={isDeleting || sourceTabButtonsDisabled}
                        >
                          {isDeleting ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </QueueTableCard>
    );
  }

  function renderUserTab() {
    return (
      <div className="processing-section-grid">
        {renderSubmissionsCard("Requests")}
        {renderJobsCard("Book Creation")}
        {renderDuplicateCard("Duplicate Checks")}
      </div>
    );
  }

  function renderSourceTab() {
    return (
      <div className="processing-section-grid">
        {renderCatalogSummaryCard()}
        {renderCatalogCard()}
        {renderJobsCard("Book Creation", "processing-catalog-height-card")}
        {renderSubmissionsCard("Catalog Requests")}
        {renderDuplicateCard("Duplicate Checks")}
      </div>
    );
  }

  function renderAutomationTab() {
    const nextRunContent = loading ? (
      <span className="processing-card-count">
        <LoadingSpinner size={14} />
      </span>
    ) : automationState?.settings?.next_run_at ? (
      <span className="processing-card-count">
        {formatBookDateTime(automationState.settings.next_run_at)}
      </span>
    ) : null;

    return (
      <div className="processing-section-grid">
        <section className="detail-card processing-card processing-summary-card card-automation">
          <div className="processing-card-head">
            <div className="section-title-block">
              <h2>Automation</h2>
            </div>
            <div className="processing-card-head-meta">
              {nextRunContent}
              {!loading ? (
                <label
                  className="processing-switch"
                  title={
                    automationForm.enabled
                      ? "Automation enabled"
                      : "Automation disabled"
                  }
                >
                  <input
                    type="checkbox"
                    aria-label={
                      automationForm.enabled
                        ? "Disable automation"
                        : "Enable automation"
                    }
                    checked={automationForm.enabled}
                    onChange={(event) =>
                      setAutomationForm({
                        ...automationForm,
                        enabled: event.target.checked,
                      })
                    }
                  />
                  <span className="processing-switch-track" aria-hidden="true">
                    <span className="processing-switch-state">
                      {automationForm.enabled ? "On" : "Off"}
                    </span>
                    <span className="processing-switch-thumb" />
                  </span>
                </label>
              ) : null}
            </div>
          </div>
          <div className="processing-automation-body">
            {loading ? (
              renderProcessingCardLoader("Loading automation settings")
            ) : (
              <form
                className="stack-form processing-automation-form"
                onSubmit={saveAutomation}
              >
                <div className="detail-facts processing-automation-grid">
                  <label>
                    <span className="fact-label">Time</span>
                    <input
                      type="time"
                      value={automationForm.daily_run_time}
                      onChange={(event) =>
                        setAutomationForm({
                          ...automationForm,
                          daily_run_time: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span className="fact-label">Frequency</span>
                    <select
                      value={automationForm.frequency}
                      onChange={(event) =>
                        setAutomationForm({
                          ...automationForm,
                          frequency: event.target.value,
                        })
                      }
                    >
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="biweekly">Bi-weekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="bimonthly">Bi-monthly</option>
                      <option value="quarterly">Every 3 months</option>
                      <option value="four_monthly">Every 4 months</option>
                      <option value="half_yearly">Half-yearly</option>
                    </select>
                  </label>
                  <label>
                    <span className="fact-label">Mode</span>
                    <select
                      value={automationForm.mode}
                      onChange={(event) =>
                        setAutomationForm({
                          ...automationForm,
                          mode: event.target.value,
                        })
                      }
                    >
                      <option value="pending">New + unfinished</option>
                      <option value="all">All tracked</option>
                    </select>
                  </label>
                  <label>
                    <span className="fact-label">Pages</span>
                    <input
                      type="number"
                      min="1"
                      max="80"
                      value={automationForm.refresh_max_pages}
                      onChange={(event) =>
                        setAutomationForm({
                          ...automationForm,
                          refresh_max_pages: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <div className="processing-card-actions processing-automation-save-actions">
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={savingAutomation}
                  >
                    <span className="button-label">
                      {savingAutomation ? <LoadingSpinner size={14} /> : null}
                      Save automation
                    </span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>
        {renderSubmissionsCard("Automation Requests")}
        {renderJobsCard("Book Creation")}
        {renderRunsCard("Run History")}
        {renderDuplicateCard("Duplicate Checks")}
      </div>
    );
  }

  function renderAllTab() {
    return (
      <div className="processing-section-grid">
        {renderSubmissionsCard("All Requests")}
        {renderJobsCard("Book Creation")}
        {renderRunsCard("Run History")}
        {renderDuplicateCard("Duplicate Checks")}
      </div>
    );
  }

  return (
    <div className="page-stack processing-page">
      <section className="detail-card">
        <div className="panel-header">
          <div className="section-title-block">
            <h1>Processing</h1>
          </div>
          {loading ? <LoadingSpinner size={18} /> : null}
        </div>
        {tabs.length > 1 ? (
          <div
            className="admin-tab-grid processing-tab-grid"
            role="tablist"
            aria-label="Processing sections"
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={
                  activeTab === tab.id
                    ? "admin-tab-card is-active"
                    : "admin-tab-card"
                }
                onClick={() => applyActiveTab(tab.id)}
              >
                <span className="admin-tab-label">{tab.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        {error ? (
          <div className="page-state page-state-error">{error}</div>
        ) : null}
      </section>

      {activeTab === USER_TAB ? renderUserTab() : null}
      {activeTab === SOURCE_TAB ? renderSourceTab() : null}
      {activeTab === AUTOMATION_TAB ? renderAutomationTab() : null}
      {activeTab === ALL_TAB ? renderAllTab() : null}

      {reviewSubmission ? (
        <div className="dialog-backdrop" role="presentation">
          <section className="dialog-card" role="dialog" aria-modal="true">
            <div className="dialog-header">
              <h2>Review Match</h2>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setReviewSubmission(null)}
              >
                Close
              </button>
            </div>
            <div className="dialog-stack">
              {reviewSubmission.candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className="candidate-button"
                  onClick={() =>
                    confirmCandidate(reviewSubmission.id, candidate.id)
                  }
                >
                  <span>{candidate.candidate_title}</span>
                  <small>
                    {candidate.candidate_author ||
                      `${Math.round(candidate.confidence * 100)}%`}
                  </small>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      <ConfirmationDialog
        open={Boolean(confirmState)}
        title={confirmState?.title || ""}
        body={confirmState?.body || ""}
        confirmLabel="Delete"
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmState(null)}
        loading={confirmLoading}
      />
    </div>
  );
}
