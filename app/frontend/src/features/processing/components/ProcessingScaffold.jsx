import BookRouteLink from "../../../components/BookRouteLink";
import EmptyState from "../../../components/EmptyState";
import ProcessingCardSkeleton from "../../../components/ProcessingCardSkeleton";
import { getRequestPrimaryText, getRequestSecondaryText } from "../helpers";

export function RequestValue({ value, error }) {
  const primary = getRequestPrimaryText(value);
  const secondary = getRequestSecondaryText(value);

  return (
    <div className="table-cell-stack table-request-cell">
      <strong>{primary}</strong>
      {secondary ? <span className="table-note">{secondary}</span> : null}
      <ProcessingErrorDisclosure message={error} />
    </div>
  );
}

export function ProcessingErrorDisclosure({
  message,
  summary = "View error",
  className = "processing-row-error",
  bodyClassName = "processing-row-error-body",
}) {
  if (!message) {
    return null;
  }

  return (
    <details className={className}>
      <summary>{summary}</summary>
      <div className={bodyClassName}>
        <pre>{message}</pre>
      </div>
    </details>
  );
}

export function InlineErrorCell({ message }) {
  if (!message) {
    return <span className="table-note">-</span>;
  }

  return (
    <div className="processing-inline-error-cell">
      <pre>{message}</pre>
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
  return <ProcessingCardSkeleton label={label || "Loading"} />;
}

export function ProcessingSummaryStat({ label, value, loading = false }) {
  return (
    <article className="processing-summary-stat">
      <span className="fact-label">{label}</span>
      {loading ? (
        <span
          className="processing-summary-value-skeleton skeleton-line skeleton-line-sm"
          aria-hidden="true"
        />
      ) : (
        <strong>{value}</strong>
      )}
    </article>
  );
}

export function ProcessingTableSkeletonStack({
  lines = ["xl"],
  className = "",
}) {
  return (
    <div
      className={`processing-table-skeleton-stack${className ? ` ${className}` : ""}`.trim()}
      aria-hidden="true"
    >
      {lines.map((line, index) => (
        <span
          key={`${line}-${index}`}
          className={`skeleton-line skeleton-line-${line}`}
        />
      ))}
    </div>
  );
}

export function ProcessingTableSkeletonCheckbox() {
  return (
    <span
      className="processing-checkbox-skeleton skeleton-line"
      aria-hidden="true"
    />
  );
}

export function ProcessingTableSkeletonActions({ count = 1 }) {
  return (
    <div className="processing-table-skeleton-actions" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="skeleton-line processing-action-skeleton" />
      ))}
    </div>
  );
}

export function ProcessingControlSkeleton({ className = "" }) {
  return (
    <span
      className={`processing-control-skeleton skeleton-line${className ? ` ${className}` : ""}`.trim()}
      aria-hidden="true"
    />
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
  replaceOnLoading = false,
  collapsible = false,
  collapsed = false,
  onToggleCollapsed = null,
}) {
  const titleBlock = (
    <div className="section-title-block">
      <h2>{title}</h2>
    </div>
  );
  const showHeaderAside = Boolean(headerAside) && !collapsed;
  const shellContent = loading && replaceOnLoading
    ? renderProcessingCardLoader(
        loadingLabel || `Loading ${title.toLowerCase()}`,
      )
    : children || <EmptyState title={emptyTitle} />;

  return (
    <section
      className={`detail-card processing-card processing-list-card${collapsed ? " is-collapsed" : ""} ${cardClassName}`.trim()}
    >
      <div className="processing-card-head">
        {showHeaderAside ? (
          <div className="processing-card-head-meta">{titleBlock}</div>
        ) : (
          titleBlock
        )}
        {showHeaderAside ? (
          <div className="processing-card-head-aside">{headerAside}</div>
        ) : null}
        {collapsible && onToggleCollapsed ? (
          <button
            type="button"
            className="ghost-button processing-card-toggle"
            onClick={onToggleCollapsed}
            aria-expanded={collapsed ? "false" : "true"}
          >
            {collapsed ? "Expand" : "Collapse"}
          </button>
        ) : null}
      </div>
      {!collapsed && toolbar ? (
        <div className="processing-card-toolbar">{toolbar}</div>
      ) : null}
      {!collapsed && actions ? (
        <div className="processing-bulk-bar">{actions}</div>
      ) : null}
      {!collapsed ? (
        <div
          className={`processing-table-shell${loading && replaceOnLoading ? " is-loading" : ""}`}
        >
          {shellContent}
        </div>
      ) : null}
    </section>
  );
}
