import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";
import StatusPill from "../components/StatusPill";

const modeOptions = [
  { value: "url", label: "Direct book URLs" },
  { value: "title", label: "Titles to resolve" },
  { value: "csv", label: "CSV import" }
];

export default function SubmissionPage() {
  const [mode, setMode] = useState("url");
  const [content, setContent] = useState("");
  const [submissions, setSubmissions] = useState([]);
  const [latestResults, setLatestResults] = useState([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadSubmissions() {
    const payload = await apiFetch("/ingestion/submissions/");
    setSubmissions(payload);
  }

  useEffect(() => {
    loadSubmissions().catch((error) => setMessage(error.message));
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    try {
      setLoading(true);
      setMessage("");
      const created = await apiFetch("/ingestion/submissions/", {
        method: "POST",
        body: {
          input_type: mode,
          content,
          auto_process: true
        }
      });
      setContent("");
      setLatestResults(created.filter((submission) => submission.linked_book_slug));
      const existingHits = created.filter((submission) => submission.served_from_database).length;
      if (existingHits) {
        setMessage(`${existingHits} request(s) matched books already in the library and were returned without recreating duplicates.`);
      } else {
        setMessage("Submission accepted and routed into the ingestion workflow.");
      }
      await loadSubmissions();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function confirmCandidate(submissionId, candidateId) {
    try {
      await apiFetch(`/ingestion/submissions/${submissionId}/confirm-candidate/`, {
        method: "POST",
        body: { candidate_id: candidateId }
      });
      setMessage("Candidate confirmed. Processing has been queued.");
      await loadSubmissions();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function launchReader(slug) {
    try {
      const payload = await apiFetch(`/access/books/${slug}/reader-launch/`, {
        method: "POST",
        body: {}
      });
      window.open(payload.launch_url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function launchReadersForResults() {
    for (const submission of latestResults) {
      if (!submission.linked_book_slug) {
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const payload = await apiFetch(`/access/books/${submission.linked_book_slug}/reader-launch/`, {
          method: "POST",
          body: {}
        });
        window.open(payload.launch_url, "_blank", "noopener,noreferrer");
      } catch (error) {
        setMessage(error.message);
      }
    }
  }

  function openAllBooks() {
    latestResults.forEach((submission) => {
      if (submission.linked_book_slug) {
        window.open(`/books/${submission.linked_book_slug}`, "_blank", "noopener,noreferrer");
      }
    });
  }

  return (
    <div className="two-column-layout">
      <section className="detail-card">
        <p className="eyebrow">Submission</p>
        <h1>Capture URLs, titles, or CSV rows without losing provenance.</h1>
        <form className="stack-form" onSubmit={handleSubmit}>
          <label>
            <span>Submission mode</span>
            <select value={mode} onChange={(event) => setMode(event.target.value)}>
              {modeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Content</span>
            <textarea
              rows="12"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={
                mode === "url"
                  ? "https://www.ebanglalibrary.com/books/...\nhttps://www.ebanglalibrary.com/books/..."
                  : mode === "title"
                    ? "মৃত কৈটভ ১\nশার্লক হোমস সমগ্র"
                    : "url,title\nhttps://www.ebanglalibrary.com/books/...,Sample Title"
              }
            />
          </label>
          <button type="submit" className="primary-button" disabled={loading}>
            {loading ? "Submitting..." : "Submit for processing"}
          </button>
        </form>
        {message ? <p className="form-feedback">{message}</p> : null}
        {latestResults.length ? (
          <div className="detail-card">
            <h2>Completion state</h2>
            <p>{latestResults.length} linked book record(s) are ready for follow-up.</p>
            <div className="inline-pills">
              <button type="button" className="primary-button" onClick={openAllBooks}>
                Open all records
              </button>
              <button type="button" className="ghost-button" onClick={launchReadersForResults}>
                Launch all readers
              </button>
            </div>
            <div className="queue-list">
              {latestResults.map((submission) => (
                <article key={submission.id} className="queue-card">
                  <strong>{submission.linked_book?.title || submission.original_input}</strong>
                  <div className="inline-pills">
                    <Link to={`/books/${submission.linked_book_slug}`} className="primary-link">
                      Open record
                    </Link>
                    <button type="button" className="ghost-button" onClick={() => launchReader(submission.linked_book_slug)}>
                      Launch reader
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </section>
      <section className="detail-card">
        <p className="eyebrow">Recent activity</p>
        <h2>Your submissions</h2>
        <div className="submission-list">
          {submissions.map((submission) => (
            <article key={submission.id} className="submission-card">
              <div className="submission-card-top">
                <strong>{submission.original_input}</strong>
                <div className="inline-pills">
                  <StatusPill value={submission.status} />
                  <StatusPill value={submission.resolution_status} />
                </div>
              </div>
              {submission.resolved_url ? <p className="mono-line">{submission.resolved_url}</p> : null}
              {submission.served_from_database ? (
                <p className="form-feedback">Matched an existing library record. No duplicate book was created.</p>
              ) : null}
              {submission.linked_book_slug ? (
                <Link to={`/books/${submission.linked_book_slug}`} className="primary-link">
                  Open linked book
                </Link>
              ) : null}
              {submission.error_message ? <p className="form-feedback">{submission.error_message}</p> : null}
              {submission.candidates?.length ? (
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
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
