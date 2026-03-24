import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, resolveAppUrl } from "../api/client";
import PageLoader from "../components/PageLoader";
import StatusPill from "../components/StatusPill";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";

function emptyEntry() {
  return { id: crypto.randomUUID(), value: "" };
}

function isDeletedSubmission(submission) {
  return Boolean(
    submission?.linked_book_deleted ||
    submission?.linked_book?.state === "soft_deleted" ||
    submission?.status === "deleted",
  );
}

function displayUrl(value) {
  if (!value) {
    return "";
  }
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

export default function CreateBooksPage() {
  const { authenticated } = useSession();
  const toast = useToast();
  const [entries, setEntries] = useState([emptyEntry()]);
  const [results, setResults] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [dismissedDialogIds, setDismissedDialogIds] = useState([]);
  const [actionLoading, setActionLoading] = useState("");

  function updateEntry(id, value) {
    setEntries((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, value } : entry)),
    );
  }

  function addEntry() {
    setEntries((current) => [...current, emptyEntry()]);
  }

  function removeEntry(id) {
    setEntries((current) => {
      if (current.length === 1) {
        return current.map((entry) =>
          entry.id === id ? { ...entry, value: "" } : entry,
        );
      }
      return current.filter((entry) => entry.id !== id);
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const values = entries.map((entry) => entry.value.trim()).filter(Boolean);
    if (!values.length) {
      toast.error("Enter at least one URL or book name.");
      return;
    }

    try {
      setSubmitting(true);
      const payload = await apiFetch("/ingestion/submissions/", {
        method: "POST",
        body: {
          entries: values,
          auto_process: true,
        },
      });
      setResults(payload);
      setEntries([emptyEntry()]);
      setDismissedDialogIds([]);

      const readyCount = payload.filter(
        (submission) => submission.linked_book_slug,
      ).length;
      const reusedCount = payload.filter(
        (submission) => submission.served_from_database,
      ).length;

      if (readyCount && reusedCount) {
        toast.success(
          `${readyCount} ready, ${reusedCount} reused from the library.`,
        );
      } else if (readyCount) {
        toast.success(`${readyCount} request(s) accepted.`);
      } else {
        toast.info("Request accepted. Some titles may need review.");
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmCandidate(submissionId, candidateId) {
    try {
      const payload = await apiFetch(
        `/ingestion/submissions/${submissionId}/confirm-candidate/`,
        {
          method: "POST",
          body: { candidate_id: candidateId },
        },
      );
      setResults((current) =>
        current.map((entry) => (entry.id === payload.id ? payload : entry)),
      );
      toast.success("Match confirmed.");
    } catch (error) {
      toast.error(error.message);
    }
  }

  useEffect(() => {
    const submissionIds = results.map((submission) => submission.id);

    if (!submissionIds.length) {
      return undefined;
    }

    const timer = window.setTimeout(async () => {
      try {
        const payloads = await apiFetch("/ingestion/submissions/status/", {
          method: "POST",
          body: { ids: submissionIds },
        });
        const payloadMap = new Map(
          (payloads || []).map((entry) => [entry.id, entry]),
        );
        if (!payloadMap.size) {
          return;
        }
        setResults((current) =>
          current.map(
            (submission) => payloadMap.get(submission.id) || submission,
          ),
        );
      } catch (error) {
        // Keep the landing page quiet while background polling is happening.
      }
    }, 4000);

    return () => window.clearTimeout(timer);
  }, [results]);

  async function getActionLinks(submissionId) {
    const payload = await apiFetch(
      `/ingestion/submissions/${submissionId}/action-links/`,
      {
        method: "POST",
        body: {},
      },
    );
    return payload;
  }

  function openUrl(url) {
    window.open(resolveAppUrl(url), "_blank", "noopener,noreferrer");
  }

  async function readBook(submission) {
    const payload = await getActionLinks(submission.id);
    if (!payload.launch_url) {
      throw new Error("Reader is not available yet.");
    }
    openUrl(payload.launch_url);
  }

  async function downloadBook(submission) {
    const payload = await getActionLinks(submission.id);
    const downloadUrl = payload.epub_download_url || payload.html_preview_url;
    if (!downloadUrl) {
      throw new Error("Download is not available yet.");
    }
    openUrl(downloadUrl);
  }

  async function runBookAction(submission, action) {
    const key = `${submission.id}:${action}`;
    try {
      setActionLoading(key);
      if (action === "read") {
        await readBook(submission);
      } else if (action === "download") {
        await downloadBook(submission);
      } else {
        const payload = await getActionLinks(submission.id);
        const downloadUrl =
          payload.epub_download_url || payload.html_preview_url;
        if (!payload.launch_url) {
          throw new Error("Reader is not available yet.");
        }
        if (!downloadUrl) {
          throw new Error("Download is not available yet.");
        }
        openUrl(payload.launch_url);
        openUrl(downloadUrl);
      }
      dismissDialog(submission.id);
      toast.success("Action started.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setActionLoading("");
    }
  }

  async function retrySubmission(submission) {
    const key = `${submission.id}:retry`;
    try {
      setActionLoading(key);
      await apiFetch(`/ingestion/submissions/${submission.id}/retry/`, {
        method: "POST",
        body: {},
      });
      const refreshed = await apiFetch(
        `/ingestion/submissions/${submission.id}/`,
      );
      setResults((current) =>
        current.map((entry) => (entry.id === refreshed.id ? refreshed : entry)),
      );
      toast.success("Book creation queued.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setActionLoading("");
    }
  }

  function dismissDialog(submissionId) {
    setDismissedDialogIds((current) =>
      current.includes(submissionId) ? current : [...current, submissionId],
    );
  }

  function reopenDialog(submissionId) {
    setDismissedDialogIds((current) =>
      current.filter((entryId) => entryId !== submissionId),
    );
  }

  const dialogSubmission =
    results.find(
      (submission) =>
        !dismissedDialogIds.includes(submission.id) &&
        submission.resolution_status === "ambiguous" &&
        submission.candidates?.length,
    ) ||
    results.find(
      (submission) =>
        !dismissedDialogIds.includes(submission.id) &&
        submission.linked_book_slug &&
        submission.status === "ready",
    );

  const dialogMode =
    dialogSubmission?.resolution_status === "ambiguous"
      ? "candidate"
      : "actions";
  const dialogStepLabel =
    dialogMode === "candidate" ? "Step 1 of 2" : "Step 2 of 2";
  const dialogLead =
    dialogMode === "candidate"
      ? "Choose one exact match before we continue."
      : "";

  const shellClassName = results.length
    ? "landing-shell"
    : "landing-shell landing-shell-centered";

  return (
    <div className={shellClassName}>
      <section className="landing-panel landing-create-panel">
        <div className="landing-create-stack">
          <h1>Create EPUB</h1>
          <form className="landing-form" onSubmit={handleSubmit}>
            <div
              className="request-stack"
              role="group"
              aria-label="Book creation inputs"
            >
              {entries.map((entry, index) => (
                <div key={entry.id} className="request-row">
                  <div className="request-input-scroll">
                    <input
                      type="text"
                      value={entry.value}
                      onChange={(event) =>
                        updateEntry(entry.id, event.target.value)
                      }
                      placeholder="URL or Book Name"
                      aria-label={`Request ${index + 1}`}
                    />
                  </div>
                  <div className="request-controls">
                    <button
                      type="button"
                      className="icon-button"
                      onClick={addEntry}
                      aria-label="Add another input"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="icon-button icon-button-muted"
                      onClick={() => removeEntry(entry.id)}
                      aria-label="Remove this input"
                    >
                      -
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="inline-pills landing-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={submitting}
              >
                {submitting ? "Creating..." : "Create"}
              </button>
            </div>
          </form>
        </div>
      </section>

      {submitting && !results.length ? (
        <section className="landing-results">
          <PageLoader
            label="Submitting requests"
            detail="Resolving matches and queueing book creation for this batch."
          />
        </section>
      ) : null}

      {results.length ? (
        <div className="submission-list">
          {results.map((submission) => {
            const isDeleted = isDeletedSubmission(submission);
            return (
              <article
                key={submission.id}
                className={`submission-card${isDeleted ? " is-deleted" : ""}`}
              >
                <div className="submission-card-top">
                  <strong className="submission-card-title">
                    {submission.linked_book?.title || submission.original_input}
                  </strong>
                  <div className="inline-pills submission-card-statuses">
                    <StatusPill value={submission.status} />
                    <StatusPill value={submission.resolution_status} />
                  </div>
                </div>
                {submission.resolved_url ? (
                  <p className="mono-line submission-card-link">
                    {displayUrl(submission.resolved_url)}
                  </p>
                ) : null}
                {submission.served_from_database ? (
                  <p className="success-copy submission-card-reuse-note">
                    Reused existing record.
                  </p>
                ) : null}
                {submission.linked_book && !isDeleted ? (
                  <div className="result-meta">
                    <span>
                      {(submission.linked_book.authors || []).join(", ") ||
                        "Unknown author"}
                    </span>
                    <span>
                      {(submission.linked_book.series || []).join(", ") ||
                        "Standalone"}
                    </span>
                  </div>
                ) : null}
                {isDeleted ? (
                  <div className="submission-card-actions">
                    <p className="muted-copy submission-card-note">
                      Deleted from the library.
                    </p>
                    {authenticated ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => retrySubmission(submission)}
                        disabled={actionLoading === `${submission.id}:retry`}
                      >
                        {actionLoading === `${submission.id}:retry`
                          ? "Queueing..."
                          : "Create again"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {submission.resolution_status === "ambiguous" &&
                submission.candidates?.length ? (
                  <div className="submission-card-actions">
                    <p className="muted-copy">
                      {submission.candidates.length} possible match
                      {submission.candidates.length === 1 ? "" : "es"} found.
                    </p>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => reopenDialog(submission.id)}
                    >
                      Review match
                    </button>
                  </div>
                ) : null}
                {submission.linked_book_slug &&
                submission.status === "ready" &&
                !isDeleted ? (
                  <div className="submission-card-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => reopenDialog(submission.id)}
                    >
                      Choose action
                    </button>
                    {authenticated ? (
                      <Link
                        to={`/books/${submission.linked_book_slug}`}
                        className="primary-button"
                      >
                        Open record
                      </Link>
                    ) : (
                      <p className="muted-copy">
                        Sign in to keep this book after the session ends.
                      </p>
                    )}
                  </div>
                ) : null}
                {submission.error_message ? (
                  <p className="form-feedback">{submission.error_message}</p>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}

      {dialogSubmission ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`submission-dialog-${dialogSubmission.id}`}
          >
            <div className="dialog-header">
              <div>
                <span className="dialog-step">{dialogStepLabel}</span>
                <h2 id={`submission-dialog-${dialogSubmission.id}`}>
                  {dialogSubmission.linked_book?.title ||
                    dialogSubmission.original_input}
                </h2>
              </div>
              <button
                type="button"
                className="icon-button icon-button-muted"
                aria-label="Close dialog"
                onClick={() => dismissDialog(dialogSubmission.id)}
              >
                ×
              </button>
            </div>

            {dialogMode === "candidate" ? (
              <>
                <p className="muted-copy">{dialogLead}</p>
                <div className="dialog-stack">
                  {dialogSubmission.candidates.map((candidate) => (
                    <button
                      type="button"
                      key={candidate.id}
                      className="candidate-button"
                      onClick={() =>
                        confirmCandidate(dialogSubmission.id, candidate.id)
                      }
                    >
                      <span>{candidate.candidate_title}</span>
                      <small>
                        {candidate.candidate_author ||
                          `${Math.round(candidate.confidence * 100)}% confidence`}
                      </small>
                    </button>
                  ))}
                </div>
                <div className="dialog-footer">
                  <p className="muted-copy dialog-note">
                    We only continue after you choose one exact source.
                  </p>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => dismissDialog(dialogSubmission.id)}
                  >
                    Not now
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => runBookAction(dialogSubmission, "read")}
                    disabled={actionLoading === `${dialogSubmission.id}:read`}
                  >
                    Read
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => runBookAction(dialogSubmission, "download")}
                    disabled={
                      actionLoading === `${dialogSubmission.id}:download`
                    }
                  >
                    Download
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      runBookAction(dialogSubmission, "read-download")
                    }
                    disabled={
                      actionLoading === `${dialogSubmission.id}:read-download`
                    }
                  >
                    Both
                  </button>
                </div>
                <div className="dialog-footer">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => dismissDialog(dialogSubmission.id)}
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
