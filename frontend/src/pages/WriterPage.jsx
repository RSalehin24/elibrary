import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import CatalogToolbar from "../components/CatalogToolbar";
import PageLoader from "../components/PageLoader";
import PropertyTableControls, { useClientPagination } from "../components/PropertyTableControls";
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

const contributorTabs = [
  {
    id: "writers",
    label: "Writers",
    path: "/writers",
    endpoint: "/catalog/writers/",
    role: "author",
    emptyLabel: "No writers found."
  },
  {
    id: "translators",
    label: "Translators",
    path: "/translators",
    endpoint: "/catalog/translators/",
    role: "translator",
    emptyLabel: "No translators found."
  },
  {
    id: "compilers",
    label: "Compilers",
    path: "/compilers",
    endpoint: "/catalog/compilers/",
    role: "compiler",
    emptyLabel: "No compilers found."
  },
  {
    id: "editors",
    label: "Editors",
    path: "/editors",
    endpoint: "/catalog/editors/",
    role: "editor",
    emptyLabel: "No editors found."
  }
];

function activeTabForPath(pathname) {
  return contributorTabs.find((tab) => tab.path === pathname) || contributorTabs[0];
}

export default function WriterPage() {
  const location = useLocation();
  const activeTab = useMemo(() => activeTabForPath(location.pathname), [location.pathname]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => filtersFromSearchParams(defaultFilters, searchParams));
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [contributors, setContributors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pagination = useClientPagination(contributors);

  useEffect(() => {
    const nextFilters = filtersFromSearchParams(defaultFilters, searchParams);
    setFilters(nextFilters);

    async function loadContributors() {
      try {
        setLoading(true);
        const payload = await apiFetch(`${activeTab.endpoint}${toQueryString(nextFilters)}`);
        setContributors(payload);
        setError("");
      } catch (nextError) {
        setError(nextError.message);
      } finally {
        setLoading(false);
      }
    }

    loadContributors();
  }, [activeTab.endpoint, searchParams.toString()]);

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

  function buildBooksLink(catalogCode) {
    const params =
      activeTab.role === "author"
        ? { writer_code: catalogCode }
        : { contributor_code: catalogCode, contributor_role: activeTab.role };
    if (filters.record_type && filters.record_type !== "digital") {
      params.record_type = filters.record_type;
    }
    return `/library${toQueryString(params)}`;
  }

  const resultCount = error || loading ? "" : `${contributors.length}`;
  const contributorLabel = activeTab.label.toLowerCase();
  const sortOptions = filterFields.find((field) => field.key === "sort")?.options || [];
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
      <header className="contributor-page-header">
        <nav className="contributor-tabs" aria-label="Contributor sections">
          {contributorTabs.map((tab) => (
            <NavLink
              key={tab.id}
              to={tab.path}
              className={({ isActive }) => (isActive ? "contributor-tab is-active" : "contributor-tab")}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

        <div className="catalog-page-header catalog-page-header--with-toolbar catalog-page-header--stacked contributor-toolbar-row">
          <h1>{activeTab.label}</h1>

          <CatalogToolbar
            filters={filters}
            setFilters={setFilters}
            fields={filterFields}
            defaultFilters={defaultFilters}
            filtersExpanded={filtersExpanded}
            setFiltersExpanded={setFiltersExpanded}
            onSubmit={applyFilters}
            onReset={resetFilters}
            searchPlaceholder={`Search ${contributorLabel} or codes...`}
            resultCount={resultCount}
            secondaryContent={tableControls}
            secondaryBelow
            searchRowCompact
            inline
            bare
          />
        </div>
      </header>

      {loading ? (
        <PageLoader
          label={`Loading ${activeTab.label}`}
          detail={`Fetching ${contributorLabel} and their related book counts.`}
        />
      ) : error ? (
        <div className="page-state page-state-error">{error}</div>
      ) : contributors.length ? (
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
              {pagination.items.map((contributor) => (
                <tr key={contributor.id}>
                  <td className="table-code-cell">{contributor.catalog_code}</td>
                  <td>
                    <Link to={buildBooksLink(contributor.catalog_code)} className="table-title-link">
                      {contributor.name}
                    </Link>
                  </td>
                  <td>{contributor.book_count}</td>
                  <td>{contributor.digital_book_count}</td>
                  <td>{contributor.manual_book_count}</td>
                  <td>{formatBookDate(contributor.created_at)}</td>
                  <td className="table-action-cell">
                    <Link to={buildBooksLink(contributor.catalog_code)} className="ghost-button table-row-action">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="page-state">{activeTab.emptyLabel}</div>
      )}
    </div>
  );
}
