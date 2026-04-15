import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import BookTable from "../components/BookTable";
import CatalogToolbar from "../components/CatalogToolbar";
import ExportActions from "../components/ExportActions";
import LoadingSpinner from "../components/LoadingSpinner";
import PageLoader from "../components/PageLoader";
import PropertyTableControls from "../components/PropertyTableControls";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import { exportBooksToCsv, exportBooksToPdf } from "../utils/bookExport";
import { getExportBlockState } from "../utils/export";
import {
  clearPendingExport,
  readPendingExport,
  writePendingExport,
} from "../utils/exportSession";
import {
  cleanQueryParams,
  filtersFromSearchParams,
  toQueryString,
} from "../utils/query";

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
  sort: "-created_at",
  page: "1",
  limit: "10",
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
      { value: "mine", label: "My books" },
    ],
  },
  {
    key: "record_type",
    label: "Type",
    type: "select",
    options: [
      { value: "digital", label: "Digital" },
      { value: "manual", label: "Manual" },
      { value: "all", label: "All types" },
    ],
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
      { value: "duplicate", label: "Duplicate" },
    ],
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
      { value: "cancelled", label: "Cancelled" },
    ],
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
      { value: "-title", label: "Title Z-A" },
    ],
  },
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

export default function LibraryPage() {
  const { authenticated } = useSession();
  const toast = useToast();
  const pendingExportRef = useRef(readPendingExport(EXPORT_STORAGE_KEY));
  const resumedPendingExportRef = useRef(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [books, setBooks] = useState([]);
  const [filters, setFilters] = useState(() =>
    filtersFromSearchParams(defaultFilters, searchParams),
  );
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [savedFilters, setSavedFilters] = useState([]);
  const [pagination, setPagination] = useState(defaultPagination);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savedFilterAction, setSavedFilterAction] = useState("");
  const [downloadState, setDownloadState] = useState(
    () => pendingExportRef.current?.mode || "",
  );

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

  async function loadAllBooksForExport(nextFilters = filters) {
    const pageSize = 100;
    const normalizedFilters = {
      ...nextFilters,
      page: "1",
      limit: String(pageSize),
    };
    const firstPayload = normalizeBookPayload(
      await apiFetch(`/catalog/books/${toQueryString(normalizedFilters)}`),
    );
    const allEntries = [...firstPayload.entries];
    const totalPages = Number(firstPayload.pagination.page_count) || 1;

    for (let page = 2; page <= totalPages; page += 1) {
      const nextPayload = normalizeBookPayload(
        await apiFetch(
          `/catalog/books/${toQueryString({
            ...normalizedFilters,
            page: String(page),
          })}`,
        ),
      );
      allEntries.push(...nextPayload.entries);
    }

    return allEntries;
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
          exportBooksToCsv(
            pendingExport.items,
            pendingExport.filename || "catalog-books.csv",
          );
          toast.success("CSV export started.");
        } else {
          await exportBooksToPdf(
            pendingExport.items,
            pendingExport.title || "Books Export",
          );
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

  function applySavedFilter(savedFilter) {
    if (savedFilterAction) {
      return;
    }
    setSavedFilterAction(`apply:${savedFilter.id}`);
    const nextFilters = { ...defaultFilters, ...(savedFilter.params || {}) };
    setFilters(nextFilters);
    setSearchParams(cleanQueryParams(nextFilters));
    toast.success(`Applied "${savedFilter.name}".`);
    window.setTimeout(() => setSavedFilterAction(""), 300);
  }

  async function deleteSavedFilter(id) {
    if (savedFilterAction) {
      return;
    }
    try {
      setSavedFilterAction(`delete:${id}`);
      await apiFetch(`/saved-filters/${id}/`, { method: "DELETE" });
      toast.success("Filter removed.");
      await loadSavedFilters();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setSavedFilterAction("");
    }
  }

  async function runDownload(mode) {
    try {
      const exportItems = await loadAllBooksForExport(filters);
      const blocked = getExportBlockState({
        items: exportItems,
        loading,
        error,
        nounSingular: "book",
        nounPlural: "books",
      });
      if (blocked) {
        toast[blocked.type](blocked.message);
        return;
      }

      const exportRequest = writePendingExport(EXPORT_STORAGE_KEY, {
        mode,
        items: exportItems,
        title: "Books Export",
        filename: "catalog-books.csv",
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

  const resultCount = error || loading ? "" : `${pagination.total_count}`;
  const sortOptions =
    libraryFilterFields.find((field) => field.key === "sort")?.options || [];
  const exportActions = (
    <ExportActions
      loading={downloadState}
      onExport={runDownload}
      ariaLabel="Export books"
      bare
    />
  );
  const tableControls = (
    <PropertyTableControls
      sortValue={filters.sort}
      sortOptions={sortOptions}
      onSortChange={(nextSort) => {
        const nextFilters = {
          ...filters,
          sort: nextSort,
          page: "1",
        };
        setFilters(nextFilters);
        setSearchParams(cleanQueryParams(nextFilters));
      }}
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
  );

  return (
    <div className="catalog-page page-stack">
      <header className="catalog-page-header catalog-page-header--with-toolbar catalog-page-header--property-layout">
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
          searchRowCompact
          searchRowClassName="catalog-search-row--property-compact"
          onSearchClear={clearSearch}
          inline
          bare
          buttonsLoading={loading}
        />

        <div className="catalog-page-controls-row">{tableControls}</div>
      </header>

      {savedFilters.length ? (
        <section className="catalog-saved-strip" aria-label="Saved filters">
          {savedFilters.map((filter) => (
            <div key={filter.id} className="saved-filter-chip">
              <button
                type="button"
                className="saved-filter-apply"
                onClick={() => applySavedFilter(filter)}
                disabled={Boolean(savedFilterAction)}
              >
                {savedFilterAction === `apply:${filter.id}` ? (
                  <span className="button-label">
                    <LoadingSpinner size={12} /> Applying...
                  </span>
                ) : (
                  filter.name
                )}
              </button>
              <button
                type="button"
                className="saved-filter-delete"
                onClick={() => deleteSavedFilter(filter.id)}
                aria-label={`Delete ${filter.name}`}
                disabled={Boolean(savedFilterAction)}
              >
                {savedFilterAction === `delete:${filter.id}` ? "…" : "×"}
              </button>
            </div>
          ))}
        </section>
      ) : null}

      {loading ? (
        <PageLoader
          label="Loading books"
          detail="Fetching the current catalog view and book statuses."
          variant="table"
        />
      ) : error ? (
        <div className="page-state page-state-error">{error}</div>
      ) : (
        <BookTable books={books} emptyLabel="No books found." />
      )}
    </div>
  );
}
