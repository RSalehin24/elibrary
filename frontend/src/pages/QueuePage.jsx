import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";
import EmptyState from "../components/EmptyState";
import StatusPill from "../components/StatusPill";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import { hasCapability } from "../utils/capabilities";
import { toQueryString } from "../utils/query";

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

function jobTypeLabel(jobType) {
  if (jobType === "ingestion") {
    return "Create Book";
  }
  if (jobType === "resolution") {
    return "Match Source";
  }
  if (jobType === "reprocess") {
    return "Reprocess";
  }
  return jobType;
}

function jobDetails(job) {
  if (job.status === "processing") {
    return "Processing this request now.";
  }
  if (job.status === "queued") {
    return "Waiting for a worker to start.";
  }
  if (job.status === "failed") {
    return job.last_error || "Processing failed.";
  }
  if (job.job_type === "ingestion") {
    return "Creates the book files and saves the result.";
  }
  if (job.job_type === "resolution") {
    return "Finds the correct source page for the request.";
  }
  if (job.job_type === "reprocess") {
    return "Runs the creation flow again for the same source.";
  }
  return "-";
}

function requestDetails(submission) {
  if (submission.uses_existing_request && ["queued", "processing"].includes(submission.status)) {
    return "Using an earlier identical request instead of starting a second one.";
  }
  if (submission.status === "processing") {
    return "Book creation is in progress.";
  }
  if (submission.status === "queued") {
    return "Waiting to start processing.";
  }
  if (submission.status === "ready") {
    return "Book is ready.";
  }
  if (submission.status === "duplicate") {
    return "Possible duplicate found.";
  }
  if (submission.resolution_status === "ambiguous") {
    return "More than one source matched this request.";
  }
  if (submission.resolution_status === "unresolved") {
    return "No reliable source match was found yet.";
  }
  if (submission.resolution_status === "invalid") {
    return "The request source is invalid.";
  }
  if (submission.status === "failed") {
    return submission.error_message || "Processing failed.";
  }
  if (submission.status === "needs_review") {
    return "Manual review is needed.";
  }
  return "Pending.";
}

function RequestActionCell({ submission, onRetry, onReview }) {
  if (submission.linked_book_slug) {
    return (
      <div className="table-actions">
        <Link to={`/books/${submission.linked_book_slug}`} className="ghost-button">
          Open
        </Link>
        <span className="table-note">Ready to open.</span>
      </div>
    );
  }

  if (submission.status === "processing") {
    return <span className="table-note">Processing this request now.</span>;
  }

  if (submission.uses_existing_request && ["queued", "processing"].includes(submission.status)) {
    return <span className="table-note">Already running from an earlier identical request.</span>;
  }

  if (submission.status === "queued") {
    return <span className="table-note">Queued and waiting to start.</span>;
  }

  if (submission.resolution_status === "ambiguous" && submission.candidates?.length) {
    return (
      <div className="table-actions">
        <button type="button" className="ghost-button" onClick={() => onReview(submission)}>
          Review Match
        </button>
        <span className="table-note">Choose the correct source.</span>
      </div>
    );
  }

  if (submission.status === "failed") {
    return (
      <div className="table-actions">
        <button type="button" className="ghost-button" onClick={() => onRetry(submission.id)}>
          Retry
        </button>
        <span className="table-note">Retry the request.</span>
      </div>
    );
  }

  if (submission.input_type === "title" && !submission.linked_book_slug && !submission.resolved_url) {
    return (
      <div className="table-actions">
        <button type="button" className="ghost-button" onClick={() => onRetry(submission.id)}>
          Retry
        </button>
        <span className="table-note">Try matching the source again.</span>
      </div>
    );
  }

  if (submission.resolved_url && !submission.served_from_database) {
    return (
      <div className="table-actions">
        <button type="button" className="ghost-button" onClick={() => onRetry(submission.id)}>
          Retry
        </button>
        <span className="table-note">Retry book creation.</span>
      </div>
    );
  }

  if (submission.status === "duplicate") {
    return <span className="table-note">Waiting for duplicate review.</span>;
  }

  if (submission.status === "needs_review") {
    return <span className="table-note">Needs manual review.</span>;
  }

  return <span className="table-note">No action needed right now.</span>;
}

export default function QueuePage() {
  const { user } = useSession();
  const toast = useToast();
  const canManageProcessing = hasCapability(user, "processing:manage");
  const [jobs, setJobs] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [duplicateReviews, setDuplicateReviews] = useState([]);
  const [submissionFilters, setSubmissionFilters] = useState(defaultSubmissionFilters);
  const [submissionFiltersExpanded, setSubmissionFiltersExpanded] = useState(false);
  const [jobFilters, setJobFilters] = useState(defaultJobFilters);
  const [jobFiltersExpanded, setJobFiltersExpanded] = useState(false);
  const [error, setError] = useState("");
  const [reviewSubmission, setReviewSubmission] = useState(null);

  async function load(nextJobFilters = jobFilters, nextSubmissionFilters = submissionFilters) {
    try {
      const requests = [
        apiFetch(`/ingestion/jobs/${toQueryString(nextJobFilters)}`),
        apiFetch(`/ingestion/submissions/${toQueryString(nextSubmissionFilters)}`)
      ];
      if (canManageProcessing) {
        requests.push(apiFetch("/ingestion/duplicate-reviews/"));
      }
      const [jobPayload, submissionPayload, duplicatePayload = []] = await Promise.all(requests);
      setJobs(jobPayload);
      setSubmissions(submissionPayload);
      setDuplicateReviews(duplicatePayload);
      setError("");
    } catch (nextError) {
      setError(nextError.message);
      toast.error(nextError.message);
    }
  }

  useEffect(() => {
    load();
  }, [user?.id, canManageProcessing]);

  async function retrySubmission(submissionId) {
    try {
      await apiFetch(`/ingestion/submissions/${submissionId}/retry/`, {
        method: "POST",
        body: {}
      });
      toast.success("Request queued.");
      await load();
    } catch (nextError) {
      toast.error(nextError.message);
    }
  }

  async function confirmCandidate(submissionId, candidateId) {
    try {
      await apiFetch(`/ingestion/submissions/${submissionId}/confirm-candidate/`, {
        method: "POST",
        body: { candidate_id: candidateId }
      });
      setReviewSubmission(null);
      toast.success("Source selected.");
      await load();
    } catch (nextError) {
      toast.error(nextError.message);
    }
  }

  async function resolveDuplicate(reviewId, decision) {
    try {
      await apiFetch(`/ingestion/duplicate-reviews/${reviewId}/resolve/`, {
        method: "POST",
        body: { decision }
      });
      await load();
    } catch (nextError) {
      toast.error(nextError.message);
    }
  }

  async function refreshCatalog() {
    try {
      await apiFetch("/ingestion/catalog/refresh/", {
        method: "POST",
        body: { max_pages: 3 }
      });
      toast.success("Source catalog refresh started.");
      await load();
    } catch (nextError) {
      toast.error(nextError.message);
    }
  }

  return (
    <div className="page-stack">
      <section className="detail-card">
        <div className="panel-header">
          <h1>Processing</h1>
          {canManageProcessing ? (
            <button type="button" className="ghost-button" onClick={refreshCatalog}>
              Refresh Catalog
            </button>
          ) : null}
        </div>
        {error ? <div className="page-state page-state-error">{error}</div> : null}
      </section>

      <section className="detail-card">
        <div className="panel-header">
          <h2>Processing Jobs</h2>
          <button type="button" className="ghost-button" onClick={() => setJobFiltersExpanded((current) => !current)}>
            {jobFiltersExpanded ? "Hide Filters" : "Filters"}
          </button>
        </div>
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            load();
          }}
        >
          <div className="search-inline">
            <input
              value={jobFilters.q}
              onChange={(event) => setJobFilters({ ...jobFilters, q: event.target.value })}
              placeholder="Search processing jobs"
            />
            <button type="submit" className="primary-button">
              Search
            </button>
          </div>
          {jobFiltersExpanded ? (
            <div className="detail-facts">
              <label>
                <span className="fact-label">Job Status</span>
                <select value={jobFilters.status} onChange={(event) => setJobFilters({ ...jobFilters, status: event.target.value })}>
                  <option value="">Any</option>
                  <option value="queued">Queued</option>
                  <option value="processing">Processing</option>
                  <option value="succeeded">Succeeded</option>
                  <option value="failed">Failed</option>
                </select>
              </label>
              <label>
                <span className="fact-label">Request Status</span>
                <select
                  value={jobFilters.submission_status}
                  onChange={(event) => setJobFilters({ ...jobFilters, submission_status: event.target.value })}
                >
                  <option value="">Any</option>
                  <option value="queued">Queued</option>
                  <option value="processing">Processing</option>
                  <option value="needs_review">Needs review</option>
                  <option value="ready">Ready</option>
                  <option value="failed">Failed</option>
                  <option value="duplicate">Duplicate</option>
                </select>
              </label>
            </div>
          ) : null}
        </form>

        {jobs.length ? (
          <div className="table-shell">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Status</th>
                  <th>Type</th>
                  <th>Details</th>
                  <th>Queue</th>
                  <th>Retries</th>
                  <th>Last Error</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{job.submission_input}</td>
                    <td>
                      <StatusPill value={job.status} />
                    </td>
                    <td>{jobTypeLabel(job.job_type)}</td>
                    <td>{jobDetails(job)}</td>
                    <td>{job.queue_name || "-"}</td>
                    <td>{job.retry_count}</td>
                    <td>{job.last_error || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No jobs" body="Processing jobs will appear here." />
        )}
      </section>

      <section className="detail-card">
        <div className="panel-header">
          <h2>Requests</h2>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setSubmissionFiltersExpanded((current) => !current)}
          >
            {submissionFiltersExpanded ? "Hide Filters" : "Filters"}
          </button>
        </div>
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            load();
          }}
        >
          <div className="search-inline">
            <input
              value={submissionFilters.q}
              onChange={(event) => setSubmissionFilters({ ...submissionFilters, q: event.target.value })}
              placeholder="Search requests"
            />
            <button type="submit" className="primary-button">
              Search
            </button>
          </div>
          {submissionFiltersExpanded ? (
            <div className="detail-facts">
              <label>
                <span className="fact-label">Status</span>
                <select
                  value={submissionFilters.status}
                  onChange={(event) => setSubmissionFilters({ ...submissionFilters, status: event.target.value })}
                >
                  <option value="">Any</option>
                  <option value="pending_resolution">Pending resolution</option>
                  <option value="queued">Queued</option>
                  <option value="processing">Processing</option>
                  <option value="needs_review">Needs review</option>
                  <option value="ready">Ready</option>
                  <option value="failed">Failed</option>
                  <option value="duplicate">Duplicate</option>
                </select>
              </label>
              <label>
                <span className="fact-label">Resolution</span>
                <select
                  value={submissionFilters.resolution_status}
                  onChange={(event) =>
                    setSubmissionFilters({ ...submissionFilters, resolution_status: event.target.value })
                  }
                >
                  <option value="">Any</option>
                  <option value="exact_match">Exact match</option>
                  <option value="resolved">Resolved</option>
                  <option value="ambiguous">Ambiguous</option>
                  <option value="unresolved">Unresolved</option>
                  <option value="invalid">Invalid</option>
                </select>
              </label>
              <label>
                <span className="fact-label">Review</span>
                <select
                  value={submissionFilters.review_state}
                  onChange={(event) => setSubmissionFilters({ ...submissionFilters, review_state: event.target.value })}
                >
                  <option value="">Any</option>
                  <option value="pending">Pending</option>
                  <option value="needs_review">Needs review</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </label>
              <label>
                <span className="fact-label">Input</span>
                <select
                  value={submissionFilters.input_type}
                  onChange={(event) => setSubmissionFilters({ ...submissionFilters, input_type: event.target.value })}
                >
                  <option value="">Any</option>
                  <option value="url">URL</option>
                  <option value="title">Title</option>
                  <option value="csv">CSV</option>
                </select>
              </label>
            </div>
          ) : null}
        </form>

        {submissions.length ? (
          <div className="table-shell">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Status</th>
                  <th>Details</th>
                  <th>Book</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((submission) => (
                  <tr key={submission.id}>
                    <td>{submission.original_input}</td>
                    <td>
                      <StatusPill value={submission.status} />
                    </td>
                    <td>{requestDetails(submission)}</td>
                    <td>{submission.linked_book_slug || "-"}</td>
                    <td>
                      <RequestActionCell
                        submission={submission}
                        onRetry={retrySubmission}
                        onReview={setReviewSubmission}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No requests" body="Submitted requests will appear here." />
        )}
      </section>

      {canManageProcessing && duplicateReviews.length ? (
        <section className="detail-card">
          <h2>Duplicate Reviews</h2>
          <div className="table-shell">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Existing Book</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {duplicateReviews.map((review) => (
                  <tr key={review.id}>
                    <td>{review.submission?.original_input}</td>
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
                        >
                          Use Existing
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => resolveDuplicate(review.id, "dismiss")}
                        >
                          Keep New
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

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
                  <small>{candidate.candidate_author || `${Math.round(candidate.confidence * 100)}% match`}</small>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
