import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import BookCard from "../components/BookCard";
import BookCardSkeleton from "../components/BookCardSkeleton";
import CatalogToolbar from "../components/CatalogToolbar";
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

const createdBookFilterFields = [
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
    key: "sort",
    label: "Sort",
    type: "select",
    options: [
      { value: "-requested_at", label: "Newest request first" },
      { value: "requested_at", label: "Oldest request first" },
      { value: "-created_at", label: "Newest book first" },
      { value: "created_at", label: "Oldest book first" },
      { value: "title", label: "Title A-Z" },
      { value: "-title", label: "Title Z-A" }
    ]
  }
];

function cleanFilters(nextFilters) {
  return Object.fromEntries(
    Object.entries(nextFilters).filter(([, value]) => value !== undefined && value !== null && String(value).trim())
  );
}

function filtersFromSearchParams(searchParams) {
  const nextFilters = { ...defaultFilters };

  Object.keys(defaultFilters).forEach((key) => {
    const value = searchParams.get(key);
    if (value !== null) {
      nextFilters[key] = value;
    }
  });

  return nextFilters;
}

export default function CreatedBooksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [books, setBooks] = useState([]);
  const [filters, setFilters] = useState(() => filtersFromSearchParams(searchParams));
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
    const nextFilters = filtersFromSearchParams(searchParams);
    setFilters(nextFilters);
    loadBooks(nextFilters);
  }, [searchParams.toString()]);

  function applyFilters(event) {
    event.preventDefault();
    setSearchParams(cleanFilters(filters));
  }

  function resetFilters() {
    setFilters(defaultFilters);
    setSearchParams(cleanFilters(defaultFilters));
  }

  const resultCount = error || loading ? "" : `${books.length}`;

  return (
    <div className="catalog-page page-stack">
      <header className="catalog-page-header catalog-page-header--with-toolbar">
        <h1 className="created-books-page-title">My Books</h1>

        <CatalogToolbar
          filters={filters}
          setFilters={setFilters}
          fields={createdBookFilterFields}
          defaultFilters={defaultFilters}
          filtersExpanded={filtersExpanded}
          setFiltersExpanded={setFiltersExpanded}
          onSubmit={applyFilters}
          onReset={resetFilters}
          searchPlaceholder="Search your books by title or book ID..."
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
