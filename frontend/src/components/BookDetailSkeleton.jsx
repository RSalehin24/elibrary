export default function BookDetailSkeleton() {
  return (
    <div className="book-detail-page book-detail-page-loading" aria-hidden="true">
      <section className="detail-card book-hero">
        <div className="book-hero-cover">
          <div className="book-cover-placeholder book-cover-large skeleton-block" />
        </div>
        <div className="book-hero-copy">
          <span className="eyebrow">Loading book record</span>
          <div className="skeleton-lines">
            <span className="skeleton-line skeleton-line-xl" />
            <span className="skeleton-line skeleton-line-lg" />
            <span className="skeleton-line" />
          </div>
          <div className="detail-statuses">
            <span className="status-pill skeleton-pill" />
            <span className="status-pill skeleton-pill" />
          </div>
          <div className="book-hero-actions">
            <span className="primary-button skeleton-button" />
            <span className="ghost-button skeleton-button" />
          </div>
        </div>
      </section>

      <section className="detail-facts book-facts-grid">
        <div className="detail-card skeleton-panel" />
        <div className="detail-card skeleton-panel" />
        <div className="detail-card skeleton-panel" />
        <div className="detail-card skeleton-panel" />
      </section>

      <section className="book-detail-grid">
        <div className="detail-card skeleton-panel skeleton-panel-tall" />
        <div className="detail-card skeleton-panel skeleton-panel-tall" />
      </section>
    </div>
  );
}
