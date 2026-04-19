import { useLocation, useNavigate, useParams } from "react-router-dom";
import { getBookReturnTarget, getCurrentRoutePath } from "../components/BookRouteLink";
import ConfirmationDialog from "../components/ConfirmationDialog";
import BookDetailSkeleton from "../components/BookDetailSkeleton";
import BookDetailHero from "../features/book-detail/components/BookDetailHero";
import BookMetadataWorkspace from "../features/book-detail/components/BookMetadataWorkspace";
import BookReaderSections from "../features/book-detail/components/BookReaderSections";
import BookTocSummary from "../features/book-detail/components/BookTocSummary";
import { useBookDetailActions } from "../features/book-detail/hooks/useBookDetailActions";
import { useBookDetailData } from "../features/book-detail/hooks/useBookDetailData";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import { getSourceLabel } from "../utils/bookPresentation";
import { hasCapability } from "../utils/capabilities";

export default function BookDetailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useSession();
  const toast = useToast();
  const { slug } = useParams();
  const canEditMetadata = hasCapability(user, "metadata:edit");
  const currentDetailPath = getCurrentRoutePath(location);
  const returnTarget = getBookReturnTarget(location);
  const detailState = useBookDetailData({
    canEditMetadata,
    location,
    navigate,
    slug,
    toast,
    user,
  });
  const actions = useBookDetailActions({
    book: detailState.book,
    currentDetailPath,
    detail: detailState.detail,
    editor: detailState.editor,
    fetchBook: detailState.fetchBook,
    htmlPreviewLockedByAssetId: detailState.htmlPreviewLockedByAssetId,
    navigate,
    refreshMetadataCollections: detailState.refreshMetadataCollections,
    replaceBookRoute: detailState.replaceBookRoute,
    returnTarget,
    reviewForm: detailState.reviewForm,
    setBook: detailState.setBook,
    setHtmlPreviewLockedByAssetId: detailState.setHtmlPreviewLockedByAssetId,
    setMetadataReviews: detailState.setMetadataReviews,
    setReviewForm: detailState.setReviewForm,
    slug,
    toast,
    user,
  });

  if (detailState.loading) {
    return <BookDetailSkeleton />;
  }

  if (detailState.error) {
    return <div className="page-state page-state-error">{detailState.error}</div>;
  }

  const {
    book,
    bookLinkFilters,
    bookmarks,
    detail,
    editor,
    htmlPreviewLockedByAssetId,
    metadataReviews,
    metadataVersions,
    readerAccess,
    readerState,
    reviewForm,
    setEditor,
    setReviewForm,
  } = detailState;

  return (
    <div className="book-detail-page page-stack">
      <BookDetailHero
        actions={actions}
        assetLoadingCounts={actions.assetLoadingCounts}
        book={book}
        bookIdValue={detail.bookIdValue}
        bookLinkFilters={bookLinkFilters}
        canEditMetadata={canEditMetadata}
        deleting={actions.deleting}
        detail={detail}
        epubInputRef={actions.epubInputRef}
        htmlPreviewLockedByAssetId={htmlPreviewLockedByAssetId}
        launchingReader={actions.launchingReader}
        pickingEpub={actions.pickingEpub}
        primaryContributorGroup={detail.primaryContributorGroup}
        regenerating={actions.regenerating}
        replacingEpub={actions.replacingEpub}
        sendingToKindle={actions.sendingToKindle}
        supportingContributorGroups={detail.supportingContributorGroups}
      />

      {detail.sourceRecords.length ? (
        <section className="detail-card">
          <div className="panel-header">
            <div className="section-title-block">
              <p className="eyebrow">Source</p>
              <h2>Source Records</h2>
            </div>
          </div>
          <div className="source-record-list">
            {detail.sourceRecords.map((source, index) => (
              <article
                key={`${source.url}-${index}`}
                className="source-record-card"
              >
                <div className="source-record-copy">
                  <span className="fact-label">
                    {source.is_primary ? "Primary" : "Linked"}
                  </span>
                  <strong>{getSourceLabel(source) || "Source page"}</strong>
                  <a
                    className="source-link"
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source.display_url || source.url}
                  </a>
                </div>
                <a
                  className="ghost-button"
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open
                </a>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {detail.hasFrontMatter ? (
        <section className="detail-card">
          <div className="section-title-block">
            <p className="eyebrow">Extracted</p>
            <h2>Book Details</h2>
          </div>
          {detail.frontMatter.length ? (
            <div className="metadata-list">
              {detail.frontMatter.map((entry) => (
                <div key={`${entry.key}-${entry.value}`} className="metadata-row">
                  <span className="fact-label">{entry.label}</span>
                  <strong className="metadata-value">{entry.value}</strong>
                </div>
              ))}
            </div>
          ) : (
            <div
              className="rich-content-block"
              dangerouslySetInnerHTML={{ __html: book.book_info_html }}
            />
          )}
        </section>
      ) : null}

      {detail.hasDedication ? (
        <section className="detail-card">
          <div className="section-title-block">
            <p className="eyebrow">Extracted</p>
            <h2>Dedication</h2>
          </div>
          <div
            className="rich-content-block"
            dangerouslySetInnerHTML={{ __html: book.dedication_html }}
          />
        </section>
      ) : null}

      {detail.hasToc ? (
        <section className="detail-card">
          <div className="section-title-block">
            <p className="eyebrow">Structure</p>
            <h2>Table of Contents</h2>
          </div>
          <BookTocSummary toc={book.toc || []} />
        </section>
      ) : null}

      <BookReaderSections
        bookmarks={bookmarks}
        deletingBookmarkId={actions.deletingBookmarkId}
        onDeleteBookmark={actions.deleteBookmark}
        progressPercent={detail.progressPercent}
        readerAccess={readerAccess}
        readerState={readerState}
      />

      {canEditMetadata ? (
        <BookMetadataWorkspace
          editor={editor}
          metadataReviews={metadataReviews}
          metadataVersions={metadataVersions}
          onCreateMetadataReview={actions.createMetadataReview}
          onSaveMetadata={actions.saveMetadata}
          onSetEditor={setEditor}
          onSetReviewForm={setReviewForm}
          onUpdateMetadataReview={actions.updateMetadataReview}
          reviewForm={reviewForm}
          reviewUpdating={actions.reviewUpdating}
          savingMetadata={actions.savingMetadata}
          savingReview={actions.savingReview}
        />
      ) : null}

      {book.raw_provenance && Object.keys(book.raw_provenance).length ? (
        <section className="detail-card raw-provenance-card">
          <div className="section-title-block">
            <p className="eyebrow">Staff</p>
            <h2>Raw Provenance</h2>
          </div>
          <pre className="json-block raw-provenance-block">
            {JSON.stringify(book.raw_provenance, null, 2)}
          </pre>
        </section>
      ) : null}

      <ConfirmationDialog
        open={actions.deleteDialogOpen}
        title="Delete Book?"
        body={book ? `Delete "${book.title}"? This will hide it from the catalog.` : ""}
        confirmLabel="Delete Book"
        loading={actions.deleting}
        onCancel={() => {
          if (!actions.deleting) {
            actions.setDeleteDialogOpen(false);
          }
        }}
        onConfirm={actions.confirmDeleteBook}
      />
    </div>
  );
}
