import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import BookCard from "../components/BookCard";
import EmptyState from "../components/EmptyState";
import { useSession } from "../hooks/useSession";
import { toQueryString } from "../utils/query";

const defaultFilters = {
  q: "",
  author: "",
  contributor: "",
  series: "",
  category: "",
  state: "",
  review_state: "",
  sort: "-created_at"
};

export default function HomePage() {
  const { authenticated } = useSession();
  const [books, setBooks] = useState([]);
  const [filters, setFilters] = useState(defaultFilters);
  const [savedFilters, setSavedFilters] = useState([]);
  const [savedFilterName, setSavedFilterName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function loadBooks(nextFilters = filters) {
    try {
      setLoading(true);
      const payload = await apiFetch(`/catalog/books/${toQueryString(nextFilters)}`);
      setBooks(payload);
      setError("");
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadSavedFilters() {
    if (!authenticated) {
      setSavedFilters([]);
      return;
    }

    try {
      const payload = await apiFetch("/saved-filters/?target=catalog");
      setSavedFilters(payload);
    } catch (nextError) {
      setMessage(nextError.message);
    }
  }

  useEffect(() => {
    loadBooks(defaultFilters);
  }, []);

  useEffect(() => {
    loadSavedFilters();
  }, [authenticated]);

  async function applyFilters(event) {
    event.preventDefault();
    await loadBooks(filters);
  }

  function applySavedFilter(savedFilter) {
    const nextFilters = { ...defaultFilters, ...(savedFilter.params || {}) };
    setFilters(nextFilters);
    loadBooks(nextFilters);
    setMessage(`Applied saved filter "${savedFilter.name}".`);
  }

  async function saveCurrentFilter() {
    if (!savedFilterName.trim()) {
      setMessage("Name this filter before saving it.");
      return;
    }

    try {
      await apiFetch("/saved-filters/", {
        method: "POST",
        body: {
          target: "catalog",
          name: savedFilterName.trim(),
          params: filters
        }
      });
      setSavedFilterName("");
      setMessage("Catalog filter saved.");
      await loadSavedFilters();
    } catch (nextError) {
      setMessage(nextError.message);
    }
  }

  async function deleteSavedFilter(id) {
    try {
      await apiFetch(`/saved-filters/${id}/`, { method: "DELETE" });
      setMessage("Saved filter removed.");
      await loadSavedFilters();
    } catch (nextError) {
      setMessage(nextError.message);
    }
  }

  return (
    <div className="page-grid">
      <section className="hero-panel">
        <p className="eyebrow">Evolutionary Refactor</p>
        <h1>A resilient library pipeline for Bengali ebooks.</h1>
        <p className="hero-copy">
          Discover processed titles, review ingest state, and move from a script repository to a controlled
          digital library without breaking the existing HTML and EPUB generation path.
        </p>
        <form className="stack-form" onSubmit={applyFilters}>
          <label className="search-card">
            <span>Search books, contributors, series, or categories</span>
            <input
              type="search"
              value={filters.q}
              onChange={(event) => setFilters({ ...filters, q: event.target.value })}
              placeholder="Try শার্লক, উপন্যাস, or a contributor name"
            />
          </label>
          <div className="detail-facts">
            <label>
              <span className="fact-label">Author</span>
              <input value={filters.author} onChange={(event) => setFilters({ ...filters, author: event.target.value })} />
            </label>
            <label>
              <span className="fact-label">Series</span>
              <input value={filters.series} onChange={(event) => setFilters({ ...filters, series: event.target.value })} />
            </label>
            <label>
              <span className="fact-label">Category</span>
              <input value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })} />
            </label>
            <label>
              <span className="fact-label">State</span>
              <select value={filters.state} onChange={(event) => setFilters({ ...filters, state: event.target.value })}>
                <option value="">Any</option>
                <option value="draft">Draft</option>
                <option value="processing">Processing</option>
                <option value="needs_review">Needs review</option>
                <option value="ready">Ready</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <label>
              <span className="fact-label">Review</span>
              <select
                value={filters.review_state}
                onChange={(event) => setFilters({ ...filters, review_state: event.target.value })}
              >
                <option value="">Any</option>
                <option value="pending">Pending</option>
                <option value="needs_review">Needs review</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
            <label>
              <span className="fact-label">Sort</span>
              <select value={filters.sort} onChange={(event) => setFilters({ ...filters, sort: event.target.value })}>
                <option value="-created_at">Newest first</option>
                <option value="created_at">Oldest first</option>
                <option value="title">Title A-Z</option>
                <option value="-title">Title Z-A</option>
              </select>
            </label>
          </div>
          <div className="inline-pills">
            <button type="submit" className="primary-button">
              Apply filters
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setFilters(defaultFilters);
                loadBooks(defaultFilters);
              }}
            >
              Reset
            </button>
          </div>
          {authenticated ? (
            <div className="inline-pills">
              <input
                value={savedFilterName}
                onChange={(event) => setSavedFilterName(event.target.value)}
                placeholder="Save this filter as..."
              />
              <button type="button" className="ghost-button" onClick={saveCurrentFilter}>
                Save filter
              </button>
            </div>
          ) : null}
          {message ? <p className="form-feedback">{message}</p> : null}
        </form>
      </section>
      <section className="stats-panel">
        <div>
          <span className="stat-label">Catalog records</span>
          <strong>{books.length}</strong>
        </div>
        <div>
          <span className="stat-label">Ready for review</span>
          <strong>{books.filter((book) => book.review_state !== "approved").length}</strong>
        </div>
        <div>
          <span className="stat-label">Active source</span>
          <strong>ebanglalibrary.com</strong>
        </div>
      </section>
      <section className="section-header">
        <div>
          <p className="eyebrow">Library</p>
          <h2>Catalog view</h2>
        </div>
      </section>
      {savedFilters.length ? (
        <section className="detail-card">
          <p className="eyebrow">Saved filters</p>
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
      {loading ? (
        <div className="page-state">Loading catalog...</div>
      ) : error ? (
        <div className="page-state page-state-error">{error}</div>
      ) : books.length ? (
        <section className="book-grid">
          {books.map((book) => (
            <BookCard key={book.id} book={book} />
          ))}
        </section>
      ) : (
        <EmptyState title="No books matched that search" body="Try a shorter title fragment or contributor name." />
      )}
    </div>
  );
}
