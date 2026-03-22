export default function BookCardSkeleton() {
  return (
    <article className="book-card book-card-skeleton" aria-hidden="true">
      <div className="book-card-art">
        <div className="book-cover-placeholder book-card-cover skeleton-block" />
      </div>
      <div className="book-card-body">
        <div className="book-card-topline">
          <span className="status-pill skeleton-pill" />
          <span className="status-pill skeleton-pill" />
        </div>
        <div className="skeleton-lines">
          <span className="skeleton-line skeleton-line-lg" />
          <span className="skeleton-line" />
          <span className="skeleton-line skeleton-line-sm" />
        </div>
        <div className="book-card-details">
          <div className="book-detail-chip skeleton-panel" />
          <div className="book-detail-chip skeleton-panel" />
          <div className="book-detail-chip skeleton-panel" />
        </div>
        <div className="book-card-footer">
          <span className="skeleton-line skeleton-line-sm" />
          <span className="primary-button skeleton-button" />
        </div>
      </div>
    </article>
  );
}
