import BookCoverArt from "../../../components/BookCoverArt";
import LoadingSpinner from "../../../components/LoadingSpinner";
import StatusPill from "../../../components/StatusPill";
import { assetLabels } from "../constants";
import { RefreshIcon, TrashIcon } from "./BookDetailIcons";
import BookFilterLinkList from "./BookFilterLinkList";

export default function BookDetailHero({
  actions,
  assetLoadingCounts,
  book,
  bookIdValue,
  bookLinkFilters,
  canEditMetadata,
  deleting,
  detail,
  epubInputRef,
  htmlPreviewLockedByAssetId,
  launchingReader,
  pickingEpub,
  primaryContributorGroup,
  regenerating,
  replacingEpub,
  supportingContributorGroups,
}) {
  return (
    <section className="detail-card book-hero" data-testid="book-detail-hero">
      {canEditMetadata ? (
        <div className="book-hero-controls">
          <button
            type="button"
            data-testid="book-regenerate-button"
            className="book-refresh-control"
            onClick={actions.regenerateBook}
            aria-label={
              detail.hasActiveProcessing
                ? "Book regeneration in progress"
                : "Regenerate book"
            }
            title={
              detail.hasActiveProcessing
                ? "Book regeneration in progress"
                : "Regenerate book"
            }
            disabled={regenerating || detail.hasActiveProcessing}
          >
            <RefreshIcon spinning={regenerating || detail.hasActiveProcessing} />
          </button>
          <button
            type="button"
            data-testid="book-delete-button"
            className="book-delete-control"
            onClick={actions.requestDeleteBook}
            aria-label={deleting ? "Deleting book" : "Delete book"}
            title={deleting ? "Deleting book" : "Delete book"}
            disabled={deleting || detail.hasActiveProcessing}
          >
            {deleting ? <LoadingSpinner size={18} /> : <TrashIcon />}
          </button>
        </div>
      ) : null}

      <div className="book-hero-cover">
        <BookCoverArt
          book={book}
          className="book-cover-large book-hero-placeholder"
          ariaHidden
        />
      </div>

      <div className="book-hero-copy">
        <strong className="book-hero-id">{bookIdValue}</strong>
        <h1>{book.title}</h1>
        {primaryContributorGroup ? (
          primaryContributorGroup.role === "author" ? (
            <p className="detail-lead">
              <BookFilterLinkList
                values={primaryContributorGroup.names}
                queryKey="author"
                emptyLabel="Contributor unavailable"
                extraFilters={bookLinkFilters}
              />
            </p>
          ) : (
            <p className="detail-meta-row detail-lead-row">
              <span className="fact-label">{primaryContributorGroup.label}</span>
              <span className="detail-meta-values">
                <BookFilterLinkList
                  values={primaryContributorGroup.names}
                  queryKey="contributor"
                  emptyLabel="Contributor unavailable"
                  extraFilters={bookLinkFilters}
                />
              </span>
            </p>
          )
        ) : (
          <p className="detail-lead">Contributor unavailable</p>
        )}

        <div className="detail-statuses">
          <StatusPill value={book.state} />
          <StatusPill value={book.review_state} />
        </div>

        {supportingContributorGroups.length ||
        book.series?.length ||
        book.categories?.length ? (
          <div className="book-meta-stack">
            {supportingContributorGroups.map((group) => (
              <p key={group.role} className="detail-meta-row">
                <span className="fact-label">{group.label}</span>
                <span className="detail-meta-values">
                  <BookFilterLinkList
                    values={group.names}
                    queryKey={group.role === "author" ? "author" : "contributor"}
                    extraFilters={bookLinkFilters}
                  />
                </span>
              </p>
            ))}
            {book.series?.length ? (
              <p className="detail-meta-row">
                <span className="fact-label">Series</span>
                <span className="detail-meta-values">
                  <BookFilterLinkList
                    values={book.series}
                    queryKey="series"
                    extraFilters={bookLinkFilters}
                  />
                </span>
              </p>
            ) : null}
            {book.categories?.length ? (
              <p className="detail-meta-row">
                <span className="fact-label">Categories</span>
                <span className="detail-meta-values">
                  <BookFilterLinkList
                    values={book.categories}
                    queryKey="category"
                    extraFilters={bookLinkFilters}
                  />
                </span>
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="book-hero-actions">
          <button
            type="button"
            data-testid="book-open-reader-button"
            className="primary-button"
            onClick={actions.launchReader}
            disabled={launchingReader}
          >
            <span className="button-label">
              {launchingReader ? <LoadingSpinner size={16} /> : null}
              {launchingReader ? "Opening..." : "Open reader"}
            </span>
          </button>
          {detail.downloadableAssets.map((asset) => {
            const isDownloading = Boolean(assetLoadingCounts[asset.id]);
            const isHtmlPreviewLocked =
              asset.asset_type === "html" &&
              Boolean(htmlPreviewLockedByAssetId[asset.id]);
            return (
              <button
                key={asset.id}
                type="button"
                data-testid={`book-asset-${asset.asset_type}`}
                className="ghost-button asset-link"
                onClick={() => actions.downloadAsset(asset)}
                disabled={isDownloading || isHtmlPreviewLocked}
              >
                <span className="button-label">
                  {isDownloading ? <LoadingSpinner size={16} /> : null}
                  {isDownloading
                    ? "Preparing..."
                    : isHtmlPreviewLocked
                      ? "Preview Open"
                      : assetLabels[asset.asset_type] ||
                        `Download ${asset.asset_type.toUpperCase()}`}
                </span>
              </button>
            );
          })}
          {canEditMetadata ? (
            <>
              <input
                ref={epubInputRef}
                type="file"
                accept=".epub,application/epub+zip"
                hidden
                onChange={actions.replaceEpub}
              />
              <button
                type="button"
                data-testid="book-replace-epub-button"
                className="ghost-button"
                onClick={actions.openEpubPicker}
                disabled={
                  pickingEpub ||
                  replacingEpub ||
                  regenerating ||
                  detail.hasActiveProcessing
                }
              >
                <span className="button-label">
                  {pickingEpub || replacingEpub ? (
                    <LoadingSpinner size={16} />
                  ) : null}
                  {pickingEpub
                    ? "Selecting..."
                    : replacingEpub
                      ? "Uploading..."
                      : detail.epubAsset
                        ? "Replace EPUB"
                        : "Upload EPUB"}
                </span>
              </button>
            </>
          ) : null}
        </div>

        {detail.latestProcessingJob &&
        (detail.hasActiveProcessing || detail.hasFailedProcessing) ? (
          <div
            className={`book-status-note${detail.hasActiveProcessing ? " book-status-note-processing" : ""}${
              detail.hasFailedProcessing ? " book-status-note-error" : ""
            }`}
          >
            <div className="book-status-note-head">
              <span className="fact-label">Processing</span>
              {detail.hasActiveProcessing ? <LoadingSpinner size={14} /> : null}
            </div>
            <strong>{detail.processingHeading}</strong>
            <p>{detail.processingBody}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
