import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";
import StatusPill from "../components/StatusPill";
import EmptyState from "../components/EmptyState";
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

export default function QueuePage() {
  const { user } = useSession();
  const toast = useToast();
  const canManageProcessing = hasCapability(user, "processing:manage");
  const [jobs, setJobs] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [duplicateReviews, setDuplicateReviews] = useState([]);
  const [savedFilters, setSavedFilters] = useState([]);
  const [savedFilterName, setSavedFilterName] = useState("");
  const [submissionFilters, setSubmissionFilters] = useState(defaultSubmissionFilters);
  const [jobFilters, setJobFilters] = useState(defaultJobFilters);
  const [error, setError] = useState("");

  async function load(nextJobFilters = jobFilters, nextSubmissionFilters = submissionFilters) {
    try {
      const requests = [
        apiFetch(`/ingestion/jobs/${toQueryString(nextJobFilters)}`),
        apiFetch(`/ingestion/submissions/${toQueryString(nextSubmissionFilters)}`)
      ];
      if (canManageProcessing) {
        requests.push(apiFetch("/ingestion/duplicate-reviews/"));
        requests.push(apiFetch("/saved-filters/?target=queue"));
      }
      const [jobPayload, submissionPayload, duplicatePayload = [], savedFilterPayload = []] = await Promise.all(requests);
      setJobs(jobPayload);
      setSubmissions(submissionPayload);
      setDuplicateReviews(duplicatePayload);
      setSavedFilters(savedFilterPayload);
      setError("");
    } catch (nextError) {
      setError(nextError.message);
      toast.error(nextError.message);
    }
  }

  async function retrySubmission(submissionId) {
    try {
      await apiFetch(`/ingestion/submissions/${submissionId}/retry/`, {
        method: "POST",
        body: {}
      });
      await load();
    } catch (nextError) {
      toast.error(nextError.message);
    }
  }

  useEffect(() => {
    load();
  }, [user?.id, canManageProcessing]);

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
      await load();
    } catch (nextError) {
      toast.error(nextError.message);
    }
  }

  async function saveCurrentFilter() {
    if (!savedFilterName.trim()) {
      toast.error("Name this filter before saving it.");
      return;
    }

    try {
      await apiFetch("/saved-filters/", {
        method: "POST",
        body: {
          target: "queue",
          name: savedFilterName.trim(),
          params: {
            submissions: submissionFilters,
            jobs: jobFilters
          }
        }
      });
      setSavedFilterName("");
      toast.success("Queue filter saved.");
      await load();
    } catch (nextError) {
      toast.error(nextError.message);
    }
  }

  function applySavedFilter(filter) {
    const nextSubmissionFilters = { ...defaultSubmissionFilters, ...((filter.params || {}).submissions || {}) };
    const nextJobFilters = { ...defaultJobFilters, ...((filter.params || {}).jobs || {}) };
    setSubmissionFilters(nextSubmissionFilters);
    setJobFilters(nextJobFilters);
    load(nextJobFilters, nextSubmissionFilters);
  }

  async function deleteSavedFilter(id) {
    try {
      await apiFetch(`/saved-filters/${id}/`, { method: "DELETE" });
      toast.success("Queue filter removed.");
      await load();
    } catch (nextError) {
      toast.error(nextError.message);
    }
  }

  return (
    <div className="two-column-layout">
      <section className="detail-card">
        <p className="eyebrow">Processing</p>
        <h1>Queue</h1>
        {error ? <p className="muted-copy">{error}</p> : null}
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            load();
          }}
        >
          <label>
            <span>Job search</span>
            <input value={jobFilters.q} onChange={(event) => setJobFilters({ ...jobFilters, q: event.target.value })} />
          </label>
          <div className="detail-facts">
            <label>
              <span className="fact-label">Job status</span>
              <select value={jobFilters.status} onChange={(event) => setJobFilters({ ...jobFilters, status: event.target.value })}>
                <option value="">Any</option>
                <option value="queued">Queued</option>
                <option value="processing">Processing</option>
                <option value="succeeded">Succeeded</option>
                <option value="failed">Failed</option>
              </select>
            </label>
            <label>
              <span className="fact-label">Submission status</span>
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
          <div className="inline-pills">
            <button type="submit" className="primary-button">
              Apply queue filters
            </button>
            {canManageProcessing ? (
              <button type="button" className="ghost-button" onClick={refreshCatalog}>
                Refresh source catalog
              </button>
            ) : null}
          </div>
        </form>
        {jobs.length ? (
          <div className="queue-list">
            {jobs.map((job) => (
              <article key={job.id} className="queue-card">
                <div className="queue-card-top">
                  <strong>{job.job_type}</strong>
                  <StatusPill value={job.status} />
                </div>
                <p>Retries: {job.retry_count}</p>
                <p>{job.last_error || "No recorded failures."}</p>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="No jobs yet" body="Queued ingestion and reprocessing jobs will appear here." />
        )}
      </section>
      <section className="detail-card">
        <p className="eyebrow">Review</p>
        <h2>Requests</h2>
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            load();
          }}
        >
          <label>
            <span>Submission search</span>
            <input
              value={submissionFilters.q}
              onChange={(event) => setSubmissionFilters({ ...submissionFilters, q: event.target.value })}
            />
          </label>
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
          {canManageProcessing ? (
            <div className="inline-pills">
              <input
                value={savedFilterName}
                onChange={(event) => setSavedFilterName(event.target.value)}
                placeholder="Save queue filter as..."
              />
              <button type="button" className="ghost-button" onClick={saveCurrentFilter}>
                Save queue filter
              </button>
            </div>
          ) : null}
        </form>
        <div className="queue-list">
          {submissions.map((submission) => (
            <article key={submission.id} className="queue-card">
              <div className="queue-card-top">
                <strong>{submission.original_input}</strong>
                <StatusPill value={submission.status} />
              </div>
              <p>Resolution: {submission.resolution_status}</p>
              <p>Linked book: {submission.linked_book_slug || "Pending"}</p>
              {submission.linked_book_slug ? (
                <Link to={`/books/${submission.linked_book_slug}`} className="primary-link">
                  Open book record
                </Link>
              ) : null}
              {submission.served_from_database ? <p>Fulfilled from the existing catalog.</p> : null}
              {submission.resolved_url && !submission.served_from_database ? (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => retrySubmission(submission.id)}
                >
                  Re-run processing
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </section>
      {savedFilters.length ? (
        <section className="detail-card">
          <p className="eyebrow">Saved queue filters</p>
          <div className="queue-list">
            {savedFilters.map((filter) => (
              <article key={filter.id} className="queue-card">
                <strong>{filter.name}</strong>
                <div className="inline-pills">
                  <button type="button" className="primary-button" onClick={() => applySavedFilter(filter)}>
                    Apply
                  </button>
                  <button type="button" className="ghost-button" onClick={() => deleteSavedFilter(filter.id)}>
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {canManageProcessing ? (
        <section className="detail-card">
          <p className="eyebrow">Duplicate Review</p>
          <h2>Reviewer decisions</h2>
          <div className="queue-list">
            {duplicateReviews.map((review) => (
              <article key={review.id} className="queue-card">
                <div className="queue-card-top">
                  <strong>{review.submission?.original_input}</strong>
                  <StatusPill value={review.status} />
                </div>
                <p>Detected by: {review.detected_by}</p>
                <p>Existing book: {review.existing_book?.title || "Unknown"}</p>
                <div className="inline-pills">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => resolveDuplicate(review.id, "confirm_existing")}
                  >
                    Confirm existing
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => resolveDuplicate(review.id, "dismiss")}
                  >
                    Keep under review
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
