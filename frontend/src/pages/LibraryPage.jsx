import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import BookCard from "../components/BookCard";
import BookCardSkeleton from "../components/BookCardSkeleton";
import CatalogToolbar from "../components/CatalogToolbar";
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
  ownership: "",
  state: "",
  review_state: "",
  created_after: "",
  created_before: "",
  sort: "-created_at"
};

const libraryFilterFields = [
  { key: "author", label: "Author" },
  { key: "contributor", label: "Contributor" },
  { key: "series", label: "Series" },
  { key: "category", label: "Category" },
  {
    key: "ownership",
    label: "Ownership",
    type: "select",
    options: [
      { value: "", label: "All books" },
      { value: "mine", label: "My books" }
    ]
  },
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
  { key: "created_after", label: "Created after", type: "date" },
  { key: "created_before", label: "Created before", type: "date" },
  {
    key: "sort",
    label: "Sort",
    type: "select",
    options: [
      { value: "-created_at", label: "Newest first" },
      { value: "created_at", label: "Oldest first" },
      { value: "-requested_at", label: "Newest request first" },
      { value: "requested_at", label: "Oldest request first" },
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

export default function LibraryPage() {
  const { authenticated } = useSession();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [books, setBooks] = useState([]);
  const [filters, setFilters] = useState(() => filtersFromSearchParams(searchParams));
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [savedFilters, setSavedFilters] = useState([]);
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
    const nextFilters = filtersFromSearchParams(searchParams);
    setFilters(nextFilters);
    loadBooks(nextFilters);
  }, [searchParams.toString()]);

  useEffect(() => {
    loadSavedFilters();
  }, [authenticated]);

  function applyFilters(event) {
    event.preventDefault();
    setSearchParams(cleanFilters(filters));
  }

  function resetFilters() {
    setFilters(defaultFilters);
    setSearchParams(cleanFilters(defaultFilters));
  }

  function applySavedFilter(savedFilter) {
    const nextFilters = { ...defaultFilters, ...(savedFilter.params || {}) };
    setFilters(nextFilters);
    setSearchParams(cleanFilters(nextFilters));
    toast.success(`Applied "${savedFilter.name}".`);
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

  const resultCount = error || loading ? "" : `${books.length}`;

  return (
    <div className="catalog-page page-stack">
      <CatalogToolbar
        filters={filters}
        setFilters={setFilters}
        fields={libraryFilterFields}
        defaultFilters={defaultFilters}
        filtersExpanded={filtersExpanded}
        setFiltersExpanded={setFiltersExpanded}
        onSubmit={applyFilters}
        onReset={resetFilters}
        searchPlaceholder="Search books, authors, translators, series..."
        resultCount={resultCount}
      />

      {savedFilters.length ? (
        <section className="catalog-saved-strip" aria-label="Saved filters">
          {savedFilters.map((filter) => (
            <div key={filter.id} className="saved-filter-chip">
              <button type="button" className="saved-filter-apply" onClick={() => applySavedFilter(filter)}>
                {filter.name}
              </button>
              <button
                type="button"
                className="saved-filter-delete"
                onClick={() => deleteSavedFilter(filter.id)}
                aria-label={`Delete ${filter.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </section>
      ) : null}

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
