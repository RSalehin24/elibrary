import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import BookTable from "../components/BookTable";
import CatalogToolbar from "../components/CatalogToolbar";
import ExportActions from "../components/ExportActions";
import PageLoader from "../components/PageLoader";
import PropertyTableControls, { useClientPagination } from "../components/PropertyTableControls";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import { exportBooksToCsv, exportBooksToPdf } from "../utils/bookExport";
import { getExportBlockState } from "../utils/export";
import { clearPendingExport, readPendingExport, writePendingExport } from "../utils/exportSession";
import { cleanQueryParams, filtersFromSearchParams, toQueryString } from "../utils/query";

const EXPORT_STORAGE_KEY = "catalog-books-export";

const defaultFilters = {
  q: "",
  book_code: "",
  writer_code: "",
  contributor_code: "",
  contributor_role: "",
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
  { key: "contributor_code", label: "Contributor code" },
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

function waitForExportUi() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    });
  });
}

function waitForMinimumLoader(startedAt, minimumMs = 240) {
  const elapsed = Date.now() - startedAt;
  const remaining = minimumMs - elapsed;
  if (remaining <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => window.setTimeout(resolve, remaining));
}

export default function LibraryPage() {
  const { authenticated } = useSession();
  const toast = useToast();
  const pendingExportRef = useRef(readPendingExport(EXPORT_STORAGE_KEY));
  const resumedPendingExportRef = useRef(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [books, setBooks] = useState([]);
  const [filters, setFilters] = useState(() => filtersFromSearchParams(defaultFilters, searchParams));
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [savedFilters, setSavedFilters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloadState, setDownloadState] = useState(() => pendingExportRef.current?.mode || "");
  const pagination = useClientPagination(books);

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

  useEffect(() => {
    const pendingExport = pendingExportRef.current;
    if (!pendingExport || resumedPendingExportRef.current) {
      return;
    }

    resumedPendingExportRef.current = true;

    async function resumePendingExport() {
      try {
        setDownloadState(pendingExport.mode);
        const startedAt = Date.now();
        await waitForExportUi();

        if (pendingExport.mode === "csv") {
          exportBooksToCsv(pendingExport.items, pendingExport.filename || "catalog-books.csv");
          toast.success("CSV export started.");
        } else {
          await exportBooksToPdf(pendingExport.items, pendingExport.title || "Books Export");
          toast.success("PDF export downloaded.");
        }

        await waitForMinimumLoader(startedAt);
      } catch (nextError) {
        toast.error(nextError.message);
      } finally {
        clearPendingExport(EXPORT_STORAGE_KEY);
        pendingExportRef.current = null;
        setDownloadState("");
      }
    }

    resumePendingExport();
  }, [toast]);

  function applyFilters(event) {
    event.preventDefault();
    pagination.resetPage();
    setSearchParams(cleanQueryParams(filters));
  }

  function resetFilters() {
    pagination.resetPage();
    setFilters(defaultFilters);
    setSearchParams(cleanQueryParams(defaultFilters));
  }

  function applySavedFilter(savedFilter) {
    const nextFilters = { ...defaultFilters, ...(savedFilter.params || {}) };
    pagination.resetPage();
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
    const blocked = getExportBlockState({
      items: books,
      loading,
      error,
      nounSingular: "book",
      nounPlural: "books"
    });
    if (blocked) {
      toast[blocked.type](blocked.message);
      return;
    }

    try {
      const exportRequest = writePendingExport(EXPORT_STORAGE_KEY, {
        mode,
        items: books,
        title: "Books Export",
        filename: "catalog-books.csv"
      });
      pendingExportRef.current = exportRequest;
      setDownloadState(mode);
      const startedAt = Date.now();
      await waitForExportUi();

      if (mode === "csv") {
        exportBooksToCsv(exportRequest.items, exportRequest.filename);
        toast.success("CSV export started.");
      } else {
        await exportBooksToPdf(exportRequest.items, exportRequest.title);
        toast.success("PDF export downloaded.");
      }

      await waitForMinimumLoader(startedAt);
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      clearPendingExport(EXPORT_STORAGE_KEY);
      pendingExportRef.current = null;
      setDownloadState("");
    }
  }

  const resultCount = error || loading ? "" : `${books.length}`;
  const sortOptions = libraryFilterFields.find((field) => field.key === "sort")?.options || [];
  const exportActions = (
    <ExportActions loading={downloadState} onExport={runDownload} ariaLabel="Export books" bare />
  );
  const tableControls = (
    <PropertyTableControls
      sortValue={filters.sort}
      sortOptions={sortOptions}
      onSortChange={(nextSort) => {
        const nextFilters = { ...filters, sort: nextSort };
        pagination.resetPage();
        setFilters(nextFilters);
        setSearchParams(cleanQueryParams(nextFilters));
      }}
      rowsPerPage={pagination.rowsPerPage}
      onRowsPerPageChange={pagination.setRowsPerPage}
      page={pagination.page}
      pageCount={pagination.pageCount}
      hasPrevious={pagination.hasPrevious}
      hasNext={pagination.hasNext}
      onPageChange={pagination.setPage}
      disabled={loading}
    />
  );

  return (
    <div className="catalog-page page-stack">
      <header className="catalog-page-header catalog-page-header--with-toolbar catalog-page-header--stacked">
        <h1>Books</h1>

        <CatalogToolbar
          filters={filters}
          setFilters={setFilters}
          fields={libraryFilterFields}
          defaultFilters={defaultFilters}
          filtersExpanded={filtersExpanded}
          setFiltersExpanded={setFiltersExpanded}
          onSubmit={applyFilters}
          onReset={resetFilters}
          searchPlaceholder="Search books, book IDs, writers, categories..."
          resultCount={resultCount}
          searchActionsExtra={exportActions}
          secondaryContent={tableControls}
          secondaryBelow
          searchRowCompact
          inline
          bare
        />
      </header>

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
        <PageLoader label="Loading books" detail="Fetching the current catalog view and book statuses." />
      ) : error ? (
        <div className="page-state page-state-error">{error}</div>
      ) : (
        <BookTable books={pagination.items} emptyLabel="No books found." />
      )}
    </div>
  );
}
