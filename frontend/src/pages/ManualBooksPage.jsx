import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import BookTable from "../components/BookTable";
import CatalogToolbar from "../components/CatalogToolbar";
import ExportActions from "../components/ExportActions";
import PageLoader from "../components/PageLoader";
import PropertyTableControls, { useClientPagination } from "../components/PropertyTableControls";
import TagInput from "../components/TagInput";
import { useToast } from "../hooks/useToast";
import { exportBooksToCsv, exportBooksToPdf } from "../utils/bookExport";
import { getExportBlockState } from "../utils/export";
import { clearPendingExport, readPendingExport, writePendingExport } from "../utils/exportSession";
import { toQueryString } from "../utils/query";

const EXPORT_STORAGE_KEY = "manual-books-export";

const emptyForm = {
  title: "",
  summary: "",
  writers: [],
  translators: [],
  compilers: [],
  editors: [],
  categories: [],
  series: [],
  is_compilation: false,
  binding: "",
  publisher: "",
  price: ""
};

const defaultListFilters = {
  q: "",
  book_code: "",
  writer_code: "",
  category_code: "",
  author: "",
  series: "",
  category: "",
  created_after: "",
  created_before: "",
  sort: "-created_at"
};

const listFilterFields = [
  { key: "book_code", label: "Book code" },
  { key: "writer_code", label: "Writer code" },
  { key: "category_code", label: "Category code" },
  { key: "author", label: "Writer" },
  { key: "series", label: "Series" },
  { key: "category", label: "Category" },
  { key: "created_after", label: "Created after", type: "date" },
  { key: "created_before", label: "Created before", type: "date" },
  {
    key: "sort",
    label: "Sort",
    type: "select",
    options: [
      { value: "-created_at", label: "Newest first" },
      { value: "created_at", label: "Oldest first" },
      { value: "catalog_code", label: "Code ascending" },
      { value: "-catalog_code", label: "Code descending" },
      { value: "title", label: "Title A-Z" },
      { value: "-title", label: "Title Z-A" }
    ]
  }
];

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 5.25v13.5M5.25 12h13.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

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

function mergeContributorSuggestions(payloads) {
  const seen = new Set();
  const names = [];

  payloads.flat().forEach((entry) => {
    const name = (entry?.name || "").trim();
    const normalizedName = name.toLowerCase();
    if (!normalizedName || seen.has(normalizedName)) {
      return;
    }
    seen.add(normalizedName);
    names.push(name);
  });

  return names.sort((left, right) => left.localeCompare(right));
}

export default function ManualBooksPage() {
  const toast = useToast();
  const titleInputRef = useRef(null);
  const pendingExportRef = useRef(readPendingExport(EXPORT_STORAGE_KEY));
  const resumedPendingExportRef = useRef(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [filters, setFilters] = useState(defaultListFilters);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [manualBooks, setManualBooks] = useState([]);
  const [contributorOptions, setContributorOptions] = useState([]);
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [downloadState, setDownloadState] = useState(() => pendingExportRef.current?.mode || "");
  const [highlightedBookId, setHighlightedBookId] = useState("");
  const [error, setError] = useState("");
  const pagination = useClientPagination(manualBooks);

  async function loadManualBooks(nextFilters = filters) {
    try {
      setLoadingList(true);
      const payload = await apiFetch(`/catalog/manual-books/${toQueryString(nextFilters)}`);
      setManualBooks(payload);
      setError("");
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setLoadingList(false);
    }
  }

  async function loadOptions() {
    try {
      setLoadingOptions(true);
      const [categoryPayload, writerPayload, translatorPayload, compilerPayload, editorPayload] = await Promise.all([
        apiFetch("/catalog/categories/?record_type=all&sort=name"),
        apiFetch("/catalog/writers/?record_type=all&sort=name"),
        apiFetch("/catalog/translators/?record_type=all&sort=name"),
        apiFetch("/catalog/compilers/?record_type=all&sort=name"),
        apiFetch("/catalog/editors/?record_type=all&sort=name")
      ]);
      setCategoryOptions(categoryPayload.map((entry) => entry.name));
      setContributorOptions(
        mergeContributorSuggestions([writerPayload, translatorPayload, compilerPayload, editorPayload])
      );
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setLoadingOptions(false);
    }
  }

  useEffect(() => {
    loadManualBooks(defaultListFilters);
    loadOptions();
  }, []);

  useEffect(() => {
    if (!composerOpen) {
      return;
    }
    titleInputRef.current?.focus();
  }, [composerOpen]);

  useEffect(() => {
    if (!highlightedBookId) {
      return undefined;
    }

    const timer = window.setTimeout(() => setHighlightedBookId(""), 2600);
    return () => window.clearTimeout(timer);
  }, [highlightedBookId]);

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
          exportBooksToCsv(pendingExport.items, pendingExport.filename || "manual-books.csv");
          toast.success("CSV export started.");
        } else {
          await exportBooksToPdf(pendingExport.items, pendingExport.title || "Physical Books' List Export");
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

  async function handleCreate(event) {
    event.preventDefault();
    try {
      setSubmitting(true);
      const payload = await apiFetch("/catalog/manual-books/", {
        method: "POST",
        body: {
          ...form,
          price: form.price === "" ? null : form.price
        }
      });
      setManualBooks((current) => [payload, ...current.filter((book) => book.id !== payload.id)]);
      setHighlightedBookId(payload.id);
      setForm(emptyForm);
      setComposerOpen(true);
      titleInputRef.current?.focus();
      toast.success(`Added ${payload.catalog_code}. Ready for the next manual book.`);
      loadOptions();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setSubmitting(false);
    }
  }

  function applyListFilters(event) {
    event.preventDefault();
    pagination.resetPage();
    loadManualBooks(filters);
  }

  function resetListFilters() {
    pagination.resetPage();
    setFilters(defaultListFilters);
    loadManualBooks(defaultListFilters);
  }

  async function runDownload(mode) {
    const blocked = getExportBlockState({
      items: manualBooks,
      loading: loadingList,
      error,
      nounSingular: "manual book",
      nounPlural: "manual books"
    });
    if (blocked) {
      toast[blocked.type](blocked.message);
      return;
    }

    try {
      const exportRequest = writePendingExport(EXPORT_STORAGE_KEY, {
        mode,
        items: manualBooks,
        title: "Physical Books' List Export",
        filename: "manual-books.csv"
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

  const resultCount = error || loadingList ? "" : `${manualBooks.length}`;
  const sortOptions = listFilterFields.find((field) => field.key === "sort")?.options || [];
  const headerActions = (
    <div className="manual-books-toolbar-actions">
      <ExportActions loading={downloadState} onExport={runDownload} ariaLabel="Export manual books" bare />
      <div className="toolbar-action-panel toolbar-action-panel-compact is-bare">
        <button
          type="button"
          className={`toolbar-icon-button toolbar-icon-button-accent is-icon-only${composerOpen ? " is-active" : ""}`}
          onClick={() => setComposerOpen((current) => !current)}
          aria-expanded={composerOpen}
          aria-controls="manual-book-composer"
          title={composerOpen ? "Close add book form" : "Add manual book"}
          aria-label={composerOpen ? "Close add book form" : "Add manual book"}
        >
          <span className="toolbar-icon-button-art">
            <PlusIcon />
          </span>
        </button>
      </div>
    </div>
  );
  const tableControls = (
    <PropertyTableControls
      sortValue={filters.sort}
      sortOptions={sortOptions}
      onSortChange={(nextSort) => {
        const nextFilters = { ...filters, sort: nextSort };
        pagination.resetPage();
        setFilters(nextFilters);
        loadManualBooks(nextFilters);
      }}
      rowsPerPage={pagination.rowsPerPage}
      onRowsPerPageChange={pagination.setRowsPerPage}
      page={pagination.page}
      pageCount={pagination.pageCount}
      hasPrevious={pagination.hasPrevious}
      hasNext={pagination.hasNext}
      onPageChange={pagination.setPage}
      disabled={loadingList}
    />
  );

  return (
    <div className="catalog-page page-stack">
      <header className="catalog-page-header catalog-page-header--with-toolbar catalog-page-header--stacked">
        <h1>Physical Books' List</h1>

        <CatalogToolbar
          filters={filters}
          setFilters={setFilters}
          fields={listFilterFields}
          defaultFilters={defaultListFilters}
          filtersExpanded={filtersExpanded}
          setFiltersExpanded={setFiltersExpanded}
          onSubmit={applyListFilters}
          onReset={resetListFilters}
          searchPlaceholder="Search manual books, book IDs, writers..."
          resultCount={resultCount}
          searchActionsExtra={headerActions}
          secondaryContent={tableControls}
          secondaryBelow
          searchRowCompact
          inline
          bare
        />
      </header>

      {composerOpen ? (
        <section id="manual-book-composer" className="detail-card manual-books-panel manual-book-composer">
          <form className="stack-form manual-book-form" onSubmit={handleCreate}>
            <label>
              <span className="fact-label">Title</span>
              <input
                ref={titleInputRef}
                type="text"
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                placeholder="Book title"
                autoComplete="off"
              />
            </label>

            <div className="manual-book-form-grid">
              <TagInput
                label="Writer"
                values={form.writers}
                onChange={(writers) => setForm({ ...form, writers })}
                suggestions={contributorOptions}
                placeholder={loadingOptions ? "Loading..." : "Select or create"}
              />
              <TagInput
                label="Translator"
                values={form.translators}
                onChange={(translators) => setForm({ ...form, translators })}
                suggestions={contributorOptions}
                placeholder={loadingOptions ? "Loading..." : "Optional"}
              />
              <TagInput
                label="Compiler"
                values={form.compilers}
                onChange={(compilers) => setForm({ ...form, compilers })}
                suggestions={contributorOptions}
                placeholder={loadingOptions ? "Loading..." : "Optional"}
              />
              <TagInput
                label="Editor"
                values={form.editors}
                onChange={(editors) => setForm({ ...form, editors })}
                suggestions={contributorOptions}
                placeholder={loadingOptions ? "Loading..." : "Optional"}
              />
              <TagInput
                label="Category"
                values={form.categories}
                onChange={(categories) => setForm({ ...form, categories })}
                suggestions={categoryOptions}
                placeholder={loadingOptions ? "Loading..." : "Select or create"}
              />
            </div>

            <div className="manual-book-form-grid">
              <TagInput
                label="Series"
                values={form.series}
                onChange={(series) => setForm({ ...form, series })}
                placeholder="Optional"
              />
              <label>
                <span className="fact-label">Compilation</span>
                <select
                  value={form.is_compilation ? "yes" : "no"}
                  onChange={(event) => setForm({ ...form, is_compilation: event.target.value === "yes" })}
                >
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </label>
              <label>
                <span className="fact-label">Binding</span>
                <select value={form.binding} onChange={(event) => setForm({ ...form, binding: event.target.value })}>
                  <option value="">Select</option>
                  <option value="hard_cover">Hard Cover</option>
                  <option value="paper_back">Paper Back</option>
                </select>
              </label>
              <label>
                <span className="fact-label">Publisher</span>
                <input
                  type="text"
                  value={form.publisher}
                  onChange={(event) => setForm({ ...form, publisher: event.target.value })}
                  placeholder="Optional"
                  autoComplete="off"
                />
              </label>
            </div>

            <div className="manual-book-form-grid">
              <label>
                <span className="fact-label">Price</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.price}
                  onChange={(event) => setForm({ ...form, price: event.target.value })}
                  placeholder="Optional"
                />
              </label>
              <label className="manual-book-form-span-3">
                <span className="fact-label">Summary</span>
                <textarea
                  value={form.summary}
                  onChange={(event) => setForm({ ...form, summary: event.target.value })}
                  placeholder="Optional"
                />
              </label>
            </div>

            <div className="inline-pills manual-book-form-actions">
              <button type="submit" className="primary-button" disabled={submitting}>
                {submitting ? "Adding..." : "Add & next"}
              </button>
              <button type="button" className="ghost-button" onClick={() => setForm(emptyForm)} disabled={submitting}>
                Clear fields
              </button>
              <button type="button" className="ghost-button" onClick={() => setComposerOpen(false)} disabled={submitting}>
                Done
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {loadingList ? (
        <PageLoader label="Loading manual books" detail="Fetching the physical-book catalog and recent additions." />
      ) : error ? (
        <div className="page-state page-state-error">{error}</div>
      ) : (
        <BookTable
          books={pagination.items}
          emptyLabel="No manual books found."
          linkFilters={{ record_type: "manual" }}
          highlightedBookId={highlightedBookId}
        />
      )}
    </div>
  );
}
