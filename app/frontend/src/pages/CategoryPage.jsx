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
      { value: "catalog_code", label: "Code ascending" },
      { value: "-catalog_code", label: "Code descending" },
      { value: "name", label: "Name A-Z" },
      { value: "-name", label: "Name Z-A" },
      { value: "-created_at", label: "Newest first" },
      { value: "created_at", label: "Oldest first" },
    ],
  },
];

export default function CategoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() =>
    filtersFromSearchParams(defaultFilters, searchParams),
  );
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pagination = useClientPagination(categories);

  useEffect(() => {
    const nextFilters = filtersFromSearchParams(defaultFilters, searchParams);
    setFilters(nextFilters);

    async function loadCategories() {
      try {
        setLoading(true);
        const payload = await apiFetch(
          `/catalog/categories/${toQueryString(nextFilters)}`,
        );
        setCategories(payload);
        setError("");
      } catch (nextError) {
        setError(nextError.message);
      } finally {
        setLoading(false);
      }
    }

    loadCategories();
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

  function buildBooksLink(catalogCode) {
    const params = { category_code: catalogCode };
    if (filters.record_type && filters.record_type !== "digital") {
      params.record_type = filters.record_type;
    }
    return `/library${toQueryString(params)}`;
  }

  const resultCount = error || loading ? "" : `${categories.length}`;
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
        <h1>Categories</h1>

        <CatalogToolbar
          filters={filters}
          setFilters={setFilters}
          fields={filterFields}
          defaultFilters={defaultFilters}
          filtersExpanded={filtersExpanded}
          setFiltersExpanded={setFiltersExpanded}
          onSubmit={applyFilters}
          onReset={resetFilters}
          searchPlaceholder="Search categories or codes..."
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
          label="Loading categories"
          detail="Fetching category counts and related book totals."
        />
      ) : error ? (
        <div className="page-state page-state-error">{error}</div>
      ) : categories.length ? (
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
              {pagination.items.map((category) => (
                <tr key={category.id}>
                  <td className="table-code-cell">{category.catalog_code}</td>
                  <td>
                    <Link
                      to={buildBooksLink(category.catalog_code)}
                      className="table-title-link"
                    >
                      {category.name}
                    </Link>
                  </td>
                  <td>{category.book_count}</td>
                  <td>{category.digital_book_count}</td>
                  <td>{category.manual_book_count}</td>
                  <td>{formatBookDate(category.created_at)}</td>
                  <td className="table-action-cell">
                    <Link
                      to={buildBooksLink(category.catalog_code)}
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
        <div className="page-state">No categories found.</div>
      )}
    </div>
  );
}
