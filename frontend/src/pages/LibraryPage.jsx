import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, downloadApiFile } from "../api/client";
import BookTable from "../components/BookTable";
import CatalogToolbar from "../components/CatalogToolbar";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import { cleanQueryParams, filtersFromSearchParams, toQueryString } from "../utils/query";

const defaultFilters = {
  q: "",
  book_code: "",
  writer_code: "",
  category_code: "",
  author: "",
  contributor: "",
  series: "",
  category: "",
  ownership: "",
  record_type: "digital",
  state: "",
  review_state: "",
  submission_status: "",
  processing_status: "",
  created_after: "",
  created_before: "",
  sort: "-created_at"
};

const libraryFilterFields = [
  { key: "book_code", label: "Book code" },
  { key: "writer_code", label: "Writer code" },
  { key: "category_code", label: "Category code" },
  { key: "author", label: "Writer" },
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
    key: "record_type",
    label: "Type",
    type: "select",
    options: [
      { value: "digital", label: "Digital" },
      { value: "manual", label: "Manual" },
      { value: "all", label: "All types" }
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
  {
    key: "submission_status",
    label: "Submission",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "draft", label: "Draft" },
      { value: "pending_resolution", label: "Pending resolution" },
      { value: "queued", label: "Queued" },
      { value: "processing", label: "Processing" },
      { value: "needs_review", label: "Needs review" },
      { value: "ready", label: "Ready" },
      { value: "failed", label: "Failed" },
      { value: "cancelled", label: "Cancelled" },
      { value: "duplicate", label: "Duplicate" }
    ]
  },
  {
    key: "processing_status",
    label: "Job",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "queued", label: "Queued" },
      { value: "processing", label: "Processing" },
      { value: "succeeded", label: "Succeeded" },
      { value: "failed", label: "Failed" },
      { value: "cancelled", label: "Cancelled" }
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
      { value: "catalog_code", label: "Code ascending" },
      { value: "-catalog_code", label: "Code descending" },
      { value: "title", label: "Title A-Z" },
      { value: "-title", label: "Title Z-A" }
    ]
  }
];

export default function LibraryPage() {
  const { authenticated } = useSession();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [books, setBooks] = useState([]);
  const [filters, setFilters] = useState(() => filtersFromSearchParams(defaultFilters, searchParams));
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [savedFilters, setSavedFilters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloadState, setDownloadState] = useState("");

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
    const nextFilters = filtersFromSearchParams(defaultFilters, searchParams);
    setFilters(nextFilters);
    loadBooks(nextFilters);
  }, [searchParams.toString()]);

  useEffect(() => {
    loadSavedFilters();
  }, [authenticated]);

  function applyFilters(event) {
    event.preventDefault();
    setSearchParams(cleanQueryParams(filters));
  }

  function resetFilters() {
    setFilters(defaultFilters);
    setSearchParams(cleanQueryParams(defaultFilters));
  }

  function applySavedFilter(savedFilter) {
    const nextFilters = { ...defaultFilters, ...(savedFilter.params || {}) };
    setFilters(nextFilters);
    setSearchParams(cleanQueryParams(nextFilters));
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

  async function runDownload(mode) {
    const endpoint =
      mode === "tickets"
        ? `/catalog/books/tickets/${toQueryString(filters)}`
        : `/catalog/books/export/${toQueryString({ ...filters, format: mode })}`;
    try {
      setDownloadState(mode);
      await downloadApiFile(endpoint);
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setDownloadState("");
    }
  }

  const resultCount = error || loading ? "" : `${books.length}`;
  const exportActions = (
    <div className="catalog-export-panel">
      <span className="fact-label">Export</span>
      <div className="catalog-export-actions">
        <button type="button" className="ghost-button" onClick={() => runDownload("csv")} disabled={downloadState !== ""}>
          {downloadState === "csv" ? "Downloading..." : "CSV"}
        </button>
        <button type="button" className="ghost-button" onClick={() => runDownload("pdf")} disabled={downloadState !== ""}>
          {downloadState === "pdf" ? "Downloading..." : "PDF"}
        </button>
        <button type="button" className="primary-button" onClick={() => runDownload("tickets")} disabled={downloadState !== ""}>
          {downloadState === "tickets" ? "Downloading..." : "Tickets"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="catalog-page page-stack">
      <header className="catalog-page-header">
        <h1>Book Page</h1>
      </header>

      <CatalogToolbar
        filters={filters}
        setFilters={setFilters}
        fields={libraryFilterFields}
        defaultFilters={defaultFilters}
        filtersExpanded={filtersExpanded}
        setFiltersExpanded={setFiltersExpanded}
        onSubmit={applyFilters}
        onReset={resetFilters}
        searchPlaceholder="Search books, codes, writers, categories..."
        resultCount={resultCount}
        secondaryContent={exportActions}
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
        <div className="page-state">Loading books...</div>
      ) : error ? (
        <div className="page-state page-state-error">{error}</div>
      ) : (
        <BookTable books={books} emptyLabel="No books found." />
      )}
    </div>
  );
}
