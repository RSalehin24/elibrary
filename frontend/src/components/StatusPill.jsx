export default function StatusPill({ value }) {
  const normalized = (value || "unknown").replace(/_/g, " ");
  return <span className={`status-pill status-${value}`}>{normalized}</span>;
}
