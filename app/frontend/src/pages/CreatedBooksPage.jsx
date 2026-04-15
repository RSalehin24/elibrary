import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import BookCard from "../components/BookCard";
import BookCardSkeleton from "../components/BookCardSkeleton";
import CatalogToolbar from "../components/CatalogToolbar";
import EmptyState from "../components/EmptyState";
import PropertyTableControls from "../components/PropertyTableControls";
import {
  cleanQueryParams,
  filtersFromSearchParams,
  toQueryString,
} from "../utils/query";

const defaultFilters = {
  q: "",
  author: "",
  series: "",
  category: "",
  state: "",
  review_state: "",
  sort: "-requested_at",
  ownership: "mine",
  page: "1",
  limit: "10",
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
      { value: "archived", label: "Archived" },
    ],
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
      { value: "rejected", label: "Rejected" },
    ],
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
      { value: "-title", label: "Title Z-A" },
    ],
  },
];

const defaultPagination = {
  page: 1,
  limit: 10,
  total_count: 0,
  page_count: 1,
  has_previous: false,
  has_next: false,
};

function normalizeBookPayload(payload) {
  if (Array.isArray(payload)) {
    return {
      entries: payload,
      pagination: {
        ...defaultPagination,
        total_count: payload.length,
      },
    };
  }

  return {
    entries: payload?.entries || [],
    pagination: {
      ...defaultPagination,
      ...(payload?.pagination || {}),
    },
  };
}

export default function CreatedBooksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [books, setBooks] = useState([]);
  const [filters, setFilters] = useState(() =>
    filtersFromSearchParams(defaultFilters, searchParams),
  );
  const [pagination, setPagination] = useState(defaultPagination);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadBooks(nextFilters = filters) {
    try {
      setLoading(true);
      const payload = await apiFetch(
        `/catalog/books/${toQueryString(nextFilters)}`,
      );
      const normalized = normalizeBookPayload(payload);
      setBooks(normalized.entries);
      setPagination(normalized.pagination);
      setError("");
    } catch (nextError) {
      setBooks([]);
      setPagination(defaultPagination);
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
    setSearchParams(cleanQueryParams({ ...filters, page: "1" }));
  }

  function resetFilters() {
    setFilters(defaultFilters);
    setSearchParams(cleanQueryParams(defaultFilters));
  }

  function clearSearch(nextFilters) {
    const nextSearchFilters = { ...nextFilters, page: "1" };
    setFilters(nextSearchFilters);
    setSearchParams(cleanQueryParams(nextSearchFilters));
  }

  const resultCount = error || loading ? "" : `${pagination.total_count}`;

  return (
    <div className="catalog-page page-stack">
      <header className="catalog-page-header catalog-page-header--with-toolbar catalog-page-header--property-layout">
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
          onSearchClear={clearSearch}
          inline
          buttonsLoading={loading}
        />

        <div className="catalog-page-controls-row">
          <PropertyTableControls
            rowsPerPage={Number(pagination.limit) || Number(filters.limit) || 10}
            onRowsPerPageChange={(nextLimit) => {
              const nextFilters = {
                ...filters,
                page: "1",
                limit: String(nextLimit),
              };
              setFilters(nextFilters);
              setSearchParams(cleanQueryParams(nextFilters));
            }}
            page={Number(pagination.page) || 1}
            pageCount={Number(pagination.page_count) || 1}
            hasPrevious={Boolean(pagination.has_previous)}
            hasNext={Boolean(pagination.has_next)}
            onPageChange={(nextPage) => {
              const nextFilters = {
                ...filters,
                page: String(nextPage),
                limit: String(pagination.limit || filters.limit || 10),
              };
              setFilters(nextFilters);
              setSearchParams(cleanQueryParams(nextFilters));
            }}
            disabled={loading}
          />
        </div>
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
        <EmptyState
          title="No books found"
          body="Adjust the search or filters."
        />
      )}
    </div>
  );
}
