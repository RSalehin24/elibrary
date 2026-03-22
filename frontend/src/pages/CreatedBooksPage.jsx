import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";
import BookCard from "../components/BookCard";
import EmptyState from "../components/EmptyState";
import { toQueryString } from "../utils/query";

const defaultFilters = {
  q: "",
  author: "",
  series: "",
  category: "",
  state: "",
  review_state: "",
  sort: "-requested_at",
  ownership: "mine"
};

export default function CreatedBooksPage() {
  const [books, setBooks] = useState([]);
  const [filters, setFilters] = useState(defaultFilters);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
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

  useEffect(() => {
    loadBooks(defaultFilters);
  }, []);

  async function handleSearch(event) {
    event.preventDefault();
    await loadBooks(filters);
  }

  return (
    <div className="page-stack">
      <section className="detail-card toolbar-panel">
        <div className="panel-header">
          <h1>My Created Books</h1>
          <div className="inline-pills">
            <button type="button" className="ghost-button" onClick={() => setFiltersExpanded((current) => !current)}>
              {filtersExpanded ? "Hide filters" : "Filters"}
            </button>
            <Link to="/create" className="primary-button">
              Create Books
            </Link>
          </div>
        </div>
        <form className="stack-form" onSubmit={handleSearch}>
          <div className="search-inline">
            <input
              type="search"
              value={filters.q}
              onChange={(event) => setFilters({ ...filters, q: event.target.value })}
              placeholder="Search created books"
            />
            <button type="submit" className="primary-button">
              Search
            </button>
          </div>

          {filtersExpanded ? (
            <>
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
                    <option value="-requested_at">Newest request first</option>
                    <option value="requested_at">Oldest request first</option>
                    <option value="-created_at">Newest book first</option>
                    <option value="created_at">Oldest book first</option>
                    <option value="title">Title A-Z</option>
                    <option value="-title">Title Z-A</option>
                  </select>
                </label>
              </div>
              <div className="inline-pills">
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
            </>
          ) : null}
        </form>
      </section>

      {loading ? (
        <div className="page-state">Loading books...</div>
      ) : error ? (
        <div className="page-state page-state-error">{error}</div>
      ) : books.length ? (
        <section className="book-grid">
          {books.map((book) => (
            <BookCard key={book.id} book={book} />
          ))}
        </section>
      ) : (
        <EmptyState title="No created books found" body="Try a different search or create a new book." />
      )}
    </div>
  );
}
