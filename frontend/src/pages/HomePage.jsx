import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import BookCard from "../components/BookCard";
import BookCardSkeleton from "../components/BookCardSkeleton";
import CatalogToolbar from "../components/CatalogToolbar";
import EmptyState from "../components/EmptyState";
import { cleanQueryParams, filtersFromSearchParams, toQueryString } from "../utils/query";

const defaultFilters = {
  q: "",
  author: "",
  series: "",
  category: "",
  state: "",
  review_state: "",
  record_type: "all",
  sort: "-created_at"
};

const homeFilterFields = [
  { key: "author", label: "Author" },
  { key: "series", label: "Series" },
  { key: "category", label: "Category" },
  {
    key: "state",
    label: "State",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "draft", label: "Draft" },
      { value: "processing", label: "Processing" },
      { value: "needs_review", label: "Needs review" },
      { value: "ready", label: "Ready" },
      { value: "published", label: "Published" },
      { value: "archived", label: "Archived" }
    ]
  },
  {
    key: "review_state",
    label: "Review",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "pending", label: "Pending" },
      { value: "needs_review", label: "Needs review" },
      { value: "approved", label: "Approved" },
      { value: "rejected", label: "Rejected" }
    ]
  },
  {
    key: "record_type",
    label: "Type",
    type: "select",
    options: [
      { value: "all", label: "All books" },
      { value: "digital", label: "Digital" },
      { value: "manual", label: "Manual" }
    ]
  },
  {
    key: "sort",
    label: "Sort",
    type: "select",
    options: [
      { value: "-created_at", label: "Newest first" },
      { value: "created_at", label: "Oldest first" },
      { value: "title", label: "Title A-Z" },
      { value: "-title", label: "Title Z-A" }
    ]
  }
];

export default function HomePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [books, setBooks] = useState([]);
  const [filters, setFilters] = useState(() => filtersFromSearchParams(defaultFilters, searchParams));
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
    const nextFilters = filtersFromSearchParams(defaultFilters, searchParams);
    setFilters(nextFilters);
    loadBooks(nextFilters);
  }, [searchParams.toString()]);

  function applyFilters(event) {
    event.preventDefault();
    setSearchParams(cleanQueryParams(filters));
  }

  function resetFilters() {
    setFilters(defaultFilters);
    setSearchParams(cleanQueryParams(defaultFilters));
  }

  const resultCount = error || loading ? "" : `${books.length}`;

  return (
    <div className="catalog-page page-stack">
      <header className="catalog-page-header catalog-page-header--with-toolbar">
        <h1 className="created-books-page-title">All Books</h1>

        <CatalogToolbar
          filters={filters}
          setFilters={setFilters}
          fields={homeFilterFields}
          defaultFilters={defaultFilters}
          filtersExpanded={filtersExpanded}
          setFiltersExpanded={setFiltersExpanded}
          onSubmit={applyFilters}
          onReset={resetFilters}
          searchPlaceholder="Search all books by title, book ID, or writer..."
          resultCount={resultCount}
          inline
        />
      </header>

      {loading ? (
        <section className="book-grid book-grid-loading">
          {Array.from({ length: 6 }).map((_, index) => (
            <BookCardSkeleton key={index} />
          ))}
        </section>
      ) : error ? (
        <div className="page-state page-state-error">{error}</div>
      ) : books.length ? (
        <section className="book-grid">
          {books.map((book) => (
            <BookCard key={book.id} book={book} />
          ))}
        </section>
      ) : (
        <EmptyState title="No books found" body="Adjust the search or filters." />
      )}
    </div>
  );
}
