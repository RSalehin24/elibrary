import LoadingSpinner from "../../../components/LoadingSpinner";
import { formatBookDateTime } from "../../../utils/bookPresentation";

export default function BookReaderSections({
  bookmarks,
  deletingBookmarkId,
  onDeleteBookmark,
  progressPercent,
  readerAccess,
  readerState,
}) {
  return (
    <section className="book-detail-grid" data-testid="book-reader-sections">
      <section className="detail-card">
        <div className="section-title-block">
          <p className="eyebrow">Reader</p>
          <h2>Reading</h2>
        </div>
        {readerAccess ? (
          <div className="reader-stats-grid">
            <article className="book-detail-chip">
              <span className="fact-label">Progress</span>
              <strong>{progressPercent}%</strong>
            </article>
            <article className="book-detail-chip">
              <span className="fact-label">Last location</span>
              <strong className="metadata-value">
                {readerState.last_location || "Not synced"}
              </strong>
            </article>
            <article className="book-detail-chip">
              <span className="fact-label">Last opened</span>
              <strong>
                {readerState.last_opened_at
                  ? formatBookDateTime(readerState.last_opened_at)
                  : "Not synced"}
              </strong>
            </article>
          </div>
        ) : (
          <p className="muted-copy">Syncs after reading.</p>
        )}
      </section>

      <section className="detail-card">
        <div className="section-title-block">
          <p className="eyebrow">Reader</p>
          <h2>Bookmarks</h2>
        </div>
        {readerAccess ? (
          bookmarks.length ? (
            <div className="queue-list">
              {bookmarks.map((bookmark) => (
                <article key={bookmark.id} className="queue-card">
                  <strong>{bookmark.label || bookmark.location}</strong>
                  {bookmark.label && bookmark.location ? (
                    <p className="metadata-value">{bookmark.location}</p>
                  ) : null}
                  {bookmark.note ? <p>{bookmark.note}</p> : null}
                  <div className="inline-pills">
                    <button
                      type="button"
                      data-testid={`bookmark-remove-${bookmark.id}`}
                      className="ghost-button"
                      onClick={() => onDeleteBookmark(bookmark.id)}
                    >
                      <span className="button-label">
                        {deletingBookmarkId === bookmark.id ? (
                          <LoadingSpinner size={14} />
                        ) : null}
                        {deletingBookmarkId === bookmark.id
                          ? "Removing..."
                          : "Remove"}
                      </span>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">No bookmarks yet.</p>
          )
        ) : (
          <p className="muted-copy">Syncs after reading.</p>
        )}
      </section>
    </section>
  );
}
