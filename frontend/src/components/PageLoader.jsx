import LoadingSpinner from "./LoadingSpinner";

export default function PageLoader({ label = "Loading", detail = "", className = "" }) {
  const classes = ["page-loader", className].filter(Boolean).join(" ");

  return (
    <div className={classes} role="status" aria-live="polite">
      <div className="page-loader-badge">
        <LoadingSpinner size={22} />
      </div>
      <div className="page-loader-copy">
        <strong>{label}</strong>
        {detail ? <p>{detail}</p> : null}
      </div>
    </div>
  );
}
