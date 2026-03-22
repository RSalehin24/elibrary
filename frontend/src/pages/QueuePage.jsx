import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";
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

const defaultSubmissionFilters = {
  q: "",
  status: "",
  review_state: "",
  resolution_status: "",
  input_type: ""
};

const defaultJobFilters = {
  q: "",
  status: "",
  submission_status: ""
};

const defaultCatalogFilters = {
  q: "",
  status: ""
};

const defaultCatalogSummary = {
  total: 0,
  new: 0,
  processing: 0,
  unfinished: 0,
  failed: 0,
  ready: 0,
  deleted: 0
};

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

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
    const label = path.replace(/^books\//, "").replace(/-/g, " ").trim();
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

function curationModeLabel(mode) {
  return mode === "all" ? "All tracked" : "New + unfinished";
}

function runSummaryLabel(run) {
  const summary = run.summary || {};
  const parts = [
    `${summary.queued_creates || 0} create`,
    `${summary.queued_updates || 0} update`,
    `${summary.skipped_ready || 0} skip`
  ];
  return parts.join(" · ");
}

function RequestValue({ value }) {
  const primary = getRequestPrimaryText(value);
  const secondary = getRequestSecondaryText(value);

  return (
    <div className="table-cell-stack table-request-cell">
      <strong>{primary}</strong>
      {secondary ? <span className="table-note">{secondary}</span> : null}
    </div>
  );
}

function BookLinkCell({ submission }) {
  if (!submission.linked_book_slug) {
    return <span className="table-note">-</span>;
  }

  return (
    <Link to={`/books/${submission.linked_book_slug}`} className="meta-link">
      {submission.linked_book?.title || submission.linked_book_slug}
    </Link>
  );
}

function RequestActionCell({ submission, onRetry, onReview, onResumeJob, onStopJob, busyActionId }) {
  const latestJob = submission.latest_job || null;
  const isBusy = busyActionId === latestJob?.id || busyActionId === submission.id;

  if (submission.linked_book_slug) {
    return (
      <Link to={`/books/${submission.linked_book_slug}`} className="ghost-button">
        Open
      </Link>
    );
  }

  if (submission.resolution_status === "ambiguous" && submission.candidates?.length) {
    return (
      <button type="button" className="ghost-button" onClick={() => onReview(submission)} disabled={isBusy}>
        Review
      </button>
    );
  }

  if (latestJob?.status === "queued" && !latestJob.task_id && !submission.uses_existing_request) {
    return (
      <div className="table-actions">
        <button type="button" className="ghost-button" onClick={() => onResumeJob(latestJob.id)} disabled={isBusy}>
          {isBusy ? "Starting..." : "Start"}
        </button>
        <button type="button" className="ghost-button" onClick={() => onStopJob(latestJob.id)} disabled={isBusy}>
          Stop
        </button>
      </div>
    );
  }

  if (latestJob && isActiveStatus(latestJob.status) && !submission.uses_existing_request) {
    return (
      <button type="button" className="ghost-button" onClick={() => onStopJob(latestJob.id)} disabled={isBusy}>
        {isBusy ? "Stopping..." : "Stop"}
      </button>
    );
  }

  if (["failed", "cancelled", "needs_review"].includes(submission.status) || latestJob?.status === "failed") {
    return (
      <button type="button" className="ghost-button" onClick={() => onRetry(submission.id)} disabled={isBusy}>
        {isBusy ? "Retrying..." : "Retry"}
      </button>
    );
  }

  return <span className="table-note">-</span>;
}

function JobActionCell({ job, onResume, onStop, busyActionId }) {
  const isBusy = busyActionId === job.id;

  if (job.status === "queued" && !job.task_id) {
    return (
      <div className="table-actions">
        <button type="button" className="ghost-button" onClick={() => onResume(job.id)} disabled={isBusy}>
          {isBusy ? "Starting..." : "Start"}
        </button>
        <button type="button" className="ghost-button" onClick={() => onStop(job.id)} disabled={isBusy}>
          Stop
        </button>
      </div>
    );
  }

  if (isActiveStatus(job.status)) {
    return (
      <button type="button" className="ghost-button" onClick={() => onStop(job.id)} disabled={isBusy}>
        {isBusy ? "Stopping..." : "Stop"}
      </button>
    );
  }

  return <span className="table-note">-</span>;
}

function QueueTableCard({ title, controls, children, emptyTitle }) {
  return (
    <section className="detail-card processing-card">
      <div className="panel-header">
        <div className="section-title-block">
          <h2>{title}</h2>
        </div>
        {controls}
      </div>
      <div className="processing-table-shell">{children || <EmptyState title={emptyTitle} />}</div>
    </section>
  );
}

export default function QueuePage() {
  const { user } = useSession();
  const toast = useToast();
  const canManageProcessing = hasCapability(user, "processing:manage");

  const [activeTab, setActiveTab] = useState(USER_TAB);
  const [jobs, setJobs] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [duplicateReviews, setDuplicateReviews] = useState([]);
  const [submissionFilters, setSubmissionFilters] = useState(defaultSubmissionFilters);
  const [jobFilters, setJobFilters] = useState(defaultJobFilters);
  const [catalogFilters, setCatalogFilters] = useState(defaultCatalogFilters);
  const [catalogEntries, setCatalogEntries] = useState([]);
  const [catalogSummary, setCatalogSummary] = useState(defaultCatalogSummary);
  const [curationRuns, setCurationRuns] = useState([]);
  const [automationState, setAutomationState] = useState(null);
  const [automationForm, setAutomationForm] = useState({
    enabled: false,
    daily_run_time: "02:00",
    mode: "pending",
    refresh_max_pages: "80"
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reviewSubmission, setReviewSubmission] = useState(null);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [startingCurationMode, setStartingCurationMode] = useState("");
  const [savingAutomation, setSavingAutomation] = useState(false);
  const [busyJobId, setBusyJobId] = useState("");
  const [busyRunId, setBusyRunId] = useState("");
  const [recoveringJobs, setRecoveringJobs] = useState(false);

  async function load(
    nextTab = activeTab,
    nextJobFilters = jobFilters,
    nextSubmissionFilters = submissionFilters,
    nextCatalogFilters = catalogFilters,
    options = {}
  ) {
    const { preserveAutomationForm = false } = options;
    setLoading(true);
    try {
      const origin = getOriginForTab(nextTab);
      const nextJobsParams = { ...nextJobFilters, limit: 60 };
      const nextSubmissionParams = { ...nextSubmissionFilters, limit: 60 };
      if (origin) {
        nextJobsParams.origin = origin;
        nextSubmissionParams.origin = origin;
      }

      const requests = [
        apiFetch(`/ingestion/jobs/${toQueryString(nextJobsParams)}`),
        apiFetch(`/ingestion/submissions/${toQueryString(nextSubmissionParams)}`)
      ];

      if (canManageProcessing) {
        const duplicateReviewParams = { limit: 30 };
        if (origin) {
          duplicateReviewParams.origin = origin;
        }
        requests.push(apiFetch(`/ingestion/duplicate-reviews/${toQueryString(duplicateReviewParams)}`));

        if (nextTab === SOURCE_TAB) {
          requests.push(
            apiFetch(`/ingestion/catalog/entries/${toQueryString({ ...nextCatalogFilters, limit: 180 })}`),
            apiFetch("/ingestion/catalog/curation-runs/?trigger=manual&limit=20")
          );
        } else if (nextTab === AUTOMATION_TAB) {
          requests.push(
            apiFetch("/ingestion/catalog/curation-runs/?trigger=scheduled&limit=20"),
            apiFetch("/ingestion/catalog/automation/")
          );
        } else if (nextTab === ALL_TAB) {
          requests.push(apiFetch("/ingestion/catalog/curation-runs/?limit=20"));
        }
      }

      const payloads = await Promise.all(requests);
      setJobs(payloads[0] || []);
      setSubmissions(payloads[1] || []);

      let offset = 2;
      if (canManageProcessing) {
        setDuplicateReviews(payloads[offset] || []);
        offset += 1;

        if (nextTab === SOURCE_TAB) {
          const catalogPayload = payloads[offset] || null;
          const runPayload = payloads[offset + 1] || [];
          setCatalogEntries(catalogPayload?.entries || []);
          setCatalogSummary(catalogPayload?.summary || defaultCatalogSummary);
          setCurationRuns(runPayload);
          setAutomationState(null);
        } else if (nextTab === AUTOMATION_TAB) {
          const runPayload = payloads[offset] || [];
          const automationPayload = payloads[offset + 1] || null;
          setCurationRuns(runPayload);
          setAutomationState(automationPayload);
          setCatalogEntries([]);
          setCatalogSummary(defaultCatalogSummary);
          if (!preserveAutomationForm && automationPayload?.settings) {
            setAutomationForm({
              enabled: Boolean(automationPayload.settings.enabled),
              daily_run_time: normalizeTimeInput(automationPayload.settings.daily_run_time),
              mode: automationPayload.settings.mode || "pending",
              refresh_max_pages: String(automationPayload.settings.refresh_max_pages || 80)
            });
          }
        } else if (nextTab === ALL_TAB) {
          setCurationRuns(payloads[offset] || []);
          setCatalogEntries([]);
          setCatalogSummary(defaultCatalogSummary);
          setAutomationState(null);
        } else {
          setCatalogEntries([]);
          setCatalogSummary(defaultCatalogSummary);
          setCurationRuns([]);
          setAutomationState(null);
        }
      } else {
        setDuplicateReviews([]);
        setCatalogEntries([]);
        setCatalogSummary(defaultCatalogSummary);
        setCurationRuns([]);
        setAutomationState(null);
      }

      setError("");
    } catch (nextError) {
      setError(nextError.message);
      toast.error(nextError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canManageProcessing && activeTab !== USER_TAB) {
      setActiveTab(USER_TAB);
    }
  }, [activeTab, canManageProcessing]);

  useEffect(() => {
    load(activeTab).catch(() => {});
  }, [user?.id, canManageProcessing, activeTab]);

  useEffect(() => {
    const hasActiveJobs = jobs.some((job) => isActiveStatus(job.status));
    const hasActiveRuns = curationRuns.some((run) => isActiveStatus(run.status));
    if (!hasActiveJobs && !hasActiveRuns) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true }).catch(() => {});
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeTab, jobs, curationRuns, jobFilters, submissionFilters, catalogFilters]);

  async function retrySubmission(submissionId) {
    setBusyJobId(submissionId);
    try {
      await apiFetch(`/ingestion/submissions/${submissionId}/retry/`, {
        method: "POST",
        body: {}
      });
      toast.success("Queued.");
      await load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true });
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyJobId("");
    }
  }

  async function confirmCandidate(submissionId, candidateId) {
    setBusyJobId(submissionId);
    try {
      await apiFetch(`/ingestion/submissions/${submissionId}/confirm-candidate/`, {
        method: "POST",
        body: { candidate_id: candidateId }
      });
      setReviewSubmission(null);
      toast.success("Source selected.");
      await load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true });
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyJobId("");
    }
  }

  async function resolveDuplicate(reviewId, decision) {
    setBusyJobId(reviewId);
    try {
      await apiFetch(`/ingestion/duplicate-reviews/${reviewId}/resolve/`, {
        method: "POST",
        body: { decision }
      });
      await load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true });
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyJobId("");
    }
  }

  async function resumeJob(jobId) {
    setBusyJobId(jobId);
    try {
      await apiFetch(`/ingestion/jobs/${jobId}/resume/`, {
        method: "POST",
        body: {}
      });
      toast.success("Started.");
      await load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true });
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyJobId("");
    }
  }

  async function stopJob(jobId) {
    setBusyJobId(jobId);
    try {
      await apiFetch(`/ingestion/jobs/${jobId}/stop/`, {
        method: "POST",
        body: {}
      });
      toast.success("Stopped.");
      await load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true });
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyJobId("");
    }
  }

  async function recoverJobs() {
    if (recoveringJobs) {
      return;
    }

    setRecoveringJobs(true);
    try {
      await apiFetch("/ingestion/jobs/recover/", {
        method: "POST",
        body: {
          origin: getOriginForTab(activeTab),
          limit: 50
        }
      });
      toast.success("Queued jobs resumed.");
      await load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true });
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setRecoveringJobs(false);
    }
  }

  async function refreshCatalog() {
    if (refreshingCatalog) {
      return;
    }

    try {
      setRefreshingCatalog(true);
      await apiFetch("/ingestion/catalog/refresh/", {
        method: "POST",
        body: { max_pages: 80 }
      });
      toast.success("Catalog refreshed.");
      await load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true });
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setRefreshingCatalog(false);
    }
  }

  async function startCuration(mode) {
    if (startingCurationMode) {
      return;
    }

    try {
      setStartingCurationMode(mode);
      await apiFetch("/ingestion/catalog/curation-runs/", {
        method: "POST",
        body: {
          mode,
          refresh_catalog: true,
          refresh_max_pages: 80
        }
      });
      toast.success("Sync started.");
      await load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true });
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setStartingCurationMode("");
    }
  }

  async function stopRun(runId) {
    setBusyRunId(runId);
    try {
      await apiFetch(`/ingestion/catalog/curation-runs/${runId}/stop/`, {
        method: "POST",
        body: {}
      });
      toast.success("Sync stopped.");
      await load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true });
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyRunId("");
    }
  }

  async function saveAutomation(event) {
    event.preventDefault();
    try {
      setSavingAutomation(true);
      const payload = await apiFetch("/ingestion/catalog/automation/", {
        method: "PATCH",
        body: {
          enabled: automationForm.enabled,
          daily_run_time: automationForm.daily_run_time,
          mode: automationForm.mode,
          refresh_max_pages: Number(automationForm.refresh_max_pages) || 80
        }
      });
      setAutomationState(payload);
      if (payload.settings) {
        setAutomationForm({
          enabled: Boolean(payload.settings.enabled),
          daily_run_time: normalizeTimeInput(payload.settings.daily_run_time),
          mode: payload.settings.mode || "pending",
          refresh_max_pages: String(payload.settings.refresh_max_pages || 80)
        });
      }
      toast.success("Saved.");
      await load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true });
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setSavingAutomation(false);
    }
  }

  function renderJobsCard(title) {
    return (
      <QueueTableCard
        title={title}
        emptyTitle="No jobs"
        controls={
          <div className="processing-card-actions">
            {canManageProcessing ? (
              <button type="button" className="ghost-button" onClick={recoverJobs} disabled={recoveringJobs}>
                <span className="button-label">
                  {recoveringJobs ? <LoadingSpinner size={14} /> : null}
                  {recoveringJobs ? "Starting..." : "Resume queued"}
                </span>
              </button>
            ) : null}
            <form
              className="processing-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true }).catch(() => {});
              }}
            >
              <input
                value={jobFilters.q}
                onChange={(event) => setJobFilters({ ...jobFilters, q: event.target.value })}
                placeholder="Search"
              />
              <select value={jobFilters.status} onChange={(event) => setJobFilters({ ...jobFilters, status: event.target.value })}>
                <option value="">Any</option>
                <option value="queued">Queued</option>
                <option value="processing">Processing</option>
                <option value="succeeded">Completed</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <button type="submit" className="ghost-button">
                Apply
              </button>
            </form>
          </div>
        }
      >
        {jobs.length ? (
          <table className="simple-table processing-table">
            <thead>
              <tr>
                <th className="processing-col-request">Request</th>
                <th className="processing-col-status">Status</th>
                <th className="processing-col-type">Type</th>
                <th className="processing-col-queue">Queue</th>
                <th className="processing-col-time">Updated</th>
                <th className="processing-col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td className="processing-col-request">
                    <RequestValue value={job.submission_input} />
                  </td>
                  <td>
                    <StatusPill value={job.status} />
                  </td>
                  <td>{jobTypeLabel(job.job_type)}</td>
                  <td>{job.queue_name || "-"}</td>
                  <td>{formatBookDateTime(job.finished_at || job.started_at || job.created_at)}</td>
                  <td>
                    <JobActionCell job={job} onResume={resumeJob} onStop={stopJob} busyActionId={busyJobId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </QueueTableCard>
    );
  }

  function renderSubmissionsCard(title) {
    return (
      <QueueTableCard
        title={title}
        emptyTitle="No requests"
        controls={
          <form
            className="processing-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true }).catch(() => {});
            }}
          >
            <input
              value={submissionFilters.q}
              onChange={(event) => setSubmissionFilters({ ...submissionFilters, q: event.target.value })}
              placeholder="Search"
            />
            <select
              value={submissionFilters.status}
              onChange={(event) => setSubmissionFilters({ ...submissionFilters, status: event.target.value })}
            >
              <option value="">Any</option>
              <option value="pending_resolution">Resolving</option>
              <option value="queued">Queued</option>
              <option value="processing">Processing</option>
              <option value="needs_review">Needs review</option>
              <option value="ready">Ready</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
              <option value="duplicate">Duplicate</option>
            </select>
            <button type="submit" className="ghost-button">
              Apply
            </button>
          </form>
        }
      >
        {submissions.length ? (
          <table className="simple-table processing-table">
            <thead>
              <tr>
                <th className="processing-col-request">Request</th>
                <th className="processing-col-status">Status</th>
                <th className="processing-col-book">Book</th>
                <th className="processing-col-time">Updated</th>
                <th className="processing-col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((submission) => (
                <tr key={submission.id}>
                  <td className="processing-col-request">
                    <RequestValue value={submission.original_input} />
                  </td>
                  <td>
                    <StatusPill value={submission.status} />
                  </td>
                  <td>
                    <BookLinkCell submission={submission} />
                  </td>
                  <td>{formatBookDateTime(submission.created_at)}</td>
                  <td>
                    <RequestActionCell
                      submission={submission}
                      onRetry={retrySubmission}
                      onReview={setReviewSubmission}
                      onResumeJob={resumeJob}
                      onStopJob={stopJob}
                      busyActionId={busyJobId}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </QueueTableCard>
    );
  }

  function renderDuplicateCard() {
    if (!canManageProcessing || !duplicateReviews.length) {
      return null;
    }

    return (
      <QueueTableCard title="Duplicate Reviews" emptyTitle="No duplicate reviews">
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
                <td>{review.existing_book?.title || "-"}</td>
                <td>
                  <StatusPill value={review.status} />
                </td>
                <td>
                  <div className="table-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => resolveDuplicate(review.id, "confirm_existing")}
                      disabled={busyJobId === review.id}
                    >
                      Use existing
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => resolveDuplicate(review.id, "dismiss")}
                      disabled={busyJobId === review.id}
                    >
                      Keep new
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </QueueTableCard>
    );
  }

  function renderCatalogCard() {
    return (
      <QueueTableCard
        title="Tracked Source Books"
        emptyTitle="No source books"
        controls={
          <form
            className="processing-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              load(activeTab, jobFilters, submissionFilters, catalogFilters, { preserveAutomationForm: true }).catch(() => {});
            }}
          >
            <input
              value={catalogFilters.q}
              onChange={(event) => setCatalogFilters({ ...catalogFilters, q: event.target.value })}
              placeholder="Search"
            />
            <select
              value={catalogFilters.status}
              onChange={(event) => setCatalogFilters({ ...catalogFilters, status: event.target.value })}
            >
              <option value="">Any</option>
              <option value="new">New</option>
              <option value="processing">Processing</option>
              <option value="unfinished">Unfinished</option>
              <option value="failed">Failed</option>
              <option value="ready">Ready</option>
              <option value="deleted">Deleted</option>
            </select>
            <button type="submit" className="ghost-button">
              Apply
            </button>
          </form>
        }
      >
        {catalogEntries.length ? (
          <table className="simple-table processing-table">
            <thead>
              <tr>
                <th className="processing-col-request">Book</th>
                <th className="processing-col-status">Status</th>
                <th className="processing-col-book">Local</th>
                <th className="processing-col-time">Seen</th>
              </tr>
            </thead>
            <tbody>
              {catalogEntries.map((entry) => (
                <tr key={entry.id}>
                  <td className="processing-col-request">
                    <div className="table-cell-stack table-request-cell">
                      <strong>{entry.title}</strong>
                      <span className="table-note">{entry.author_line || getRequestSecondaryText(entry.source_url)}</span>
                    </div>
                  </td>
                  <td>
                    <StatusPill value={entry.curation_status} />
                  </td>
                  <td>
                    {entry.local_book_slug ? (
                      <Link to={`/books/${entry.local_book_slug}`} className="meta-link">
                        {entry.local_book_title}
                      </Link>
                    ) : (
                      <span className="table-note">-</span>
                    )}
                  </td>
                  <td>{formatBookDateTime(entry.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </QueueTableCard>
    );
  }

  function renderRunsCard(title) {
    return (
      <section className="detail-card processing-card">
        <div className="panel-header">
          <div className="section-title-block">
            <h2>{title}</h2>
          </div>
        </div>
        <div className="processing-scroll-shell">
          {curationRuns.length ? (
            <div className="queue-list processing-run-list">
              {curationRuns.map((run) => (
                <article key={run.id} className="queue-card processing-run-card">
                  <div className="queue-card-top">
                    <strong>{runTypeLabel(run)}</strong>
                    <StatusPill value={run.status} />
                  </div>
                  <div className="processing-run-meta">
                    <span>{curationModeLabel(run.mode)}</span>
                    <span>{formatBookDateTime(run.created_at)}</span>
                  </div>
                  <div className="processing-run-meta">
                    <span>{runSummaryLabel(run)}</span>
                    {run.last_error ? <span className="processing-error-text">{run.last_error}</span> : null}
                  </div>
                  {isActiveStatus(run.status) ? (
                    <div className="inline-pills">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => stopRun(run.id)}
                        disabled={busyRunId === run.id}
                      >
                        {busyRunId === run.id ? "Stopping..." : "Stop"}
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="No runs" />
          )}
        </div>
      </section>
    );
  }

  function renderUserTab() {
    return (
      <div className="processing-section-grid">
        {renderSubmissionsCard("Requests")}
        {renderJobsCard("Jobs")}
        {renderDuplicateCard()}
      </div>
    );
  }

  function renderSourceTab() {
    return (
      <div className="processing-section-grid">
        <section className="detail-card processing-card processing-summary-card">
          <div className="panel-header">
            <div className="section-title-block">
              <h2>Source Curation</h2>
            </div>
            <div className="processing-card-actions">
              <button type="button" className="ghost-button" onClick={refreshCatalog} disabled={refreshingCatalog}>
                <span className="button-label">
                  {refreshingCatalog ? <LoadingSpinner size={14} /> : null}
                  {refreshingCatalog ? "Refreshing..." : "Refresh catalog"}
                </span>
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => startCuration("pending")}
                disabled={Boolean(startingCurationMode)}
              >
                <span className="button-label">
                  {startingCurationMode === "pending" ? <LoadingSpinner size={14} /> : null}
                  {startingCurationMode === "pending" ? "Starting..." : "Sync new"}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => startCuration("all")}
                disabled={Boolean(startingCurationMode)}
              >
                <span className="button-label">
                  {startingCurationMode === "all" ? <LoadingSpinner size={14} /> : null}
                  {startingCurationMode === "all" ? "Starting..." : "Sync all"}
                </span>
              </button>
              <button type="button" className="ghost-button" onClick={recoverJobs} disabled={recoveringJobs}>
                <span className="button-label">
                  {recoveringJobs ? <LoadingSpinner size={14} /> : null}
                  {recoveringJobs ? "Starting..." : "Resume queued"}
                </span>
              </button>
            </div>
          </div>
          <div className="detail-facts processing-summary-grid">
            {[
              ["Total", catalogSummary.total],
              ["New", catalogSummary.new],
              ["Processing", catalogSummary.processing],
              ["Unfinished", catalogSummary.unfinished],
              ["Failed", catalogSummary.failed],
              ["Ready", catalogSummary.ready]
            ].map(([label, value]) => (
              <article key={label} className="book-detail-chip">
                <span className="fact-label">{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
        </section>
        {renderCatalogCard()}
        {renderRunsCard("Sync Runs")}
        {renderSubmissionsCard("Requests")}
        {renderJobsCard("Jobs")}
        {renderDuplicateCard()}
      </div>
    );
  }

  function renderAutomationTab() {
    return (
      <div className="processing-section-grid">
        <section className="detail-card processing-card">
          <div className="panel-header">
            <div className="section-title-block">
              <h2>Daily Automation</h2>
            </div>
            {automationState?.settings?.next_run_at ? (
              <span className="status-pill">{formatBookDateTime(automationState.settings.next_run_at)}</span>
            ) : null}
          </div>
          <form className="stack-form" onSubmit={saveAutomation}>
            <label className="processing-toggle-row">
              <span>Enabled</span>
              <input
                type="checkbox"
                checked={automationForm.enabled}
                onChange={(event) => setAutomationForm({ ...automationForm, enabled: event.target.checked })}
              />
            </label>
            <div className="detail-facts processing-automation-grid">
              <label>
                <span className="fact-label">Time</span>
                <input
                  type="time"
                  value={automationForm.daily_run_time}
                  onChange={(event) => setAutomationForm({ ...automationForm, daily_run_time: event.target.value })}
                />
              </label>
              <label>
                <span className="fact-label">Mode</span>
                <select
                  value={automationForm.mode}
                  onChange={(event) => setAutomationForm({ ...automationForm, mode: event.target.value })}
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
                  onChange={(event) => setAutomationForm({ ...automationForm, refresh_max_pages: event.target.value })}
                />
              </label>
            </div>
            <div className="processing-card-actions">
              <button type="submit" className="primary-button" disabled={savingAutomation}>
                <span className="button-label">
                  {savingAutomation ? <LoadingSpinner size={14} /> : null}
                  {savingAutomation ? "Saving..." : "Save"}
                </span>
              </button>
              <button type="button" className="ghost-button" onClick={recoverJobs} disabled={recoveringJobs}>
                <span className="button-label">
                  {recoveringJobs ? <LoadingSpinner size={14} /> : null}
                  {recoveringJobs ? "Starting..." : "Resume queued"}
                </span>
              </button>
            </div>
          </form>
        </section>
        {renderRunsCard("Automation Runs")}
        {renderSubmissionsCard("Requests")}
        {renderJobsCard("Jobs")}
        {renderDuplicateCard()}
      </div>
    );
  }

  function renderAllTab() {
    return (
      <div className="processing-section-grid">
        {renderSubmissionsCard("All Requests")}
        {renderJobsCard("All Jobs")}
        {renderRunsCard("All Runs")}
        {renderDuplicateCard()}
      </div>
    );
  }

  const tabs = canManageProcessing
    ? [
        { id: USER_TAB, label: "User Queue" },
        { id: SOURCE_TAB, label: "Source Curation" },
        { id: AUTOMATION_TAB, label: "Daily Automation" },
        { id: ALL_TAB, label: "All Activity" }
      ]
    : [{ id: USER_TAB, label: "User Queue" }];

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
          <div className="admin-tab-grid processing-tab-grid" role="tablist" aria-label="Processing sections">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? "admin-tab-card is-active" : "admin-tab-card"}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="admin-tab-label">{tab.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        {error ? <div className="page-state page-state-error">{error}</div> : null}
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
              <button type="button" className="ghost-button" onClick={() => setReviewSubmission(null)}>
                Close
              </button>
            </div>
            <div className="dialog-stack">
              {reviewSubmission.candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className="candidate-button"
                  onClick={() => confirmCandidate(reviewSubmission.id, candidate.id)}
                >
                  <span>{candidate.candidate_title}</span>
                  <small>{candidate.candidate_author || `${Math.round(candidate.confidence * 100)}%`}</small>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
