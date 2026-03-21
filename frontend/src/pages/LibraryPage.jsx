import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import BookCard from "../components/BookCard";
import EmptyState from "../components/EmptyState";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
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

export default function LibraryPage() {
  const { authenticated } = useSession();
  const toast = useToast();
  const [books, setBooks] = useState([]);
  const [filters, setFilters] = useState(defaultFilters);
  const [savedFilters, setSavedFilters] = useState([]);
  const [savedFilterName, setSavedFilterName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
      toast.error(nextError.message);
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
    toast.success(`Applied "${savedFilter.name}".`);
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
          target: "catalog",
          name: savedFilterName.trim(),
          params: filters
        }
      });
      setSavedFilterName("");
      toast.success("Filter saved.");
      await loadSavedFilters();
    } catch (nextError) {
      toast.error(nextError.message);
    }
  }

  async function deleteSavedFilter(id) {
    try {
      await apiFetch(`/saved-filters/${id}/`, { method: "DELETE" });
      toast.success("Filter removed.");
      await loadSavedFilters();
    } catch (nextError) {
      toast.error(nextError.message);
    }
  }

  return (
    <div className="page-stack">
      <section className="detail-card toolbar-panel">
        <p className="eyebrow">Library</p>
        <h1>Library</h1>
        <form className="stack-form" onSubmit={applyFilters}>
          <label className="search-card">
            <span>Search</span>
            <input
              type="search"
              value={filters.q}
              onChange={(event) => setFilters({ ...filters, q: event.target.value })}
              placeholder="Title, author, series, category"
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
        </form>
      </section>
      {savedFilters.length ? (
        <section className="detail-card compact-card">
          <p className="eyebrow">Saved</p>
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
