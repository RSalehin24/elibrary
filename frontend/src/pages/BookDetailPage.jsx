import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import StatusPill from "../components/StatusPill";
import { useSession } from "../hooks/useSession";
import { hasCapability } from "../utils/capabilities";

export default function BookDetailPage() {
  const { user } = useSession();
  const { slug } = useParams();
  const [book, setBook] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionMessage, setActionMessage] = useState("");
  const [editor, setEditor] = useState({
    title: "",
    summary: "",
    contributors: "",
    series: "",
    categories: "",
    notes: ""
  });
  const [metadataVersions, setMetadataVersions] = useState([]);
  const [metadataReviews, setMetadataReviews] = useState([]);
  const [reviewForm, setReviewForm] = useState({ state: "pending", notes: "" });
  const [readerState, setReaderState] = useState({ last_location: "", progress_percent: 0 });
  const [readerAccess, setReaderAccess] = useState(false);
  const [readerStateMessage, setReaderStateMessage] = useState("");
  const [bookmarks, setBookmarks] = useState([]);
  const [bookmarkForm, setBookmarkForm] = useState({ location: "", label: "", note: "" });
  const canEditMetadata = hasCapability(user, "metadata:edit");

  useEffect(() => {
    async function loadBook() {
      try {
        setLoading(true);
        const payload = await apiFetch(`/catalog/books/${slug}/`);
        setBook(payload);
        setError("");
      } catch (nextError) {
        setError(nextError.message);
      } finally {
        setLoading(false);
      }
    }

    loadBook();
  }, [slug]);

  useEffect(() => {
    if (!book) {
      return;
    }
    setEditor({
      title: book.title || "",
      summary: book.summary || "",
      contributors: (book.contributors || []).map((entry) => `${entry.name}|${entry.role}`).join("\n"),
      series: (book.series || []).join(", "),
      categories: (book.categories || []).join(", "),
      notes: ""
    });
  }, [book]);

  useEffect(() => {
    if (!book || !user) {
      setMetadataVersions([]);
      setMetadataReviews([]);
      setBookmarks([]);
      setReaderAccess(false);
      setReaderState({ last_location: "", progress_percent: 0 });
      return;
    }

    async function loadSupplementalData() {
      try {
        const requests = [
          apiFetch(`/access/books/${slug}/reading-session/`).catch((nextError) => {
            if ([401, 403].includes(nextError.status)) {
              return null;
            }
            throw nextError;
          }),
          apiFetch(`/access/books/${slug}/bookmarks/`).catch((nextError) => {
            if ([401, 403].includes(nextError.status)) {
              return [];
            }
            throw nextError;
          })
        ];

        if (canEditMetadata) {
          requests.push(
            apiFetch(`/catalog/books/${slug}/metadata-versions/`).catch((nextError) => {
              if ([401, 403].includes(nextError.status)) {
                return [];
              }
              throw nextError;
            })
          );
          requests.push(
            apiFetch(`/catalog/books/${slug}/metadata-reviews/`).catch((nextError) => {
              if ([401, 403].includes(nextError.status)) {
                return [];
              }
              throw nextError;
            })
          );
        }

        const [sessionPayload, bookmarkPayload, metadataPayload = [], reviewPayload = []] = await Promise.all(requests);
        if (sessionPayload) {
          setReaderAccess(true);
          setReaderState({
            last_location: sessionPayload.last_location || "",
            progress_percent: sessionPayload.progress_percent || 0
          });
        } else {
          setReaderAccess(false);
        }
        setBookmarks(bookmarkPayload);
        setMetadataVersions(metadataPayload);
        setMetadataReviews(reviewPayload);
      } catch (nextError) {
        setActionMessage(nextError.message);
      }
    }

    loadSupplementalData();
  }, [book?.id, slug, user?.id, canEditMetadata]);

  async function launchReader() {
    try {
      const payload = await apiFetch(`/access/books/${slug}/reader-launch/`, {
        method: "POST",
        body: {}
      });
      window.open(payload.launch_url, "_blank", "noopener,noreferrer");
      setActionMessage("Reader launch approved. A new tab has been opened.");
    } catch (nextError) {
      setActionMessage(nextError.message);
    }
  }

  async function saveMetadata(event) {
    event.preventDefault();
    try {
      const contributors = editor.contributors
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, role = "author"] = line.split("|").map((part) => part.trim());
          return { name, role: role || "author" };
        });

      const payload = await apiFetch(`/catalog/books/${slug}/metadata/`, {
        method: "PATCH",
        body: {
          title: editor.title,
          summary: editor.summary,
          contributors,
          series: editor.series.split(",").map((value) => value.trim()).filter(Boolean),
          categories: editor.categories.split(",").map((value) => value.trim()).filter(Boolean),
          notes: editor.notes
        }
      });
      setBook(payload);
      const [versionsPayload, reviewsPayload] = await Promise.all([
        apiFetch(`/catalog/books/${slug}/metadata-versions/`),
        apiFetch(`/catalog/books/${slug}/metadata-reviews/`)
      ]);
      setMetadataVersions(versionsPayload);
      setMetadataReviews(reviewsPayload);
      setActionMessage("Metadata updated and versioned successfully.");
    } catch (nextError) {
      setActionMessage(nextError.message);
    }
  }

  async function saveReadingSession(event) {
    event.preventDefault();
    try {
      const payload = await apiFetch(`/access/books/${slug}/reading-session/`, {
        method: "POST",
        body: {
          last_location: readerState.last_location,
          progress_percent: Number(readerState.progress_percent) || 0
        }
      });
      setReaderState({
        last_location: payload.last_location || "",
        progress_percent: payload.progress_percent || 0
      });
      setReaderStateMessage("Reading progress saved.");
      setReaderAccess(true);
    } catch (nextError) {
      setReaderStateMessage(nextError.message);
    }
  }

  async function createBookmark(event) {
    event.preventDefault();
    try {
      const payload = await apiFetch(`/access/books/${slug}/bookmarks/`, {
        method: "POST",
        body: bookmarkForm
      });
      setBookmarks((current) => [payload, ...current]);
      setBookmarkForm({ location: "", label: "", note: "" });
      setReaderAccess(true);
      setReaderStateMessage("Bookmark saved.");
    } catch (nextError) {
      setReaderStateMessage(nextError.message);
    }
  }

  async function deleteBookmark(id) {
    try {
      await apiFetch(`/access/bookmarks/${id}/`, { method: "DELETE" });
      setBookmarks((current) => current.filter((bookmark) => bookmark.id !== id));
      setReaderStateMessage("Bookmark removed.");
    } catch (nextError) {
      setReaderStateMessage(nextError.message);
    }
  }

  async function createMetadataReview(event) {
    event.preventDefault();
    try {
      const payload = await apiFetch(`/catalog/books/${slug}/metadata-reviews/`, {
        method: "POST",
        body: reviewForm
      });
      setMetadataReviews((current) => [payload, ...current]);
      setReviewForm({ state: "pending", notes: "" });
      setBook((current) => ({ ...current, review_state: payload.state }));
      setActionMessage("Metadata review state recorded.");
    } catch (nextError) {
      setActionMessage(nextError.message);
    }
  }

  async function updateMetadataReview(reviewId, state) {
    try {
      const payload = await apiFetch(`/catalog/metadata-reviews/${reviewId}/`, {
        method: "PATCH",
        body: { state }
      });
      setMetadataReviews((current) =>
        current.map((review) => (review.id === reviewId ? payload : review))
      );
      setBook((current) => ({ ...current, review_state: payload.state }));
      setActionMessage("Metadata review updated.");
    } catch (nextError) {
      setActionMessage(nextError.message);
    }
  }

  if (loading) {
    return <div className="page-state">Loading book record...</div>;
  }

  if (error) {
    return <div className="page-state page-state-error">{error}</div>;
  }

  return (
    <div className="detail-layout">
      <section className="detail-sidebar">
        <div className="book-cover-placeholder book-cover-large" aria-hidden="true">
          <span>{book.title.slice(0, 1)}</span>
        </div>
        <div className="detail-statuses">
          <StatusPill value={book.state} />
          <StatusPill value={book.review_state} />
        </div>
        <button type="button" className="primary-button" onClick={launchReader}>
          Launch Reader
        </button>
        {(book.assets || []).map((asset) => (
          <a key={asset.id} className="ghost-button asset-link" href={asset.download_url} target="_blank" rel="noreferrer">
            Download {asset.asset_type.toUpperCase()}
          </a>
        ))}
        {actionMessage ? <p className="form-feedback">{actionMessage}</p> : null}
      </section>
      <section className="detail-main">
        <p className="eyebrow">Book record</p>
        <h1>{book.title}</h1>
        <p className="detail-lead">
          {(book.contributors || [])
            .map((contributor) => `${contributor.name} · ${contributor.role.replace(/_/g, " ")}`)
            .join(" / ")}
        </p>
        <div className="detail-facts">
          <div>
            <span className="fact-label">Series</span>
            <strong>{(book.series || []).join(", ") || "None"}</strong>
          </div>
          <div>
            <span className="fact-label">Categories</span>
            <strong>{(book.categories || []).join(", ") || "Unclassified"}</strong>
          </div>
          <div>
            <span className="fact-label">Source URLs</span>
            <strong>{(book.source_urls || []).join(", ")}</strong>
          </div>
          <div>
            <span className="fact-label">Metadata reviewed</span>
            <strong>{book.metadata_last_reviewed_at || "Not reviewed yet"}</strong>
          </div>
        </div>
        <section className="detail-card">
          <h2>Front matter</h2>
          <div dangerouslySetInnerHTML={{ __html: book.book_info_html || "<p>No front matter extracted yet.</p>" }} />
        </section>
        <section className="detail-card">
          <h2>Dedication</h2>
          <div dangerouslySetInnerHTML={{ __html: book.dedication_html || "<p>No dedication captured.</p>" }} />
        </section>
        <section className="detail-card">
          <h2>TOC shape</h2>
          <pre className="json-block">{JSON.stringify(book.toc || [], null, 2)}</pre>
        </section>
        {book.raw_provenance && Object.keys(book.raw_provenance).length ? (
          <section className="detail-card">
            <h2>Raw provenance</h2>
            <pre className="json-block">{JSON.stringify(book.raw_provenance, null, 2)}</pre>
          </section>
        ) : null}
        <section className="detail-card">
          <h2>Reader state</h2>
          {readerAccess ? (
            <>
              <form className="stack-form" onSubmit={saveReadingSession}>
                <label>
                  <span>Last location</span>
                  <input
                    value={readerState.last_location}
                    onChange={(event) => setReaderState({ ...readerState, last_location: event.target.value })}
                  />
                </label>
                <label>
                  <span>Progress percent</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={readerState.progress_percent}
                    onChange={(event) => setReaderState({ ...readerState, progress_percent: event.target.value })}
                  />
                </label>
                <button type="submit" className="primary-button">
                  Save reading progress
                </button>
              </form>
              <form className="stack-form" onSubmit={createBookmark}>
                <label>
                  <span>Bookmark location</span>
                  <input
                    value={bookmarkForm.location}
                    onChange={(event) => setBookmarkForm({ ...bookmarkForm, location: event.target.value })}
                  />
                </label>
                <label>
                  <span>Label</span>
                  <input
                    value={bookmarkForm.label}
                    onChange={(event) => setBookmarkForm({ ...bookmarkForm, label: event.target.value })}
                  />
                </label>
                <label>
                  <span>Note</span>
                  <input
                    value={bookmarkForm.note}
                    onChange={(event) => setBookmarkForm({ ...bookmarkForm, note: event.target.value })}
                  />
                </label>
                <button type="submit" className="ghost-button">
                  Add bookmark
                </button>
              </form>
              <div className="queue-list">
                {bookmarks.map((bookmark) => (
                  <article key={bookmark.id} className="queue-card">
                    <strong>{bookmark.label || bookmark.location}</strong>
                    <p>{bookmark.note || "No note added."}</p>
                    <button type="button" className="ghost-button" onClick={() => deleteBookmark(bookmark.id)}>
                      Remove bookmark
                    </button>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <p>Reading progress and bookmarks become available after preview or durable read access is granted.</p>
          )}
          {readerStateMessage ? <p className="form-feedback">{readerStateMessage}</p> : null}
        </section>
        {canEditMetadata ? (
          <section className="detail-card">
            <h2>Staff metadata editor</h2>
            <form className="stack-form" onSubmit={saveMetadata}>
              <label>
                <span>Title</span>
                <input value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} />
              </label>
              <label>
                <span>Summary</span>
                <textarea
                  rows="4"
                  value={editor.summary}
                  onChange={(event) => setEditor({ ...editor, summary: event.target.value })}
                />
              </label>
              <label>
                <span>Contributors</span>
                <textarea
                  rows="5"
                  value={editor.contributors}
                  onChange={(event) => setEditor({ ...editor, contributors: event.target.value })}
                  placeholder="Name|author"
                />
              </label>
              <label>
                <span>Series</span>
                <input value={editor.series} onChange={(event) => setEditor({ ...editor, series: event.target.value })} />
              </label>
              <label>
                <span>Categories</span>
                <input
                  value={editor.categories}
                  onChange={(event) => setEditor({ ...editor, categories: event.target.value })}
                />
              </label>
              <label>
                <span>Review note</span>
                <input value={editor.notes} onChange={(event) => setEditor({ ...editor, notes: event.target.value })} />
              </label>
              <button type="submit" className="primary-button">
                Save metadata
              </button>
            </form>
            <div className="queue-list">
              {metadataVersions.map((version) => (
                <article key={version.id} className="queue-card">
                  <strong>{version.source}</strong>
                  <p>{version.notes || "No notes."}</p>
                  <p>{new Date(version.created_at).toLocaleString()}</p>
                </article>
              ))}
            </div>
            <form className="stack-form" onSubmit={createMetadataReview}>
              <label>
                <span>Metadata review state</span>
                <select value={reviewForm.state} onChange={(event) => setReviewForm({ ...reviewForm, state: event.target.value })}>
                  <option value="pending">Pending</option>
                  <option value="needs_review">Needs review</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </label>
              <label>
                <span>Review notes</span>
                <input value={reviewForm.notes} onChange={(event) => setReviewForm({ ...reviewForm, notes: event.target.value })} />
              </label>
              <button type="submit" className="ghost-button">
                Record metadata review
              </button>
            </form>
            <div className="queue-list">
              {metadataReviews.map((review) => (
                <article key={review.id} className="queue-card">
                  <strong>{review.state}</strong>
                  <p>{review.notes || "No notes."}</p>
                  <p>Requested by: {review.requested_by_email || "Unknown"}</p>
                  <div className="inline-pills">
                    <button type="button" className="primary-button" onClick={() => updateMetadataReview(review.id, "approved")}>
                      Approve
                    </button>
                    <button type="button" className="ghost-button" onClick={() => updateMetadataReview(review.id, "rejected")}>
                      Reject
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </section>
    </div>
  );
}
