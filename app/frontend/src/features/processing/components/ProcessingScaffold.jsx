import BookRouteLink from "../../../components/BookRouteLink";
import EmptyState from "../../../components/EmptyState";
import LoadingSpinner from "../../../components/LoadingSpinner";
import { getRequestPrimaryText, getRequestSecondaryText } from "../helpers";

export function RequestValue({ value, error }) {
  const primary = getRequestPrimaryText(value);
  const secondary = getRequestSecondaryText(value);

  return (
    <div className="table-cell-stack table-request-cell">
      <strong>{primary}</strong>
      {secondary ? <span className="table-note">{secondary}</span> : null}
      {error ? <span className="processing-row-error">{error}</span> : null}
    </div>
  );
}

export function BookLinkCell({ submission }) {
  if (submission.linked_book_deleted) {
    return (
      <span className="table-note">
        {submission.linked_book?.title || "Deleted record"}
      </span>
    );
  }

  if (!submission.linked_book_slug) {
    return <span className="table-note">-</span>;
  }

  return (
    <BookRouteLink slug={submission.linked_book_slug} className="meta-link">
      {submission.linked_book?.title || submission.linked_book_slug}
    </BookRouteLink>
  );
}

export function CatalogRefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M20 5v5h-5M4 19v-5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 10a8 8 0 0 0-13.66-5.66L4 6.5M4 14a8 8 0 0 0 13.66 5.66L20 17.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CatalogStopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect
        x="6.5"
        y="6.5"
        width="11"
        height="11"
        rx="2.5"
        fill="currentColor"
      />
    </svg>
  );
}

export function renderProcessingCardLoader(label) {
  const screenReaderLabel = label || "Loading";
  return (
    <div
      className="processing-inline-loader"
      role="status"
      aria-live="polite"
      aria-label={screenReaderLabel}
    >
      <LoadingSpinner size={16} />
      <span>Loading...</span>
    </div>
  );
}

export function QueueTableCard({
  title,
  count,
  headerAside,
  toolbar,
  actions,
  children,
  emptyTitle,
  cardClassName = "",
  loading = false,
  loadingLabel = "",
}) {
  const titleBlock = (
    <div className="section-title-block">
      <h2>{title}</h2>
    </div>
  );
  const countPill =
    count !== undefined && count !== null ? (
      <span className="processing-card-count">
        {loading ? <LoadingSpinner size={14} /> : count}
      </span>
    ) : null;
  const shellContent = loading
    ? renderProcessingCardLoader(
        loadingLabel || `Loading ${title.toLowerCase()}`,
      )
    : children || <EmptyState title={emptyTitle} />;

  return (
    <section
      className={`detail-card processing-card processing-list-card ${cardClassName}`.trim()}
    >
      <div className="processing-card-head">
        {headerAside ? (
          <div className="processing-card-head-meta">
            {titleBlock}
            {countPill}
          </div>
        ) : (
          titleBlock
        )}
        {headerAside ? null : countPill}
        {headerAside ? (
          <div className="processing-card-head-aside">{headerAside}</div>
        ) : null}
      </div>
      {toolbar ? (
        <div className="processing-card-toolbar">{toolbar}</div>
      ) : null}
      {actions ? <div className="processing-bulk-bar">{actions}</div> : null}
      <div className={`processing-table-shell${loading ? " is-loading" : ""}`}>
        {shellContent}
      </div>
    </section>
  );
}
