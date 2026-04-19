import LoadingSpinner from "../LoadingSpinner";
import { FilterIcon, SearchIcon } from "./icons";
import { countActiveFilters } from "./fields.jsx";

export function CatalogSearchRow({
  filters,
  setFilters,
  fields,
  defaultFilters,
  filtersExpanded,
  setFiltersExpanded,
  searchPlaceholder,
  resultCount,
  resultCountLoading = false,
  drawerId,
  compact = false,
  className = "",
  onSearchClear = null,
  showResultCount = true,
  onSubmit,
  buttonsDisabled = false,
  actionsExtra = null,
  showFilterToggle = true,
  resultCountTestId = undefined,
  searchTestId = undefined,
  sortValue = "",
  sortOptions = [],
  onSortChange = null,
  sortAriaLabel = "Sort results",
  sortDisabled = false,
}) {
  const activeFilterCount = countActiveFilters(filters, fields, defaultFilters);
  const rowClassName = `catalog-search-row${compact ? " catalog-search-row--compact" : ""}${className ? ` ${className}` : ""}`;
  const RowTag = onSubmit ? "form" : "div";
  const handleSubmit = onSubmit
    ? (event) => {
        if (buttonsDisabled) {
          event.preventDefault();
          return;
        }
        const queryInput = event.currentTarget?.querySelector('input[type="search"]');
        onSubmit(event, { ...filters, q: queryInput ? queryInput.value : filters.q });
      }
    : undefined;

  const handleQueryChange = (event) => {
    const nextQuery = event.target.value;
    setFilters({ ...filters, q: nextQuery });
    if (typeof onSearchClear === "function" && String(nextQuery).trim() === "") {
      onSearchClear({ ...filters, q: "" });
    }
  };

  return (
    <RowTag className={rowClassName} onSubmit={handleSubmit}>
      <label className="catalog-search-field" aria-label={searchPlaceholder}>
        <span className="catalog-search-icon">
          <SearchIcon />
        </span>
        <input
          type="search"
          value={filters.q || ""}
          onChange={handleQueryChange}
          onInput={(event) => {
            if (typeof onSearchClear === "function" && String(event.target?.value || "").trim() === "") {
              onSearchClear({ ...filters, q: "" });
            }
          }}
          placeholder={searchPlaceholder}
          autoComplete="off"
          data-testid={searchTestId}
        />
      </label>
      <div className="catalog-search-actions">
        {sortOptions?.length ? (
          <div className="catalog-search-sort">
            <select
              className="catalog-toolbar-select"
              value={sortValue}
              onChange={(event) => onSortChange?.(event.target.value)}
              aria-label={sortAriaLabel}
              disabled={buttonsDisabled || sortDisabled}
            >
              {sortOptions.map((option) => (
                <option key={`sort-${option.value}`} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {showFilterToggle ? (
          <button
            type="button"
            className={`catalog-filter-toggle${filtersExpanded ? " is-active" : ""}`}
            onClick={() => setFiltersExpanded((current) => !current)}
            aria-expanded={filtersExpanded}
            aria-controls={drawerId}
            disabled={buttonsDisabled}
          >
            <FilterIcon />
            <span>Filters</span>
            {activeFilterCount ? <span className="catalog-filter-count">{activeFilterCount}</span> : null}
          </button>
        ) : null}
        {showResultCount && (resultCountLoading || resultCount !== "" && resultCount !== undefined && resultCount !== null) ? (
          <span
            className={`catalog-result-count${resultCountLoading ? " is-loading" : ""}`}
            aria-label={resultCountLoading ? "Loading results" : `${resultCount} results`}
            data-testid={resultCountTestId}
          >
            {resultCountLoading ? <LoadingSpinner size={14} /> : resultCount}
          </span>
        ) : null}
        {actionsExtra ? <div className="catalog-search-actions-extra">{actionsExtra}</div> : null}
      </div>
    </RowTag>
  );
}
