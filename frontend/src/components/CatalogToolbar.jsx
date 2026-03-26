import LoadingSpinner from "./LoadingSpinner";

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M10.75 4.5a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5Zm0 1.5a4.75 4.75 0 1 1 0 9.5 4.75 4.75 0 0 1 0-9.5Zm6.86 10.55 2.95 2.95a.75.75 0 1 1-1.06 1.06l-2.95-2.95a.75.75 0 1 1 1.06-1.06Z"
        fill="currentColor"
      />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4.75 6a.75.75 0 0 1 .75-.75h13a.75.75 0 0 1 0 1.5h-13A.75.75 0 0 1 4.75 6Zm2.5 6a.75.75 0 0 1 .75-.75h8a.75.75 0 0 1 0 1.5h-8A.75.75 0 0 1 7.25 12Zm3 6a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1-.75-.75Z"
        fill="currentColor"
      />
    </svg>
  );
}

function countActiveFilters(filters, fields, defaultFilters) {
  return fields.reduce((count, field) => {
    const currentValue = String(filters[field.key] ?? "").trim();
    const defaultValue = String(defaultFilters[field.key] ?? "").trim();
    if (!currentValue || currentValue === defaultValue) {
      return count;
    }
    return count + 1;
  }, 0);
}

function renderField(field, filters, setFilters) {
  const value = filters[field.key] ?? "";

  if (field.type === "select") {
    return (
      <select
        value={value}
        onChange={(event) =>
          setFilters({ ...filters, [field.key]: event.target.value })
        }
      >
        {(field.options || []).map((option) => (
          <option key={`${field.key}-${option.value}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      type={field.type || "text"}
      value={value}
      placeholder={field.placeholder || ""}
      onChange={(event) =>
        setFilters({ ...filters, [field.key]: event.target.value })
      }
    />
  );
}

export function CatalogSearchRow({
  filters,
  setFilters,
  fields,
  defaultFilters,
  filtersExpanded,
  setFiltersExpanded,
  searchPlaceholder,
  resultCount,
  drawerId,
  compact = false,
  className = "",
  onSearchClear = null,
  showResultCount = true,
  onSubmit,
  buttonsDisabled = false,
  actionsExtra = null,
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
        onSubmit(event);
      }
    : undefined;

  const handleSearch = (event) => {
    if (typeof onSearchClear !== "function") {
      return;
    }
    const nextQuery = String(event.target?.value || "").trim();
    if (nextQuery !== "") {
      return;
    }
    onSearchClear({ ...filters, q: "" });
  };

  const handleQueryChange = (event) => {
    const nextQuery = event.target.value;
    setFilters({ ...filters, q: nextQuery });
    if (
      typeof onSearchClear === "function" &&
      String(nextQuery).trim() === ""
    ) {
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
          onInput={handleSearch}
          placeholder={searchPlaceholder}
          autoComplete="off"
        />
      </label>
      <div className="catalog-search-actions">
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
          {activeFilterCount ? (
            <span className="catalog-filter-count">{activeFilterCount}</span>
          ) : null}
        </button>
        {showResultCount &&
        resultCount !== "" &&
        resultCount !== undefined &&
        resultCount !== null ? (
          <span
            className="catalog-result-count"
            aria-label={`${resultCount} results`}
          >
            {resultCount}
          </span>
        ) : null}
        {actionsExtra ? (
          <div className="catalog-search-actions-extra">{actionsExtra}</div>
        ) : null}
      </div>
    </RowTag>
  );
}

export default function CatalogToolbar({
  filters,
  setFilters,
  fields,
  defaultFilters,
  filtersExpanded,
  setFiltersExpanded,
  onSubmit,
  onReset,
  searchPlaceholder,
  resultCount,
  secondaryContent = null,
  submitLabel = "Apply filters",
  inline = false,
  drawerId = "catalog-filter-drawer",
  showSearchRow = true,
  searchRowCompact = false,
  searchRowClassName = "",
  onSearchClear = null,
  showResultCount = true,
  buttonsDisabled = false,
  bare = false,
  searchActionsExtra = null,
  secondaryBelow = false,
  buttonsLoading = false,
  drawerFirst = false,
}) {
  const wrapperClassName = `catalog-toolbar-wrap${filtersExpanded ? " is-expanded" : ""}${inline ? " is-inline" : ""}${
    bare ? " is-bare" : ""
  }`;
  const hasInlineSecondary = Boolean(secondaryContent && !secondaryBelow);
  const hasSplitTopline = showSearchRow && hasInlineSecondary;
  const hasSecondaryOnlyTopline = !showSearchRow && hasInlineSecondary;
  const toplineClassName = `catalog-toolbar-topline${hasSplitTopline ? " has-secondary" : ""}${
    hasSecondaryOnlyTopline ? " is-secondary-only" : ""
  }${bare ? " is-bare" : ""}`;
  const searchRow = showSearchRow ? (
    <CatalogSearchRow
      filters={filters}
      setFilters={setFilters}
      fields={fields}
      defaultFilters={defaultFilters}
      filtersExpanded={filtersExpanded}
      setFiltersExpanded={setFiltersExpanded}
      searchPlaceholder={searchPlaceholder}
      resultCount={resultCount}
      drawerId={drawerId}
      compact={searchRowCompact}
      className={searchRowClassName}
      onSearchClear={onSearchClear}
      showResultCount={showResultCount}
      buttonsDisabled={buttonsDisabled}
      actionsExtra={searchActionsExtra}
    />
  ) : null;
  const secondaryShellClassName = `catalog-toolbar-secondary-shell${hasSecondaryOnlyTopline ? " is-standalone" : ""}${
    bare ? " is-bare" : ""
  }${secondaryBelow ? " is-below" : ""}`;
  const filterDrawer = (
    <div
      id={drawerId}
      className={`catalog-filter-drawer${filtersExpanded ? " is-open" : ""}`}
      aria-hidden={filtersExpanded ? "false" : "true"}
    >
      <div className="catalog-filter-grid">
        {fields.map((field) => (
          <label key={field.key} className="catalog-filter-field">
            <span className="fact-label">{field.label}</span>
            {renderField(field, filters, setFilters)}
          </label>
        ))}
      </div>
      <div className="catalog-filter-actions">
        <button
          type="submit"
          className="primary-button"
          disabled={buttonsDisabled || buttonsLoading}
        >
          <span className="button-label">
            {buttonsLoading ? <LoadingSpinner size={14} /> : null}
            {submitLabel}
          </span>
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={onReset}
          disabled={buttonsDisabled}
        >
          Reset
        </button>
      </div>
    </div>
  );

  return (
    <section className={wrapperClassName}>
      <div className="catalog-toolbar-surface">
        <form className="catalog-toolbar-form" onSubmit={onSubmit}>
          {drawerFirst ? filterDrawer : null}
          {searchRow || hasInlineSecondary ? (
            <div className={toplineClassName}>
              {searchRow ? (
                hasInlineSecondary ? (
                  <div
                    className={`catalog-toolbar-primary${bare ? " is-bare" : ""}`}
                  >
                    {searchRow}
                  </div>
                ) : (
                  searchRow
                )
              ) : null}
              {hasInlineSecondary ? (
                <div className={secondaryShellClassName}>
                  {secondaryContent}
                </div>
              ) : null}
            </div>
          ) : null}
          {secondaryContent && secondaryBelow ? (
            <div className={secondaryShellClassName}>{secondaryContent}</div>
          ) : null}
          {!drawerFirst ? filterDrawer : null}
        </form>
      </div>
    </section>
  );
}
