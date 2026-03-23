import { useEffect, useState } from "react";
import { apiFetch, downloadApiFile } from "../api/client";
import BookTable from "../components/BookTable";
import CatalogToolbar from "../components/CatalogToolbar";
import TagInput from "../components/TagInput";
import { useToast } from "../hooks/useToast";
import { toQueryString } from "../utils/query";

const emptyForm = {
  title: "",
  summary: "",
  writers: [],
  translators: [],
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

function manualListQueryFilters(filters) {
  return { ...(filters || {}), record_type: "manual" };
}

export default function ManualBooksPage() {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState("input");
  const [form, setForm] = useState(emptyForm);
  const [filters, setFilters] = useState(defaultListFilters);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [manualBooks, setManualBooks] = useState([]);
  const [writerOptions, setWriterOptions] = useState([]);
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [downloadState, setDownloadState] = useState("");
  const [error, setError] = useState("");

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
      const [categoryPayload, writerPayload] = await Promise.all([
        apiFetch("/catalog/categories/?record_type=all&sort=name"),
        apiFetch("/catalog/writers/?record_type=all&sort=name")
      ]);
      setCategoryOptions(categoryPayload.map((entry) => entry.name));
      setWriterOptions(writerPayload.map((entry) => entry.name));
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
      toast.success(`Created ${payload.catalog_code}.`);
      setForm(emptyForm);
      setActiveTab("list");
      await Promise.all([loadManualBooks(filters), loadOptions()]);
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setSubmitting(false);
    }
  }

  function applyListFilters(event) {
    event.preventDefault();
    loadManualBooks(filters);
  }

  function resetListFilters() {
    setFilters(defaultListFilters);
    loadManualBooks(defaultListFilters);
  }

  async function runDownload(mode) {
    const endpoint =
      mode === "tickets"
        ? `/catalog/books/tickets/${toQueryString(manualListQueryFilters(filters))}`
        : `/catalog/books/export/${toQueryString({ ...manualListQueryFilters(filters), format: mode })}`;
    try {
      setDownloadState(mode);
      await downloadApiFile(endpoint);
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setDownloadState("");
    }
  }

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
        <h1>Manual Books Page</h1>
      </header>

      <div className="manual-books-tabs" role="tablist" aria-label="Manual books">
        <button
          type="button"
          className={activeTab === "input" ? "manual-books-tab is-active" : "manual-books-tab"}
          onClick={() => setActiveTab("input")}
        >
          Input
        </button>
        <button
          type="button"
          className={activeTab === "list" ? "manual-books-tab is-active" : "manual-books-tab"}
          onClick={() => setActiveTab("list")}
        >
          List
        </button>
      </div>

      {activeTab === "input" ? (
        <section className="detail-card manual-books-panel">
          <form className="stack-form manual-book-form" onSubmit={handleCreate}>
            <label>
              <span className="fact-label">Title</span>
              <input
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
                suggestions={writerOptions}
                placeholder={loadingOptions ? "Loading..." : "Select or create"}
              />
              <TagInput
                label="Translator"
                values={form.translators}
                onChange={(translators) => setForm({ ...form, translators })}
                suggestions={writerOptions}
                placeholder={loadingOptions ? "Loading..." : "Optional"}
              />
              <TagInput
                label="Compiler/Editor"
                values={form.editors}
                onChange={(editors) => setForm({ ...form, editors })}
                suggestions={writerOptions}
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

            <div className="inline-pills">
              <button type="submit" className="primary-button" disabled={submitting}>
                {submitting ? "Saving..." : "Create"}
              </button>
              <button type="button" className="ghost-button" onClick={() => setForm(emptyForm)} disabled={submitting}>
                Reset
              </button>
            </div>
          </form>
        </section>
      ) : (
        <>
          <CatalogToolbar
            filters={filters}
            setFilters={setFilters}
            fields={listFilterFields}
            defaultFilters={defaultListFilters}
            filtersExpanded={filtersExpanded}
            setFiltersExpanded={setFiltersExpanded}
            onSubmit={applyListFilters}
            onReset={resetListFilters}
            searchPlaceholder="Search manual books, codes, writers..."
            resultCount={error || loadingList ? "" : `${manualBooks.length}`}
            secondaryContent={exportActions}
          />

          {loadingList ? (
            <div className="page-state">Loading manual books...</div>
          ) : error ? (
            <div className="page-state page-state-error">{error}</div>
          ) : (
            <BookTable books={manualBooks} emptyLabel="No manual books found." linkFilters={{ record_type: "manual" }} />
          )}
        </>
      )}
    </div>
  );
}
