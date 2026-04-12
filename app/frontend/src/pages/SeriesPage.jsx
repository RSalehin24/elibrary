import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import CatalogToolbar from "../components/CatalogToolbar";
import PageLoader from "../components/PageLoader";
import PropertyTableControls, {
  useClientPagination,
} from "../components/PropertyTableControls";
import { formatBookDate } from "../utils/bookPresentation";
import {
  cleanQueryParams,
  filtersFromSearchParams,
  toQueryString,
} from "../utils/query";

const defaultFilters = {
  q: "",
  record_type: "digital",
  created_after: "",
  created_before: "",
  sort: "-book_count",
};

const filterFields = [
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
  { key: "created_after", label: "Created after", type: "date" },
  { key: "created_before", label: "Created before", type: "date" },
  {
    key: "sort",
    label: "Sort",
    type: "select",
    options: [
      { value: "-book_count", label: "Most books" },
      { value: "book_count", label: "Fewest books" },
      { value: "name", label: "Name A-Z" },
      { value: "-name", label: "Name Z-A" },
      { value: "-created_at", label: "Newest first" },
      { value: "created_at", label: "Oldest first" },
    ],
  },
];

export default function SeriesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() =>
    filtersFromSearchParams(defaultFilters, searchParams),
  );
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [seriesList, setSeriesList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pagination = useClientPagination(seriesList);

  useEffect(() => {
    const nextFilters = filtersFromSearchParams(defaultFilters, searchParams);
    setFilters(nextFilters);

    async function loadSeries() {
      try {
        setLoading(true);
        const payload = await apiFetch(
          `/catalog/series/${toQueryString(nextFilters)}`,
        );
        setSeriesList(payload);
        setError("");
      } catch (nextError) {
        setError(nextError.message);
      } finally {
        setLoading(false);
      }
    }

    loadSeries();
  }, [searchParams.toString()]);

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

  function clearSearch(nextFilters) {
    pagination.resetPage();
    setFilters(nextFilters);
    setSearchParams(cleanQueryParams(nextFilters));
  }

  function buildBooksLink(name) {
    const params = { series: name };
    if (filters.record_type && filters.record_type !== "digital") {
      params.record_type = filters.record_type;
    }
    return `/library${toQueryString(params)}`;
  }

  const resultCount = error || loading ? "" : `${seriesList.length}`;
  const sortOptions =
    filterFields.find((field) => field.key === "sort")?.options || [];
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
      <header className="catalog-page-header catalog-page-header--with-toolbar catalog-page-header--property-layout">
        <h1>Series</h1>

        <CatalogToolbar
          filters={filters}
          setFilters={setFilters}
          fields={filterFields}
          defaultFilters={defaultFilters}
          filtersExpanded={filtersExpanded}
          setFiltersExpanded={setFiltersExpanded}
          onSubmit={applyFilters}
          onReset={resetFilters}
          searchPlaceholder="Search series..."
          resultCount={resultCount}
          searchRowCompact
          searchRowClassName="catalog-search-row--property-compact"
          onSearchClear={clearSearch}
          inline
        />

        <div className="catalog-page-controls-row">{tableControls}</div>
      </header>

      {loading ? (
        <PageLoader
          label="Loading series"
          detail="Fetching series names and related book totals."
          variant="table"
        />
      ) : error ? (
        <div className="page-state page-state-error">{error}</div>
      ) : seriesList.length ? (
        <div className="catalog-table-shell">
          <table className="catalog-table property-table">
            <thead>
              <tr>
                <th>Series</th>
                <th>Books</th>
                <th>Digital</th>
                <th>Manual</th>
                <th>Created</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {pagination.items.map((series) => (
                <tr key={series.id}>
                  <td>
                    <Link
                      to={buildBooksLink(series.name)}
                      className="table-title-link"
                    >
                      {series.name}
                    </Link>
                  </td>
                  <td>{series.book_count}</td>
                  <td>{series.digital_book_count}</td>
                  <td>{series.manual_book_count}</td>
                  <td>{formatBookDate(series.created_at)}</td>
                  <td className="table-action-cell">
                    <Link
                      to={buildBooksLink(series.name)}
                      className="ghost-button table-row-action"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="page-state">No series found.</div>
      )}
    </div>
  );
}
