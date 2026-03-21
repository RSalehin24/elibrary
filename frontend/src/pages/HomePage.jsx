import { useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import StatusPill from "../components/StatusPill";

function emptyEntry() {
  return { id: crypto.randomUUID(), value: "" };
}

export default function HomePage() {
  const { authenticated } = useSession();
  const toast = useToast();
  const [entries, setEntries] = useState([emptyEntry()]);
  const [results, setResults] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  function updateEntry(id, value) {
    setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, value } : entry)));
  }

  function addEntry() {
    setEntries((current) => [...current, emptyEntry()]);
  }

  function removeEntry(id) {
    setEntries((current) => {
      if (current.length === 1) {
        return current.map((entry) => (entry.id === id ? { ...entry, value: "" } : entry));
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
          auto_process: true
        }
      });
      setResults(payload);
      setEntries([emptyEntry()]);

      const readyCount = payload.filter((submission) => submission.linked_book_slug).length;
      const reusedCount = payload.filter((submission) => submission.served_from_database).length;

      if (readyCount && reusedCount) {
        toast.success(`${readyCount} ready, ${reusedCount} reused from the library.`);
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
      const payload = await apiFetch(`/ingestion/submissions/${submissionId}/confirm-candidate/`, {
        method: "POST",
        body: { candidate_id: candidateId }
      });
      setResults((current) => current.map((entry) => (entry.id === payload.id ? payload : entry)));
      toast.success("Match confirmed.");
    } catch (error) {
      toast.error(error.message);
    }
  }

  return (
    <div className="landing-shell">
      <section className="landing-panel landing-create-panel">
        <div className="landing-create-stack">
          <h1>Create EPUB</h1>
          <form className="landing-form" onSubmit={handleSubmit}>
            <div className="request-stack" role="group" aria-label="Book creation inputs">
              {entries.map((entry, index) => (
                <div key={entry.id} className="request-row">
                  <div className="request-input-scroll">
                    <input
                      type="text"
                      value={entry.value}
                      onChange={(event) => updateEntry(entry.id, event.target.value)}
                      placeholder="URL or Book Name"
                      aria-label={`Request ${index + 1}`}
                    />
                  </div>
                  <div className="request-controls">
                    <button type="button" className="icon-button" onClick={addEntry} aria-label="Add another input">
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
              <button type="submit" className="primary-button" disabled={submitting}>
                {submitting ? "Creating..." : "Create"}
              </button>
            </div>
          </form>
        </div>
      </section>

      {results.length ? (
        <section className="landing-results">
          <div className="section-header compact-section-header">
            <h2>Results</h2>
          </div>
          <div className="submission-list">
            {results.map((submission) => (
              <article key={submission.id} className="submission-card">
                <div className="submission-card-top">
                  <strong>{submission.linked_book?.title || submission.original_input}</strong>
                  <div className="inline-pills">
                    <StatusPill value={submission.status} />
                    <StatusPill value={submission.resolution_status} />
                  </div>
                </div>
                {submission.resolved_url ? <p className="mono-line">{submission.resolved_url}</p> : null}
                {submission.served_from_database ? (
                  <p className="success-copy">Reused existing record.</p>
                ) : null}
                {submission.linked_book ? (
                  <div className="result-meta">
                    <span>{(submission.linked_book.authors || []).join(", ") || "Unknown author"}</span>
                    <span>{(submission.linked_book.series || []).join(", ") || "Standalone"}</span>
                  </div>
                ) : null}
                {submission.linked_book_slug ? (
                  authenticated ? (
                    <Link to={`/books/${submission.linked_book_slug}`} className="primary-link">
                      Open record
                    </Link>
                  ) : (
                    <p className="muted-copy">Sign in to open the record.</p>
                  )
                ) : null}
                {submission.error_message ? <p className="form-feedback">{submission.error_message}</p> : null}
                {submission.candidates?.length ? (
                  authenticated ? (
                    <div className="candidate-stack">
                      {submission.candidates.map((candidate) => (
                        <button
                          type="button"
                          key={candidate.id}
                          className="candidate-button"
                          onClick={() => confirmCandidate(submission.id, candidate.id)}
                        >
                          <span>{candidate.candidate_title}</span>
                          <small>{Math.round(candidate.confidence * 100)}% confidence</small>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="muted-copy">Sign in to choose a match.</p>
                  )
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
