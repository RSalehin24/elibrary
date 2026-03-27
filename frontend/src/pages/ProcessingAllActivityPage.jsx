import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../api/client";
import BookRouteLink from "../components/BookRouteLink";
import CatalogToolbar, { CatalogSearchRow } from "../components/CatalogToolbar";
import ConfirmationDialog from "../components/ConfirmationDialog";
import EmptyState from "../components/EmptyState";
import LoadingSpinner from "../components/LoadingSpinner";
import ProcessingJobReviewCard from "../components/ProcessingJobReviewCard";
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
const INCOMPLETE_TAB = "incomplete";

const LOAD_SCOPE_SUBMISSIONS = "submissions";
const LOAD_SCOPE_JOBS = "jobs";
const LOAD_SCOPE_JOB_REVIEWS = "jobReviews";
const LOAD_SCOPE_REVIEWS = "reviews";
const LOAD_SCOPE_CATALOG_BROWSE = "catalogBrowse";
const LOAD_SCOPE_CATALOG_OVERVIEW = "catalogOverview";
const LOAD_SCOPE_RUNS = "runs";
const LOAD_SCOPE_AUTOMATION = "automation";
const LOAD_SCOPE_INCOMPLETE_BROWSE = "incompleteBrowse";
const LOAD_SCOPE_INCOMPLETE_OVERVIEW = "incompleteOverview";

const ALL_LOAD_SCOPES = [
  LOAD_SCOPE_SUBMISSIONS,
  LOAD_SCOPE_JOBS,
  LOAD_SCOPE_JOB_REVIEWS,
  LOAD_SCOPE_REVIEWS,
  LOAD_SCOPE_CATALOG_BROWSE,
  LOAD_SCOPE_CATALOG_OVERVIEW,
  LOAD_SCOPE_RUNS,
  LOAD_SCOPE_AUTOMATION,
  LOAD_SCOPE_INCOMPLETE_BROWSE,
  LOAD_SCOPE_INCOMPLETE_OVERVIEW,
];

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

const defaultIncompleteFilters = {
  q: "",
  status: "",
};

const defaultRemovedFilters = {
  q: "",
  range: "week",
};

const defaultCatalogSummary = {
  total: 0,
  new: 0,
  queued: 0,
  processing: 0,
  stopped: 0,
  requeued: 0,
  unfinished: 0,
  failed: 0,
  ready: 0,
  deleted: 0,
};

const defaultIncompleteSummary = {
  total_incomplete_books: 0,
  removed_from_unfinished: 0,
  still_in_unfinished: 0,
  missing_in_catalog: 0,
  queued: 0,
  processing: 0,
  failed: 0,
  stopped: 0,
  requeued: 0,
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
      { value: "stopped", label: "Stopped" },
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
      { value: "needs_review", label: "Needs review" },
      { value: "ready", label: "Ready" },
      { value: "failed", label: "Failed" },
      { value: "stopped", label: "Stopped" },
      { value: "succeeded", label: "Complete" },
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
      { value: "catalog_refresh", label: "Catalog refresh" },
      { value: "curation", label: "Curation run" },
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
      { value: "stopped", label: "Stopped" },
      { value: "requeued", label: "Requeued" },
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
      { value: "stopped", label: "Stopped" },
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

const incompleteFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "removed", label: "Removed from unfinished" },
      { value: "still", label: "Still in unfinished" },
      { value: "missing", label: "Missing in catalog" },
    ],
  },
];

const removedFilterFields = [
  {
    key: "range",
    label: "Range",
    type: "select",
    options: [
      { value: "day", label: "Past day" },
      { value: "week", label: "Past week" },
      { value: "month", label: "Past month" },
      { value: "year", label: "Past year" },
    ],
  },
];

function normalizeTimeInput(value) {
  return (value || "02:00:00").slice(0, 5);
}

function automationFormFromSettings(settings) {
  return {
    enabled: Boolean(settings?.enabled),
    daily_run_time: normalizeTimeInput(settings?.daily_run_time),
    frequency: settings?.frequency || "daily",
    mode: settings?.mode || "pending",
    refresh_max_pages: String(settings?.refresh_max_pages || 80),
  };
}

function getOriginForTab(tab) {
  if (tab === SOURCE_TAB) {
    return "curation";
  }
  if (tab === INCOMPLETE_TAB) {
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

function normalizeStatusForApi(value) {
  return value === "stopped" ? "cancelled" : value;
}

function cutoffForPeriod(period) {
  const now = new Date();
  if (period === "day") {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
  if (period === "week") {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  if (period === "month") {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
}

function isActiveStatus(value) {
  return ["queued", "processing"].includes(value);
}

function isResumableJob(job) {
  if (!job) {
    return false;
  }
  if (job.status === "stopped") {
    return true;
  }
  return job.status === "queued" && !job.task_id;
}

function isCatalogSyncActive(value) {
  return ["queued", "processing"].includes(value);
}

function buildJobsParams(filters, tab) {
  const params = {
    q: filters.q,
    job_type: filters.job_type,
    limit: 60,
  };
  if (filters.status) {
    const normalizedStatus = normalizeStatusForApi(filters.status);
    if (
      ["succeeded", "queued", "processing", "failed", "cancelled"].includes(
        normalizedStatus,
      )
    ) {
      params.status = normalizedStatus;
    } else if (
      ["needs_review", "ready", "duplicate"].includes(normalizedStatus)
    ) {
      params.submission_status = normalizedStatus;
    }
  }
  const origin = getOriginForTab(tab);
  if (origin) {
    params.origin = origin;
  }
  return params;
}

function isDefaultJobRequest(filters) {
  return (
    String(filters?.q || "") === defaultJobFilters.q &&
    String(filters?.status || "") === defaultJobFilters.status &&
    String(filters?.job_type || "") === defaultJobFilters.job_type
  );
}

function buildSubmissionParams(filters, tab) {
  const params = { ...filters, limit: 60 };
  if (params.status) {
    params.status = normalizeStatusForApi(params.status);
  }
  const origin = getOriginForTab(tab);
  if (origin) {
    params.origin = origin;
  }
  return params;
}

function buildReviewParams(filters, tab) {
  const params = { ...filters, limit: 40 };
  const origin = getOriginForTab(tab);
  if (origin) {
    params.origin = origin;
  }
  return params;
}

function buildRunParams(filters, tab) {
  const params = { ...filters, limit: 20 };
  if (params.status) {
    params.status = normalizeStatusForApi(params.status);
  }
  if (tab === AUTOMATION_TAB) {
    params.trigger = "scheduled";
  }
  return params;
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

function buildSubmissionOverviewSummary(submissionRows) {
  return (submissionRows || []).reduce(
    (summary, submission) => {
      const status = submission?.status;
      if (status && Object.hasOwn(summary, status)) {
        summary[status] += 1;
      }
      summary.total += 1;
      return summary;
    },
    {
      total: 0,
      pending_resolution: 0,
      queued: 0,
      processing: 0,
      needs_review: 0,
      ready: 0,
      failed: 0,
      stopped: 0,
      duplicate: 0,
    },
  );
}

function getUniqueSubmissionIds(jobRows, selectedJobIdSet = null) {
  return Array.from(
    new Set(
      (jobRows || [])
        .filter(
          (job) =>
            job.submission_id &&
            (!selectedJobIdSet || selectedJobIdSet.has(job.id)),
        )
        .map((job) => job.submission_id),
    ),
  );
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

function getRequeueReasonText(job) {
  return (
    job.requeue_reason ||
    job.last_error ||
    "No failure details were recorded for this requeue."
  );
}

function filterJobsByControls(jobRows, filters) {
  const query = String(filters.q || "")
    .trim()
    .toLowerCase();
  return jobRows.filter((job) => {
    if (filters.status && job.status !== filters.status) {
      return false;
    }
    if (filters.job_type && job.job_type !== filters.job_type) {
      return false;
    }
    if (!query) {
      return true;
    }
    const requestText = getRequestPrimaryText(job.submission_input)
      .toLowerCase()
      .trim();
    const errorText = String(job.last_error || "").toLowerCase();
    return requestText.includes(query) || errorText.includes(query);
  });
}

function getCatalogEntryActivityAt(entry) {
  return entry.activity_at || entry.updated_at || entry.last_seen_at;
}

function getCatalogPageLabel(pagination) {
  const currentPage = pagination?.page || 1;
  const pageCount = pagination?.page_count || 1;
  return `Page ${currentPage} / ${pageCount}`;
}

function isDefaultCatalogBrowseRequest(filters) {
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

function canCreateCatalogEntry(entry) {
  return [
    "new",
    "failed",
    "stopped",
    "requeued",
    "unfinished",
    "deleted",
  ].includes(entry.curation_status);
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
    <BookRouteLink slug={submission.linked_book_slug} className="meta-link">
      {submission.linked_book?.title || submission.linked_book_slug}
    </BookRouteLink>
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
      <span className="processing-card-count">
        {loading ? <LoadingSpinner size={14} /> : count}
      </span>
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

export default function ProcessingAllActivityPage() {
  const { user } = useSession();
  const toast = useToast();
  const canManageProcessing = hasCapability(user, "processing:manage");
  const activeTab = ALL_TAB;
  const [jobs, setJobs] = useState([]);
  const [jobReviewRows, setJobReviewRows] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [duplicateReviews, setDuplicateReviews] = useState([]);
  const [catalogEntries, setCatalogEntries] = useState([]);
  const [catalogOverviewEntries, setCatalogOverviewEntries] = useState([]);
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
  const [incompleteFilters, setIncompleteFilters] = useState(
    defaultIncompleteFilters,
  );
  const [removedFilters, setRemovedFilters] = useState(defaultRemovedFilters);
  const [requeueFilters, setRequeueFilters] = useState(defaultJobFilters);
  const [failedFilters, setFailedFilters] = useState(defaultJobFilters);
  const [submissionFiltersExpanded, setSubmissionFiltersExpanded] =
    useState(false);
  const [jobFiltersExpanded, setJobFiltersExpanded] = useState(false);
  const [catalogFiltersExpanded, setCatalogFiltersExpanded] = useState(false);
  const [runFiltersExpanded, setRunFiltersExpanded] = useState(false);
  const [reviewFiltersExpanded, setReviewFiltersExpanded] = useState(false);
  const [incompleteFiltersExpanded, setIncompleteFiltersExpanded] =
    useState(false);
  const [removedFiltersExpanded, setRemovedFiltersExpanded] = useState(false);
  const [requeueFiltersExpanded, setRequeueFiltersExpanded] = useState(false);
  const [failedFiltersExpanded, setFailedFiltersExpanded] = useState(false);
  const [selectedSubmissionIds, setSelectedSubmissionIds] = useState([]);
  const [selectedJobIds, setSelectedJobIds] = useState([]);
  const [selectedCatalogEntryIds, setSelectedCatalogEntryIds] = useState([]);
  const [selectedRunIds, setSelectedRunIds] = useState([]);
  const [selectedIncompleteBookIds, setSelectedIncompleteBookIds] = useState(
    [],
  );
  const [selectedRequeueJobIds, setSelectedRequeueJobIds] = useState([]);
  const [selectedFailedJobIds, setSelectedFailedJobIds] = useState([]);
  const [selectedDuplicateReviewIds, setSelectedDuplicateReviewIds] = useState(
    [],
  );
  const [automationState, setAutomationState] = useState(null);
  const [incompleteEntries, setIncompleteEntries] = useState([]);
  const [incompleteOverviewEntries, setIncompleteOverviewEntries] = useState(
    [],
  );
  const [incompleteSummary, setIncompleteSummary] = useState(
    defaultIncompleteSummary,
  );
  const [automationForm, setAutomationForm] = useState({
    enabled: false,
    daily_run_time: "02:00",
    frequency: "daily",
    mode: "pending",
    refresh_max_pages: "80",
  });
  const [loading, setLoading] = useState(true);
  const [submissionsLoading, setSubmissionsLoading] = useState(true);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobReviewsLoading, setJobReviewsLoading] = useState(true);
  const [reviewsLoading, setReviewsLoading] = useState(true);
  const [catalogBrowseLoading, setCatalogBrowseLoading] = useState(true);
  const [catalogOverviewLoading, setCatalogOverviewLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [automationLoading, setAutomationLoading] = useState(true);
  const [incompleteBrowseLoading, setIncompleteBrowseLoading] = useState(true);
  const [incompleteOverviewLoading, setIncompleteOverviewLoading] =
    useState(true);
  const [error, setError] = useState("");
  const [reviewSubmission, setReviewSubmission] = useState(null);
  const [creatingCatalog, setCreatingCatalog] = useState(false);
  const [catalogActionMode, setCatalogActionMode] = useState("");
  const [savingAutomation, setSavingAutomation] = useState(false);
  const [busyActionId, setBusyActionId] = useState("");
  const [busyRunId, setBusyRunId] = useState("");
  const [busyDeleteId, setBusyDeleteId] = useState("");
  const [activeRequeueJobId, setActiveRequeueJobId] = useState("");
  const [activeFailedJobId, setActiveFailedJobId] = useState("");
  const [activeFailedJobLogs, setActiveFailedJobLogs] = useState([]);
  const [loadingFailedLogs, setLoadingFailedLogs] = useState(false);
  const [bulkActionKey, setBulkActionKey] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [stoppingCatalogSync, setStoppingCatalogSync] = useState(false);
  const [catalogSyncDismissed, setCatalogSyncDismissed] = useState(false);

  const defaultScopes = useMemo(
    () => [
      LOAD_SCOPE_SUBMISSIONS,
      LOAD_SCOPE_JOBS,
      LOAD_SCOPE_JOB_REVIEWS,
      ...(canManageProcessing ? [LOAD_SCOPE_REVIEWS, LOAD_SCOPE_RUNS] : []),
    ],
    [canManageProcessing],
  );

  const globalActionsLocked = Boolean(
    busyActionId ||
    busyRunId ||
    busyDeleteId ||
    bulkActionKey ||
    confirmLoading,
  );
  const sourceTabButtonsDisabled = globalActionsLocked;
  const creationActionsDisabled = globalActionsLocked;

  function getScopesForTab() {
    return defaultScopes;
  }

  function setScopeLoading(scopes, isLoading) {
    if (scopes.has(LOAD_SCOPE_SUBMISSIONS)) {
      setSubmissionsLoading(isLoading);
    }
    if (scopes.has(LOAD_SCOPE_JOBS)) {
      setJobsLoading(isLoading);
    }
    if (scopes.has(LOAD_SCOPE_JOB_REVIEWS)) {
      setJobReviewsLoading(isLoading);
    }
    if (scopes.has(LOAD_SCOPE_REVIEWS)) {
      setReviewsLoading(isLoading);
    }
    if (scopes.has(LOAD_SCOPE_CATALOG_BROWSE)) {
      setCatalogBrowseLoading(isLoading);
    }
    if (scopes.has(LOAD_SCOPE_CATALOG_OVERVIEW)) {
      setCatalogOverviewLoading(isLoading);
    }
    if (scopes.has(LOAD_SCOPE_RUNS)) {
      setRunsLoading(isLoading);
    }
    if (scopes.has(LOAD_SCOPE_AUTOMATION)) {
      setAutomationLoading(isLoading);
    }
    if (scopes.has(LOAD_SCOPE_INCOMPLETE_BROWSE)) {
      setIncompleteBrowseLoading(isLoading);
    }
    if (scopes.has(LOAD_SCOPE_INCOMPLETE_OVERVIEW)) {
      setIncompleteOverviewLoading(isLoading);
    }
  }

  async function load(options = {}) {
    const {
      nextTab = activeTab,
      nextJobFilters = jobFilters,
      nextSubmissionFilters = submissionFilters,
      nextCatalogFilters = catalogFilters,
      nextRunFilters = runFilters,
      nextReviewFilters = reviewFilters,
      nextIncompleteFilters = incompleteFilters,
      preserveAutomationForm = false,
      silent = false,
      scopes: requestedScopes = null,
    } = options;
    const scopes = new Set(requestedScopes || getScopesForTab(nextTab));
    const isFullTabLoad = !requestedScopes;

    if (!silent) {
      if (isFullTabLoad) {
        setLoading(true);
      }
      setScopeLoading(scopes, true);
    }

    try {
      const requests = [];
      const shouldReuseJobReviewRows =
        scopes.has(LOAD_SCOPE_JOBS) &&
        scopes.has(LOAD_SCOPE_JOB_REVIEWS) &&
        isDefaultJobRequest(nextJobFilters);
      const shouldReuseCatalogOverview =
        scopes.has(LOAD_SCOPE_CATALOG_BROWSE) &&
        scopes.has(LOAD_SCOPE_CATALOG_OVERVIEW) &&
        isDefaultCatalogBrowseRequest(nextCatalogFilters);
      const queueScopeRequest = (scope, url) => {
        requests.push(
          apiFetch(url).then((payload) => ({
            scope,
            payload,
          })),
        );
      };

      if (scopes.has(LOAD_SCOPE_JOBS)) {
        queueScopeRequest(
          LOAD_SCOPE_JOBS,
          `/ingestion/jobs/${toQueryString(
            buildJobsParams(nextJobFilters, nextTab),
          )}`,
        );
      }

      if (scopes.has(LOAD_SCOPE_JOB_REVIEWS)) {
        if (!shouldReuseJobReviewRows) {
          queueScopeRequest(
            LOAD_SCOPE_JOB_REVIEWS,
            `/ingestion/jobs/${toQueryString(
              buildJobsParams(defaultJobFilters, nextTab),
            )}`,
          );
        }
      }

      if (scopes.has(LOAD_SCOPE_SUBMISSIONS)) {
        queueScopeRequest(
          LOAD_SCOPE_SUBMISSIONS,
          `/ingestion/submissions/${toQueryString(
            buildSubmissionParams(nextSubmissionFilters, nextTab),
          )}`,
        );
      }

      if (scopes.has(LOAD_SCOPE_REVIEWS)) {
        queueScopeRequest(
          LOAD_SCOPE_REVIEWS,
          `/ingestion/duplicate-reviews/${toQueryString(
            buildReviewParams(nextReviewFilters, nextTab),
          )}`,
        );
      }

      if (scopes.has(LOAD_SCOPE_CATALOG_BROWSE)) {
        queueScopeRequest(
          LOAD_SCOPE_CATALOG_BROWSE,
          `/ingestion/catalog/entries/${toQueryString({
            ...nextCatalogFilters,
            limit: Number(nextCatalogFilters.limit) || 180,
          })}`,
        );
      }

      if (scopes.has(LOAD_SCOPE_CATALOG_OVERVIEW)) {
        if (!shouldReuseCatalogOverview) {
          queueScopeRequest(
            LOAD_SCOPE_CATALOG_OVERVIEW,
            `/ingestion/catalog/entries/${toQueryString({
              ...defaultCatalogFilters,
              page: 1,
              limit: defaultCatalogFilters.limit,
            })}`,
          );
        }
      }

      if (scopes.has(LOAD_SCOPE_INCOMPLETE_BROWSE)) {
        queueScopeRequest(
          LOAD_SCOPE_INCOMPLETE_BROWSE,
          `/ingestion/catalog/incomplete-check/${toQueryString(
            nextIncompleteFilters,
          )}`,
        );
      }

      if (scopes.has(LOAD_SCOPE_INCOMPLETE_OVERVIEW)) {
        queueScopeRequest(
          LOAD_SCOPE_INCOMPLETE_OVERVIEW,
          `/ingestion/catalog/incomplete-check/${toQueryString(
            defaultIncompleteFilters,
          )}`,
        );
      }

      if (scopes.has(LOAD_SCOPE_RUNS)) {
        queueScopeRequest(
          LOAD_SCOPE_RUNS,
          `/ingestion/catalog/curation-runs/${toQueryString(
            buildRunParams(nextRunFilters, nextTab),
          )}`,
        );
      }

      if (scopes.has(LOAD_SCOPE_AUTOMATION)) {
        queueScopeRequest(
          LOAD_SCOPE_AUTOMATION,
          "/ingestion/catalog/automation/",
        );
      }

      const payloads = await Promise.all(requests);
      const payloadByScope = new Map(
        payloads.map(({ scope, payload }) => [scope, payload]),
      );

      if (payloadByScope.has(LOAD_SCOPE_JOBS)) {
        setJobs(payloadByScope.get(LOAD_SCOPE_JOBS) || []);
      }

      if (payloadByScope.has(LOAD_SCOPE_JOB_REVIEWS) || shouldReuseJobReviewRows) {
        setJobReviewRows(
          (shouldReuseJobReviewRows
            ? payloadByScope.get(LOAD_SCOPE_JOBS)
            : payloadByScope.get(LOAD_SCOPE_JOB_REVIEWS)) || [],
        );
      }

      if (payloadByScope.has(LOAD_SCOPE_SUBMISSIONS)) {
        setSubmissions(payloadByScope.get(LOAD_SCOPE_SUBMISSIONS) || []);
      }

      if (payloadByScope.has(LOAD_SCOPE_REVIEWS)) {
        setDuplicateReviews(payloadByScope.get(LOAD_SCOPE_REVIEWS) || []);
      }

      if (payloadByScope.has(LOAD_SCOPE_CATALOG_BROWSE)) {
        const catalogPayload =
          payloadByScope.get(LOAD_SCOPE_CATALOG_BROWSE) || null;
        setCatalogEntries(catalogPayload?.entries || []);
        setCatalogPagination(
          catalogPayload?.pagination || defaultCatalogPagination,
        );
      }

      if (
        payloadByScope.has(LOAD_SCOPE_CATALOG_OVERVIEW) ||
        shouldReuseCatalogOverview
      ) {
        const catalogPayload =
          (shouldReuseCatalogOverview
            ? payloadByScope.get(LOAD_SCOPE_CATALOG_BROWSE)
            : payloadByScope.get(LOAD_SCOPE_CATALOG_OVERVIEW)) || null;
        setCatalogOverviewEntries(catalogPayload?.entries || []);
        setCatalogSummary(catalogPayload?.summary || defaultCatalogSummary);
        setCatalogSyncState(catalogPayload?.sync_state || null);
      }

      if (payloadByScope.has(LOAD_SCOPE_RUNS)) {
        setCurationRuns(payloadByScope.get(LOAD_SCOPE_RUNS) || []);
      }

      if (payloadByScope.has(LOAD_SCOPE_INCOMPLETE_BROWSE)) {
        const incompletePayload =
          payloadByScope.get(LOAD_SCOPE_INCOMPLETE_BROWSE) || null;
        setIncompleteEntries(incompletePayload?.entries || []);
      }

      if (payloadByScope.has(LOAD_SCOPE_INCOMPLETE_OVERVIEW)) {
        const incompletePayload =
          payloadByScope.get(LOAD_SCOPE_INCOMPLETE_OVERVIEW) || null;
        setIncompleteOverviewEntries(incompletePayload?.entries || []);
        setIncompleteSummary(
          incompletePayload?.summary || defaultIncompleteSummary,
        );
      }

      if (payloadByScope.has(LOAD_SCOPE_AUTOMATION)) {
        const automationPayload =
          payloadByScope.get(LOAD_SCOPE_AUTOMATION) || null;
        setAutomationState(automationPayload);
        if (
          !preserveAutomationForm &&
          automationPayload?.settings &&
          [AUTOMATION_TAB, INCOMPLETE_TAB].includes(nextTab)
        ) {
          setAutomationForm(automationFormFromSettings(automationPayload.settings));
        }
      }

      if (isFullTabLoad) {
        const defaultScopes = new Set(getScopesForTab(nextTab));
        const hiddenScopes = new Set(
          ALL_LOAD_SCOPES.filter((scope) => !defaultScopes.has(scope)),
        );
        setScopeLoading(hiddenScopes, false);
        if (!defaultScopes.has(LOAD_SCOPE_SUBMISSIONS)) {
          setSubmissions([]);
        }
        if (!defaultScopes.has(LOAD_SCOPE_JOBS)) {
          setJobs([]);
        }
        if (!defaultScopes.has(LOAD_SCOPE_JOB_REVIEWS)) {
          setJobReviewRows([]);
        }
        if (!defaultScopes.has(LOAD_SCOPE_REVIEWS)) {
          setDuplicateReviews([]);
        }
        if (!defaultScopes.has(LOAD_SCOPE_CATALOG_BROWSE)) {
          setCatalogEntries([]);
          setCatalogPagination(defaultCatalogPagination);
        }
        if (!defaultScopes.has(LOAD_SCOPE_CATALOG_OVERVIEW)) {
          setCatalogOverviewEntries([]);
          setCatalogSummary(defaultCatalogSummary);
          setCatalogSyncState(null);
        }
        if (!defaultScopes.has(LOAD_SCOPE_RUNS)) {
          setCurationRuns([]);
        }
        if (!defaultScopes.has(LOAD_SCOPE_AUTOMATION)) {
          setAutomationState(null);
        }
        if (!defaultScopes.has(LOAD_SCOPE_INCOMPLETE_BROWSE)) {
          setIncompleteEntries([]);
        }
        if (!defaultScopes.has(LOAD_SCOPE_INCOMPLETE_OVERVIEW)) {
          setIncompleteOverviewEntries([]);
          setIncompleteSummary(defaultIncompleteSummary);
        }
      }

      setError("");
    } catch (nextError) {
      if (!silent) {
        setError(nextError.message);
        toast.error(nextError.message);
      }
    } finally {
      if (!silent) {
        setScopeLoading(scopes, false);
        if (isFullTabLoad) {
          setLoading(false);
        }
      }
    }
  }


  useEffect(() => {
    load({ nextTab: activeTab }).catch(() => {});
  }, [user?.id, canManageProcessing, activeTab]);

  useEffect(() => {
    const hasActiveJobs = [...jobs, ...jobReviewRows].some((job) =>
      isActiveStatus(job.status),
    );
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
    jobReviewRows,
    curationRuns,
    catalogSyncState,
    automationState,
    activeTab,
    jobFilters,
    submissionFilters,
    catalogFilters,
    runFilters,
    reviewFilters,
    incompleteFilters,
  ]);

  useEffect(() => {
    setSelectedSubmissionIds([]);
    setSelectedJobIds([]);
    setSelectedCatalogEntryIds([]);
    setSelectedRunIds([]);
    setSelectedIncompleteBookIds([]);
    setSelectedRequeueJobIds([]);
    setSelectedFailedJobIds([]);
    setSelectedDuplicateReviewIds([]);
    setCatalogSyncDismissed(false);
  }, [activeTab]);

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

  useEffect(() => {
    setSelectedIncompleteBookIds((current) =>
      current.filter((id) =>
        incompleteEntries.some((entry) => entry.book_id === id),
      ),
    );
  }, [incompleteEntries]);

  function resetWithLoad(nextValue, setter, key, scopes) {
    setter(nextValue);
    load({
      [key]: nextValue,
      preserveAutomationForm: true,
      scopes,
    }).catch(() => {});
  }

  function applyCatalogFilters(nextFilters) {
    setCatalogFilters(nextFilters);
    load({
      nextCatalogFilters: nextFilters,
      preserveAutomationForm: true,
      scopes: [LOAD_SCOPE_CATALOG_BROWSE],
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

  async function reloadScoped(scopes, options = {}) {
    await load({ preserveAutomationForm: true, scopes, ...options });
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

  async function resolveDuplicateBulk(reviewIds, decision) {
    const uniqueIds = Array.from(new Set((reviewIds || []).filter(Boolean)));
    if (!uniqueIds.length) {
      return;
    }

    setBulkActionKey(`duplicate:${decision}`);
    try {
      let resolvedCount = 0;
      for (const reviewId of uniqueIds) {
        await apiFetch(`/ingestion/duplicate-reviews/${reviewId}/resolve/`, {
          method: "POST",
          body: { decision },
        });
        resolvedCount += 1;
      }
      toast.success(
        decision === "confirm_existing"
          ? `${resolvedCount} duplicate checks kept existing book.`
          : `${resolvedCount} duplicate checks queued as new.`,
      );
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBulkActionKey("");
    }
  }

  async function retrySubmissionsBulk(submissionIds, actionKey) {
    const uniqueIds = Array.from(
      new Set((submissionIds || []).filter(Boolean)),
    );
    if (!uniqueIds.length || creationActionsDisabled) {
      return;
    }

    setBulkActionKey(actionKey);
    try {
      const payload = await apiFetch("/ingestion/submissions/bulk-retry/", {
        method: "POST",
        body: { ids: uniqueIds },
      });
      toast.success(
        summarizeResponse(payload, {
          queued_count: "queued",
          skipped_duplicate_targets: "grouped",
          skipped_invalid: "skipped",
        }) || "Requests queued.",
      );
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBulkActionKey("");
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
      const modeToSave =
        activeTab === INCOMPLETE_TAB ? "pending" : automationForm.mode;
      const payload = await apiFetch("/ingestion/catalog/automation/", {
        method: "PATCH",
        body: {
          enabled: automationForm.enabled,
          daily_run_time: automationForm.daily_run_time,
          frequency: automationForm.frequency,
          mode: modeToSave,
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
  const submissionOverview = useMemo(
    () => buildSubmissionOverviewSummary(submissions),
    [submissions],
  );

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
    .filter((job) => isResumableJob(job))
    .map((job) => job.id);
  const submissionStopIds = submissions
    .map((submission) => submission.latest_job)
    .filter((job) => job && isActiveStatus(job.status))
    .map((job) => job.id);
  const jobResumeIds = jobs
    .filter((job) => isResumableJob(job))
    .map((job) => job.id);
  const jobStopIds = jobs
    .filter((job) => isActiveStatus(job.status))
    .map((job) => job.id);
  const runStopIds = curationRuns
    .filter((run) => isActiveStatus(run.status))
    .map((run) => run.id);
  const failedJobs = useMemo(
    () => jobReviewRows.filter((job) => job.status === "failed"),
    [jobReviewRows],
  );
  const requeuedJobs = useMemo(
    () =>
      jobReviewRows.filter(
        (job) => job.is_requeued || job.job_type === "reprocess",
      ),
    [jobReviewRows],
  );
  const filteredRequeuedJobs = useMemo(
    () => filterJobsByControls(requeuedJobs, requeueFilters),
    [requeuedJobs, requeueFilters],
  );
  const filteredFailedJobs = useMemo(
    () => filterJobsByControls(failedJobs, failedFilters),
    [failedJobs, failedFilters],
  );

  const selectedRequeueJobIdSet = useMemo(
    () => new Set(selectedRequeueJobIds),
    [selectedRequeueJobIds],
  );
  const requeueJobIdsOnPage = useMemo(
    () => filteredRequeuedJobs.map((job) => job.id),
    [filteredRequeuedJobs],
  );
  const selectedRequeueCountOnPage = requeueJobIdsOnPage.filter((id) =>
    selectedRequeueJobIdSet.has(id),
  ).length;
  const allRequeueSelected =
    filteredRequeuedJobs.length > 0 &&
    selectedRequeueCountOnPage === filteredRequeuedJobs.length;
  const selectedRequeueSubmissionIds = getUniqueSubmissionIds(
    filteredRequeuedJobs,
    selectedRequeueJobIdSet,
  );
  const requeueSubmissionIds = getUniqueSubmissionIds(filteredRequeuedJobs);

  const selectedFailedJobIdSet = useMemo(
    () => new Set(selectedFailedJobIds),
    [selectedFailedJobIds],
  );
  const failedJobIdsOnPage = useMemo(
    () => filteredFailedJobs.map((job) => job.id),
    [filteredFailedJobs],
  );
  const selectedFailedCountOnPage = failedJobIdsOnPage.filter((id) =>
    selectedFailedJobIdSet.has(id),
  ).length;
  const allFailedSelected =
    filteredFailedJobs.length > 0 &&
    selectedFailedCountOnPage === filteredFailedJobs.length;
  const selectedFailedSubmissionIds = getUniqueSubmissionIds(
    filteredFailedJobs,
    selectedFailedJobIdSet,
  );
  const failedSubmissionIds = getUniqueSubmissionIds(filteredFailedJobs);

  const selectedDuplicateReviewIdSet = useMemo(
    () => new Set(selectedDuplicateReviewIds),
    [selectedDuplicateReviewIds],
  );
  const duplicateIdsOnPage = useMemo(
    () => duplicateReviews.map((review) => review.id),
    [duplicateReviews],
  );
  const selectedDuplicateCount = selectedDuplicateReviewIds.length;
  const selectedDuplicateCountOnPage = duplicateIdsOnPage.filter((id) =>
    selectedDuplicateReviewIdSet.has(id),
  ).length;
  const allDuplicatesSelected =
    duplicateReviews.length > 0 &&
    selectedDuplicateCountOnPage === duplicateReviews.length;
  const selectedDuplicateConfirmIds = duplicateReviews
    .filter(
      (review) =>
        selectedDuplicateReviewIdSet.has(review.id) &&
        !review.existing_book_deleted,
    )
    .map((review) => review.id);
  const selectedDuplicateDismissIds = duplicateReviews
    .filter((review) => selectedDuplicateReviewIdSet.has(review.id))
    .map((review) => review.id);
  const removedIncompleteEntries = useMemo(() => {
    const cutoff = cutoffForPeriod(removedFilters.range || "week");
    const query = String(removedFilters.q || "")
      .trim()
      .toLowerCase();
    return incompleteOverviewEntries.filter((entry) => {
      if (!entry.removed_from_unfinished) {
        return false;
      }
      if (!entry.updated_at) {
        return false;
      }
      const updatedAt = new Date(entry.updated_at);
      if (Number.isNaN(updatedAt.getTime()) || updatedAt < cutoff) {
        return false;
      }
      if (!query) {
        return true;
      }
      return String(entry.book_title || "")
        .toLowerCase()
        .includes(query);
    });
  }, [incompleteOverviewEntries, removedFilters]);
  const selectedSubmissionResumeIds = submissions
    .filter((submission) => selectedSubmissionIdSet.has(submission.id))
    .map((submission) => submission.latest_job)
    .filter((job) => isResumableJob(job))
    .map((job) => job.id);
  const selectedSubmissionStopIds = submissions
    .filter((submission) => selectedSubmissionIdSet.has(submission.id))
    .map((submission) => submission.latest_job)
    .filter((job) => job && isActiveStatus(job.status))
    .map((job) => job.id);
  const selectedJobResumeIds = jobs
    .filter((job) => selectedJobIdSet.has(job.id) && isResumableJob(job))
    .map((job) => job.id);
  const selectedJobStopIds = jobs
    .filter((job) => selectedJobIdSet.has(job.id) && isActiveStatus(job.status))
    .map((job) => job.id);
  const selectedRunStopIds = curationRuns
    .filter((run) => selectedRunIdSet.has(run.id) && isActiveStatus(run.status))
    .map((run) => run.id);

  useEffect(() => {
    setSelectedRequeueJobIds((current) =>
      current.filter((id) => requeuedJobs.some((job) => job.id === id)),
    );
  }, [requeuedJobs]);

  useEffect(() => {
    setSelectedFailedJobIds((current) =>
      current.filter((id) => failedJobs.some((job) => job.id === id)),
    );
  }, [failedJobs]);

  useEffect(() => {
    setSelectedDuplicateReviewIds((current) =>
      current.filter((id) => duplicateReviews.some((review) => review.id === id)),
    );
  }, [duplicateReviews]);

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

  useEffect(() => {
    if (!requeuedJobs.length) {
      setActiveRequeueJobId("");
      return;
    }

    const exists = requeuedJobs.some((job) => job.id === activeRequeueJobId);
    if (!exists) {
      setActiveRequeueJobId(requeuedJobs[0].id);
    }
  }, [activeRequeueJobId, requeuedJobs]);

  useEffect(() => {
    if (!failedJobs.length) {
      setActiveFailedJobId("");
      setActiveFailedJobLogs([]);
      return;
    }

    const exists = failedJobs.some((job) => job.id === activeFailedJobId);
    if (!exists) {
      setActiveFailedJobId(failedJobs[0].id);
    }
  }, [activeFailedJobId, failedJobs]);

  useEffect(() => {
    if (!activeFailedJobId) {
      setActiveFailedJobLogs([]);
      return;
    }

    let cancelled = false;
    setLoadingFailedLogs(true);
    apiFetch(`/ingestion/jobs/${activeFailedJobId}/logs/`)
      .then((payload) => {
        if (!cancelled) {
          setActiveFailedJobLogs(payload || []);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingFailedLogs(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeFailedJobId]);

  useEffect(() => {
    if (!filteredRequeuedJobs.length) {
      setActiveRequeueJobId("");
      return;
    }

    const exists = filteredRequeuedJobs.some(
      (job) => job.id === activeRequeueJobId,
    );
    if (!exists) {
      setActiveRequeueJobId(filteredRequeuedJobs[0].id);
    }
  }, [activeRequeueJobId, filteredRequeuedJobs]);

  useEffect(() => {
    if (!filteredFailedJobs.length) {
      setActiveFailedJobId("");
      setActiveFailedJobLogs([]);
      return;
    }

    const exists = filteredFailedJobs.some(
      (job) => job.id === activeFailedJobId,
    );
    if (!exists) {
      setActiveFailedJobId(filteredFailedJobs[0].id);
    }
  }, [activeFailedJobId, filteredFailedJobs]);

  function renderCardHeaderSearch({
    filters,
    setFilters,
    fields,
    defaultFilters,
    filtersExpanded,
    setFiltersExpanded,
    searchPlaceholder,
    resultCount,
    resultCountLoading = false,
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
        resultCountLoading={resultCountLoading}
        drawerId={drawerId}
        compact
        onSubmit={onSubmit}
        onSearchClear={onSearchClear}
        buttonsDisabled={buttonsDisabled}
      />
    );
  }

  function renderAllActivityOverviewCard() {
    const countPill = (
      <span className="processing-card-count">
        {submissionsLoading ? (
          <LoadingSpinner size={14} />
        ) : (
          submissionOverview.total
        )}
      </span>
    );

    return (
      <section className="detail-card processing-card processing-summary-card">
        <div className="processing-card-head">
          <div className="section-title-block">
            <h2>All Activity Overview</h2>
          </div>
          {countPill}
        </div>
        {submissionsLoading ? (
          renderProcessingCardLoader("Loading all activity overview")
        ) : (
          <div className="processing-summary-bar processing-summary-bar--catalog">
            {[
              ["Resolving", submissionOverview.pending_resolution],
              ["Queued", submissionOverview.queued],
              ["Processing", submissionOverview.processing],
              ["Needs Review", submissionOverview.needs_review],
              ["Ready", submissionOverview.ready],
              ["Failed", submissionOverview.failed],
              ["Stopped", submissionOverview.stopped],
              ["Duplicate", submissionOverview.duplicate],
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

  function renderSubmissionsCard(title, cardClassName = "") {
    return (
      <QueueTableCard
        title={title}
        emptyTitle="No requests"
        cardClassName={cardClassName}
        loading={submissionsLoading}
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
          resultCountLoading: submissionsLoading,
          drawerId: `${activeTab}-submission-filters`,
          onSubmit: (event, nextFilters) => {
            event.preventDefault();
            setSubmissionFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_SUBMISSIONS], {
              nextSubmissionFilters: nextFilters,
            }).catch(() => {});
          },
          onSearchClear: (nextFilters) => {
            setSubmissionFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_SUBMISSIONS], {
              nextSubmissionFilters: nextFilters,
            }).catch(() => {});
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
              reloadScoped([LOAD_SCOPE_SUBMISSIONS], {
                nextSubmissionFilters: submissionFilters,
              }).catch(() => {});
            }}
            onReset={() =>
              resetWithLoad(
                defaultSubmissionFilters,
                setSubmissionFilters,
                "nextSubmissionFilters",
                [LOAD_SCOPE_SUBMISSIONS],
              )
            }
            searchPlaceholder="Search requests"
            resultCount={submissions.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-submission-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={submissionsLoading}
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
                          <BookRouteLink
                            slug={submission.linked_book_slug}
                            className="ghost-button"
                          >
                            Open
                          </BookRouteLink>
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
                            "stopped",
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
        loading={jobsLoading}
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
          resultCountLoading: jobsLoading,
          drawerId: `${activeTab}-job-filters`,
          onSubmit: (event, nextFilters) => {
            event.preventDefault();
            setJobFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_JOBS], {
              nextJobFilters: nextFilters,
            }).catch(() => {});
          },
          onSearchClear: (nextFilters) => {
            setJobFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_JOBS], {
              nextJobFilters: nextFilters,
            }).catch(() => {});
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
              reloadScoped([LOAD_SCOPE_JOBS], {
                nextJobFilters: jobFilters,
              }).catch(() => {});
            }}
            onReset={() =>
              resetWithLoad(
                defaultJobFilters,
                setJobFilters,
                "nextJobFilters",
                [LOAD_SCOPE_JOBS],
              )
            }
            searchPlaceholder="Search book creation"
            resultCount={jobs.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-job-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={jobsLoading}
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
                          <BookRouteLink
                            slug={job.target_book_slug}
                            className="ghost-button"
                          >
                            Open
                          </BookRouteLink>
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
                        ) : job.status === "stopped" ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => retrySubmission(job.submission_id)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            {isBusy ? "Resuming..." : "Resume"}
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
        loading={reviewsLoading}
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
          resultCountLoading: reviewsLoading,
          drawerId: `${activeTab}-review-filters`,
          onSubmit: (event, nextFilters) => {
            event.preventDefault();
            setReviewFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_REVIEWS], {
              nextReviewFilters: nextFilters,
            }).catch(() => {});
          },
          onSearchClear: (nextFilters) => {
            setReviewFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_REVIEWS], {
              nextReviewFilters: nextFilters,
            }).catch(() => {});
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
              reloadScoped([LOAD_SCOPE_REVIEWS], {
                nextReviewFilters: reviewFilters,
              }).catch(() => {});
            }}
            onReset={() =>
              resetWithLoad(
                defaultReviewFilters,
                setReviewFilters,
                "nextReviewFilters",
                [LOAD_SCOPE_REVIEWS],
              )
            }
            searchPlaceholder="Search duplicate checks"
            resultCount={duplicateReviews.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-review-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={reviewsLoading}
          />
        }
        actions={
          <div className="processing-card-actions processing-card-actions-grouped">
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedDuplicateConfirmIds.length ||
                  bulkActionKey === "duplicate:confirm_existing" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  resolveDuplicateBulk(
                    selectedDuplicateConfirmIds,
                    "confirm_existing",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "duplicate:confirm_existing" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Use existing selected",
                    selectedDuplicateConfirmIds.length,
                  )}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedDuplicateDismissIds.length ||
                  bulkActionKey === "duplicate:dismiss" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  resolveDuplicateBulk(selectedDuplicateDismissIds, "dismiss")
                }
              >
                <span className="button-label">
                  {bulkActionKey === "duplicate:dismiss" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Keep new selected",
                    selectedDuplicateDismissIds.length,
                  )}
                </span>
              </button>
            </div>
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !duplicateReviews.some(
                    (review) => !review.existing_book_deleted,
                  ) ||
                  bulkActionKey === "duplicate:confirm_existing" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  resolveDuplicateBulk(
                    duplicateReviews
                      .filter((review) => !review.existing_book_deleted)
                      .map((review) => review.id),
                    "confirm_existing",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "duplicate:confirm_existing" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Use existing all
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !duplicateReviews.length ||
                  bulkActionKey === "duplicate:dismiss" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  resolveDuplicateBulk(
                    duplicateReviews.map((review) => review.id),
                    "dismiss",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "duplicate:dismiss" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Keep new all
                </span>
              </button>
            </div>
          </div>
        }
      >
        {duplicateReviews.length ? (
          <table className="simple-table processing-table">
            <thead>
              <tr>
                <th className="processing-col-select">
                  <input
                    type="checkbox"
                    className="processing-checkbox"
                    checked={allDuplicatesSelected}
                    onChange={() =>
                      setSelectedDuplicateReviewIds((current) =>
                        toggleVisibleSelection(
                          current,
                          duplicateIdsOnPage,
                          allDuplicatesSelected,
                        ),
                      )
                    }
                    aria-label={
                      allDuplicatesSelected
                        ? "Clear visible duplicate selections"
                        : "Select all visible duplicate checks"
                    }
                  />
                </th>
                <th className="processing-col-request">Request</th>
                <th className="processing-col-book">Existing</th>
                <th className="processing-col-status">Status</th>
                <th className="processing-col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {duplicateReviews.map((review) => (
                <tr key={review.id}>
                  <td className="processing-col-select">
                    <input
                      type="checkbox"
                      className="processing-checkbox"
                      checked={selectedDuplicateReviewIdSet.has(review.id)}
                      onChange={() =>
                        setSelectedDuplicateReviewIds((current) =>
                          toggleSelectedId(current, review.id),
                        )
                      }
                      aria-label={`Select duplicate check ${review.id}`}
                    />
                  </td>
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

  function renderRequeueReviewCard() {
    return (
      <ProcessingJobReviewCard
        visible
        title="Requeued Jobs Create Queue"
        emptyTitle="No requeued jobs match these filters"
        cardClassName="processing-requeue-card"
        loading={jobReviewsLoading}
        loadingLabel="Loading requeued jobs"
        headerAside={renderCardHeaderSearch({
          filters: requeueFilters,
          setFilters: setRequeueFilters,
          fields: jobFilterFields,
          defaultFilters: defaultJobFilters,
          filtersExpanded: requeueFiltersExpanded,
          setFiltersExpanded: setRequeueFiltersExpanded,
          searchPlaceholder: "Search requeued jobs",
          resultCount: filteredRequeuedJobs.length,
          resultCountLoading: jobReviewsLoading,
          drawerId: `${activeTab}-requeue-filters`,
          onSubmit: (event, nextFilters) => {
            event.preventDefault();
            setRequeueFilters(nextFilters);
          },
          onSearchClear: (nextFilters) => setRequeueFilters(nextFilters),
          buttonsDisabled: sourceTabButtonsDisabled,
        })}
        toolbar={
          <CatalogToolbar
            filters={requeueFilters}
            setFilters={setRequeueFilters}
            fields={jobFilterFields}
            defaultFilters={defaultJobFilters}
            filtersExpanded={requeueFiltersExpanded}
            setFiltersExpanded={setRequeueFiltersExpanded}
            onSubmit={(event) => {
              event.preventDefault();
            }}
            onReset={() => {
              setRequeueFilters(defaultJobFilters);
              setRequeueFiltersExpanded(false);
            }}
            searchPlaceholder="Search requeued jobs"
            resultCount={filteredRequeuedJobs.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-requeue-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={jobReviewsLoading}
          />
        }
        jobs={filteredRequeuedJobs}
        selectedJobIdSet={selectedRequeueJobIdSet}
        allSelected={allRequeueSelected}
        jobIdsOnPage={requeueJobIdsOnPage}
        onToggleAll={() =>
          setSelectedRequeueJobIds((current) =>
            toggleVisibleSelection(
              current,
              requeueJobIdsOnPage,
              allRequeueSelected,
            ),
          )
        }
        onToggleJob={(jobId) =>
          setSelectedRequeueJobIds((current) => toggleSelectedId(current, jobId))
        }
        selectedSubmissionIds={selectedRequeueSubmissionIds}
        submissionIds={requeueSubmissionIds}
        actionKey="requeue:create"
        bulkActionKey={bulkActionKey}
        creationActionsDisabled={creationActionsDisabled}
        onCreate={retrySubmissionsBulk}
        selectedActionLabel={selectedActionLabel}
        activeJobId={activeRequeueJobId}
        onActiveJobChange={setActiveRequeueJobId}
        showStatusColumn
        detailTitle="Requeue Error Details"
        detailRegionAriaLabel="Requeue error details"
        emptySelectionMessage="No requeued job selected."
        renderDetailBody={(job) => <pre>{getRequeueReasonText(job)}</pre>}
        getRequestPrimaryText={getRequestPrimaryText}
        jobTypeLabel={jobTypeLabel}
        getJobActivityAt={getJobActivityAt}
        selectAllAriaLabel="Select all visible requeued jobs"
        clearAllAriaLabel="Clear visible requeued selections"
        rowAriaLabel={(job) => `Select requeued job ${job.id}`}
      />
    );
  }

  function renderFailedJobsCard() {
    return (
      <ProcessingJobReviewCard
        visible
        title="Failed Jobs Create Queue"
        emptyTitle="No failed jobs match these filters"
        cardClassName="processing-failed-card"
        loading={jobReviewsLoading}
        loadingLabel="Loading failed jobs"
        headerAside={renderCardHeaderSearch({
          filters: failedFilters,
          setFilters: setFailedFilters,
          fields: jobFilterFields,
          defaultFilters: defaultJobFilters,
          filtersExpanded: failedFiltersExpanded,
          setFiltersExpanded: setFailedFiltersExpanded,
          searchPlaceholder: "Search failed jobs",
          resultCount: filteredFailedJobs.length,
          resultCountLoading: jobReviewsLoading,
          drawerId: `${activeTab}-failed-filters`,
          onSubmit: (event, nextFilters) => {
            event.preventDefault();
            setFailedFilters(nextFilters);
          },
          onSearchClear: (nextFilters) => setFailedFilters(nextFilters),
          buttonsDisabled: sourceTabButtonsDisabled,
        })}
        toolbar={
          <CatalogToolbar
            filters={failedFilters}
            setFilters={setFailedFilters}
            fields={jobFilterFields}
            defaultFilters={defaultJobFilters}
            filtersExpanded={failedFiltersExpanded}
            setFiltersExpanded={setFailedFiltersExpanded}
            onSubmit={(event) => {
              event.preventDefault();
            }}
            onReset={() => {
              setFailedFilters(defaultJobFilters);
              setFailedFiltersExpanded(false);
            }}
            searchPlaceholder="Search failed jobs"
            resultCount={filteredFailedJobs.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-failed-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={jobReviewsLoading}
          />
        }
        jobs={filteredFailedJobs}
        selectedJobIdSet={selectedFailedJobIdSet}
        allSelected={allFailedSelected}
        jobIdsOnPage={failedJobIdsOnPage}
        onToggleAll={() =>
          setSelectedFailedJobIds((current) =>
            toggleVisibleSelection(current, failedJobIdsOnPage, allFailedSelected),
          )
        }
        onToggleJob={(jobId) =>
          setSelectedFailedJobIds((current) => toggleSelectedId(current, jobId))
        }
        selectedSubmissionIds={selectedFailedSubmissionIds}
        submissionIds={failedSubmissionIds}
        actionKey="failed:create"
        bulkActionKey={bulkActionKey}
        creationActionsDisabled={creationActionsDisabled}
        onCreate={retrySubmissionsBulk}
        selectedActionLabel={selectedActionLabel}
        activeJobId={activeFailedJobId}
        onActiveJobChange={setActiveFailedJobId}
        layoutClassName="processing-failed-layout"
        tableWrapClassName="processing-failed-table-wrap"
        detailTitle="Failure Cause & Log"
        detailRegionAriaLabel="Failed job error and logs"
        emptySelectionMessage="No failed job selected."
        renderDetailBody={(job) => (
          <>
            <pre>{job.last_error || "No error message found."}</pre>
            <hr />
            {loadingFailedLogs ? (
              <p className="table-note">Loading logs...</p>
            ) : activeFailedJobLogs.length ? (
              <pre>
                {activeFailedJobLogs
                  .map(
                    (entry) =>
                      `${entry.created_at} [${entry.level}] ${entry.message}`,
                  )
                  .join("\n")}
              </pre>
            ) : (
              <p className="table-note">No logs found for this job.</p>
            )}
          </>
        )}
        getRequestPrimaryText={getRequestPrimaryText}
        jobTypeLabel={jobTypeLabel}
        getJobActivityAt={getJobActivityAt}
        selectAllAriaLabel="Select all visible failed jobs"
        clearAllAriaLabel="Clear visible failed selections"
        rowAriaLabel={(job) => `Select failed job ${job.id}`}
      />
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
        loading={runsLoading}
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
          resultCountLoading: runsLoading,
          drawerId: `${activeTab}-run-filters`,
          onSubmit: (event, nextFilters) => {
            event.preventDefault();
            setRunFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_RUNS], {
              nextRunFilters: nextFilters,
            }).catch(() => {});
          },
          onSearchClear: (nextFilters) => {
            setRunFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_RUNS], {
              nextRunFilters: nextFilters,
            }).catch(() => {});
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
              reloadScoped([LOAD_SCOPE_RUNS], {
                nextRunFilters: runFilters,
              }).catch(() => {});
            }}
            onReset={() =>
              resetWithLoad(
                defaultRunFilters,
                setRunFilters,
                "nextRunFilters",
                [LOAD_SCOPE_RUNS],
              )
            }
            searchPlaceholder="Search runs"
            resultCount={curationRuns.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-run-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={runsLoading}
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

  function renderAllTab() {
    return (
      <div className="processing-section-grid">
        {renderAllActivityOverviewCard()}
        {renderSubmissionsCard("All Requests")}
        {renderJobsCard("Book Creation")}
        {renderRequeueReviewCard()}
        {renderFailedJobsCard()}
        {renderRunsCard("Run History")}
        {renderDuplicateCard("Duplicate Checks")}
      </div>
    );
  }

  return (
    <div
      className={`page-stack processing-page${globalActionsLocked ? " is-actions-locked" : ""}`}
    >
      <section className="detail-card">
        <div className="panel-header">
          <div className="section-title-block">
            <h1>All Activity</h1>
          </div>
          {loading ? <LoadingSpinner size={18} /> : null}
        </div>
        {error ? (
          <div className="page-state page-state-error">{error}</div>
        ) : null}
      </section>

      {renderAllTab()}

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
