import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import CatalogToolbar from "../components/CatalogToolbar";
import { formatBookDate } from "../utils/bookPresentation";
import { cleanQueryParams, filtersFromSearchParams, toQueryString } from "../utils/query";

const defaultFilters = {
  q: "",
  record_type: "digital",
  created_after: "",
  created_before: "",
  sort: "-book_count"
};

const filterFields = [
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
  { key: "created_after", label: "Created after", type: "date" },
  { key: "created_before", label: "Created before", type: "date" },
  {
    key: "sort",
    label: "Sort",
    type: "select",
    options: [
      { value: "-book_count", label: "Most books" },
      { value: "book_count", label: "Fewest books" },
      { value: "catalog_code", label: "Code ascending" },
      { value: "-catalog_code", label: "Code descending" },
      { value: "name", label: "Name A-Z" },
      { value: "-name", label: "Name Z-A" },
      { value: "-created_at", label: "Newest first" },
      { value: "created_at", label: "Oldest first" }
    ]
  }
];

export default function WriterPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => filtersFromSearchParams(defaultFilters, searchParams));
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [writers, setWriters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const nextFilters = filtersFromSearchParams(defaultFilters, searchParams);
    setFilters(nextFilters);

    async function loadWriters() {
      try {
        setLoading(true);
        const payload = await apiFetch(`/catalog/writers/${toQueryString(nextFilters)}`);
        setWriters(payload);
        setError("");
      } catch (nextError) {
        setError(nextError.message);
      } finally {
        setLoading(false);
      }
    }

    loadWriters();
  }, [searchParams.toString()]);

  function applyFilters(event) {
    event.preventDefault();
    setSearchParams(cleanQueryParams(filters));
  }

  function resetFilters() {
    setFilters(defaultFilters);
    setSearchParams(cleanQueryParams(defaultFilters));
  }

  function buildBooksLink(catalogCode) {
    const params = { writer_code: catalogCode };
    if (filters.record_type && filters.record_type !== "digital") {
      params.record_type = filters.record_type;
    }
    return `/library${toQueryString(params)}`;
  }

  const resultCount = error || loading ? "" : `${writers.length}`;

  return (
    <div className="catalog-page page-stack">
      <header className="catalog-page-header">
        <h1>Writer Page</h1>
      </header>

      <CatalogToolbar
        filters={filters}
        setFilters={setFilters}
        fields={filterFields}
        defaultFilters={defaultFilters}
        filtersExpanded={filtersExpanded}
        setFiltersExpanded={setFiltersExpanded}
        onSubmit={applyFilters}
        onReset={resetFilters}
        searchPlaceholder="Search writers or codes..."
        resultCount={resultCount}
      />

      {loading ? (
        <div className="page-state">Loading writers...</div>
      ) : error ? (
        <div className="page-state page-state-error">{error}</div>
      ) : writers.length ? (
        <div className="catalog-table-shell">
          <table className="catalog-table property-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Books</th>
                <th>Digital</th>
                <th>Manual</th>
                <th>Created</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {writers.map((writer) => (
                <tr key={writer.id}>
                  <td className="table-code-cell">{writer.catalog_code}</td>
                  <td>
                    <Link to={buildBooksLink(writer.catalog_code)} className="table-title-link">
                      {writer.name}
                    </Link>
                  </td>
                  <td>{writer.book_count}</td>
                  <td>{writer.digital_book_count}</td>
                  <td>{writer.manual_book_count}</td>
                  <td>{formatBookDate(writer.created_at)}</td>
                  <td className="table-action-cell">
                    <Link to={buildBooksLink(writer.catalog_code)} className="ghost-button table-row-action">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="page-state">No writers found.</div>
      )}
    </div>
  );
}
