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
      <select value={value} onChange={(event) => setFilters({ ...filters, [field.key]: event.target.value })}>
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
      onChange={(event) => setFilters({ ...filters, [field.key]: event.target.value })}
    />
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
  submitLabel = "Apply filters",
  inline = false
}) {
  const activeFilterCount = countActiveFilters(filters, fields, defaultFilters);
  const wrapperClassName = `catalog-toolbar-wrap${filtersExpanded ? " is-expanded" : ""}${inline ? " is-inline" : ""}`;

  return (
    <section className={wrapperClassName}>
      <div className="catalog-toolbar-surface">
        <form className="catalog-toolbar-form" onSubmit={onSubmit}>
          <div className="catalog-search-row">
            <label className="catalog-search-field" aria-label={searchPlaceholder}>
              <span className="catalog-search-icon">
                <SearchIcon />
              </span>
              <input
                type="search"
                value={filters.q || ""}
                onChange={(event) => setFilters({ ...filters, q: event.target.value })}
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
                aria-controls="catalog-filter-drawer"
              >
                <FilterIcon />
                <span>Filters</span>
                {activeFilterCount ? <span className="catalog-filter-count">{activeFilterCount}</span> : null}
              </button>
              {resultCount !== "" && resultCount !== undefined && resultCount !== null ? (
                <span className="catalog-result-count" aria-label={`${resultCount} results`}>
                  {resultCount}
                </span>
              ) : null}
            </div>
          </div>
          <div
            id="catalog-filter-drawer"
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
              <button type="submit" className="primary-button">
                {submitLabel}
              </button>
              <button type="button" className="ghost-button" onClick={onReset}>
                Reset
              </button>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}
