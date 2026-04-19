import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import BookTable from "../components/BookTable";
import CatalogToolbar from "../components/CatalogToolbar";
import ExportActions from "../components/ExportActions";
import LoadingSpinner from "../components/LoadingSpinner";
import { useInfiniteCatalogBooks } from "../hooks/useInfiniteCatalogBooks";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import { exportBooksToCsv, exportBooksToPdf } from "../utils/bookExport";
import {
  normalizeBookPayload,
} from "../utils/catalogBooks";
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

const libraryToolbarFields = libraryFilterFields.filter(
  (field) => field.key !== "sort",
);
const librarySortOptions =
  libraryFilterFields.find((field) => field.key === "sort")?.options || [];

export default function LibraryPage() {
  const { authenticated } = useSession();
  const toast = useToast();
  const pendingExportRef = useRef(readPendingExport(EXPORT_STORAGE_KEY));
  const resumedPendingExportRef = useRef(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const appliedFilters = useMemo(
    () => filtersFromSearchParams(defaultFilters, searchParams),
    [searchParams],
  );
  const [filters, setFilters] = useState(appliedFilters);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [savedFilters, setSavedFilters] = useState([]);
  const [savedFilterAction, setSavedFilterAction] = useState("");
  const [downloadState, setDownloadState] = useState(
    () => pendingExportRef.current?.mode || "",
  );
  const {
    books,
    totalCount,
    hasMore,
    initialLoading,
    loadingMore,
    refreshing,
    error,
    tableShellRef,
    observeLoadTrigger,
  } = useInfiniteCatalogBooks({
    filters: appliedFilters,
  });

  async function loadAllBooksForExport(nextFilters = appliedFilters) {
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
    setFilters(appliedFilters);
  }, [appliedFilters]);

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
    setSearchParams(cleanQueryParams(filters));
  }

  function resetFilters() {
    setFilters(defaultFilters);
    setSearchParams(cleanQueryParams(defaultFilters));
  }

  function clearSearch(nextFilters) {
    setFilters(nextFilters);
    setSearchParams(cleanQueryParams(nextFilters));
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
      const exportItems = await loadAllBooksForExport(appliedFilters);
      const blocked = getExportBlockState({
        items: exportItems,
        loading: initialLoading || refreshing,
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

  const resultCount = error && !books.length ? "" : `${totalCount}`;
  const exportActions = (
    <ExportActions
      loading={downloadState}
      onExport={runDownload}
      ariaLabel="Export books"
      bare
    />
  );
  const showErrorState = Boolean(error && !books.length && !initialLoading);

  return (
    <div className="catalog-page page-stack">
      <header className="catalog-page-header catalog-page-header--with-toolbar catalog-page-header--property-layout">
        <h1>Books</h1>

        <CatalogToolbar
          filters={filters}
          setFilters={setFilters}
          fields={libraryToolbarFields}
          defaultFilters={defaultFilters}
          filtersExpanded={filtersExpanded}
          setFiltersExpanded={setFiltersExpanded}
          onSubmit={applyFilters}
          onReset={resetFilters}
          searchPlaceholder="Search books, book IDs, writers, categories..."
          resultCount={resultCount}
          resultCountLoading={initialLoading || refreshing}
          searchActionsExtra={exportActions}
          sortValue={filters.sort}
          sortOptions={librarySortOptions}
          onSortChange={(nextSort) => {
            const nextFilters = {
              ...filters,
              sort: nextSort,
            };
            setFilters(nextFilters);
            setSearchParams(cleanQueryParams(nextFilters));
          }}
          sortAriaLabel="Sort books"
          searchRowCompact
          searchRowClassName="catalog-search-row--property-compact"
          onSearchClear={clearSearch}
          inline
          bare
          buttonsLoading={initialLoading || refreshing}
          buttonsDisabled={initialLoading || loadingMore || refreshing}
        />
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

      {showErrorState ? (
        <div className="page-state page-state-error">{error}</div>
      ) : (
        <BookTable
          books={books}
          emptyLabel="No books found."
          shellClassName="catalog-table-shell--incremental"
          shellRef={tableShellRef}
          hasMore={hasMore}
          observeLoadTrigger={observeLoadTrigger}
          initialLoading={initialLoading}
          loadingMore={loadingMore}
          refreshing={refreshing}
        />
      )}
    </div>
  );
}
