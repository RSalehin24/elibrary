import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import BookCardGrid from "../components/BookCardGrid";
import CatalogToolbar from "../components/CatalogToolbar";
import EmptyState from "../components/EmptyState";
import { useInfiniteCatalogBooks } from "../hooks/useInfiniteCatalogBooks";
import { usePageTitle } from "../hooks/usePageTitle";
import { useSessionFlag } from "../hooks/useSessionFlag";
import { cleanQueryParams, filtersFromSearchParams } from "../utils/query";

const defaultFilters = {
  q: "",
  author: "",
  series: "",
  category: "",
  state: "",
  review_state: "",
  record_type: "all",
  sort: "-created_at",
};

const homeFilterFields = [
  { key: "author", label: "Author" },
  { key: "series", label: "Series" },
  { key: "category", label: "Category" },
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
    key: "record_type",
    label: "Type",
    type: "select",
    options: [
      { value: "all", label: "All books" },
      { value: "digital", label: "Digital" },
      { value: "manual", label: "Manual" },
    ],
  },
  {
    key: "sort",
    label: "Sort",
    type: "select",
    options: [
      { value: "-created_at", label: "Newest first" },
      { value: "created_at", label: "Oldest first" },
      { value: "title", label: "Title A-Z" },
      { value: "-title", label: "Title Z-A" },
    ],
  },
];

const homeToolbarFields = homeFilterFields.filter(
  (field) => field.key !== "sort",
);
const homeSortOptions =
  homeFilterFields.find((field) => field.key === "sort")?.options || [];

export default function HomePage() {
  usePageTitle("Home");
  const [searchParams, setSearchParams] = useSearchParams();
  const appliedFilters = useMemo(
    () => filtersFromSearchParams(defaultFilters, searchParams),
    [searchParams],
  );
  const [filters, setFilters] = useState(appliedFilters);
  const [filtersExpanded, setFiltersExpanded] = useSessionFlag(
    "filters-expanded:home",
    false,
  );
  const {
    books,
    totalCount,
    hasMore,
    initialLoading,
    loadingMore,
    refreshing,
    error,
    observeLoadTrigger,
  } = useInfiniteCatalogBooks({
    filters: appliedFilters,
  });

  useEffect(() => {
    setFilters(appliedFilters);
  }, [appliedFilters]);

  function applyFilters(event, nextFilters = filters) {
    event.preventDefault();
    setFilters(nextFilters);
    setSearchParams(cleanQueryParams(nextFilters));
  }

  function resetFilters() {
    setFilters(defaultFilters);
    setSearchParams(cleanQueryParams(defaultFilters));
  }

  function clearSearch(nextFilters) {
    setFilters(nextFilters);
    setSearchParams(cleanQueryParams(nextFilters));
  }

  const resultCount = error && !books.length ? "" : `${totalCount}`;
  const showErrorState = Boolean(error && !books.length && !initialLoading);

  return (
    <div className="catalog-page page-stack">
      <header className="catalog-page-header catalog-page-header--with-toolbar catalog-page-header--property-layout">
        <h1>All Books</h1>

        <CatalogToolbar
          filters={filters}
          setFilters={setFilters}
          fields={homeToolbarFields}
          defaultFilters={defaultFilters}
          filtersExpanded={filtersExpanded}
          setFiltersExpanded={setFiltersExpanded}
          onSubmit={applyFilters}
          onReset={resetFilters}
          searchPlaceholder="Search all books by title, book ID, or writer..."
          resultCount={resultCount}
          resultCountLoading={initialLoading || refreshing}
          onSearchClear={clearSearch}
          sortValue={filters.sort}
          sortOptions={homeSortOptions}
          onSortChange={(nextSort) => {
            const nextFilters = {
              ...filters,
              sort: nextSort,
            };
            setFilters(nextFilters);
            setSearchParams(cleanQueryParams(nextFilters));
          }}
          sortAriaLabel="Sort all books"
          searchRowCompact
          searchRowClassName="catalog-search-row--property-compact"
          inline
          bare
          buttonsLoading={initialLoading || refreshing}
          buttonsDisabled={initialLoading || loadingMore || refreshing}
        />
      </header>

      {showErrorState ? (
        <div className="page-state page-state-error">{error}</div>
      ) : books.length || initialLoading || refreshing ? (
        <BookCardGrid
          books={books}
          hasMore={hasMore}
          observeLoadTrigger={observeLoadTrigger}
          initialLoading={initialLoading}
          loadingMore={loadingMore}
          refreshing={refreshing}
        />
      ) : (
        <EmptyState
          title="No books found"
          body="Adjust the search or filters."
          actions={
            JSON.stringify(cleanQueryParams(appliedFilters)) !==
            JSON.stringify(cleanQueryParams(defaultFilters)) ? (
              <button
                type="button"
                className="ghost-button"
                onClick={resetFilters}
              >
                Clear all filters
              </button>
            ) : null
          }
        />
      )}
    </div>
  );
}
