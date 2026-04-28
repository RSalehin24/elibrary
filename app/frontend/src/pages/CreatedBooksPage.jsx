import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import BookCardGrid from "../components/BookCardGrid";
import CatalogToolbar from "../components/CatalogToolbar";
import EmptyState from "../components/EmptyState";
import { useInfiniteCatalogBooks } from "../hooks/useInfiniteCatalogBooks";
import {
  cleanQueryParams,
  filtersFromSearchParams,
} from "../utils/query";

const defaultFilters = {
  q: "",
  author: "",
  series: "",
  category: "",
  state: "",
  review_state: "",
  sort: "-requested_at",
  ownership: "mine",
};

const createdBookFilterFields = [
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
    key: "sort",
    label: "Sort",
    type: "select",
    options: [
      { value: "-requested_at", label: "Newest request first" },
      { value: "requested_at", label: "Oldest request first" },
      { value: "-created_at", label: "Newest book first" },
      { value: "created_at", label: "Oldest book first" },
      { value: "title", label: "Title A-Z" },
      { value: "-title", label: "Title Z-A" },
    ],
  },
];

const createdBookToolbarFields = createdBookFilterFields.filter(
  (field) => field.key !== "sort",
);
const createdBookSortOptions =
  createdBookFilterFields.find((field) => field.key === "sort")?.options || [];

export default function CreatedBooksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const appliedFilters = useMemo(
    () => filtersFromSearchParams(defaultFilters, searchParams),
    [searchParams],
  );
  const [filters, setFilters] = useState(appliedFilters);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
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
        <h1>My Books</h1>

        <CatalogToolbar
          filters={filters}
          setFilters={setFilters}
          fields={createdBookToolbarFields}
          defaultFilters={defaultFilters}
          filtersExpanded={filtersExpanded}
          setFiltersExpanded={setFiltersExpanded}
          onSubmit={applyFilters}
          onReset={resetFilters}
          searchPlaceholder="Search your books by title or book ID..."
          resultCount={resultCount}
          resultCountLoading={initialLoading || refreshing}
          onSearchClear={clearSearch}
          sortValue={filters.sort}
          sortOptions={createdBookSortOptions}
          onSortChange={(nextSort) => {
            const nextFilters = {
              ...filters,
              sort: nextSort,
            };
            setFilters(nextFilters);
            setSearchParams(cleanQueryParams(nextFilters));
          }}
          sortAriaLabel="Sort my books"
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
        />
      )}
    </div>
  );
}
