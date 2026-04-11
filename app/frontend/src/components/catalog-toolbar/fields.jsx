export function countActiveFilters(filters, fields, defaultFilters) {
  return fields.reduce((count, field) => {
    const currentValue = String(filters[field.key] ?? "").trim();
    const defaultValue = String(defaultFilters[field.key] ?? "").trim();
    return !currentValue || currentValue === defaultValue ? count : count + 1;
  }, 0);
}

export function renderField(field, filters, setFilters) {
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
