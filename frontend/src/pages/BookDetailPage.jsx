import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiFetch, resolveAppUrl } from "../api/client";
import BookCoverArt from "../components/BookCoverArt";
import ConfirmationDialog from "../components/ConfirmationDialog";
import BookDetailSkeleton from "../components/BookDetailSkeleton";
import LoadingSpinner from "../components/LoadingSpinner";
import StatusPill from "../components/StatusPill";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import {
  formatBookDateTime,
  getContributorGroups,
  getPrimaryContributorGroup,
  getSourceLabel,
  getStatusMeta
} from "../utils/bookPresentation";
import { hasCapability } from "../utils/capabilities";
import { toQueryString } from "../utils/query";

const assetLabels = {
  html: "Preview HTML",
  epub: "Download EPUB",
  cover: "Download cover"
};

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
      <path
        d="M9 3.75h6a1 1 0 0 1 1 1V6h3a.75.75 0 0 1 0 1.5h-1.1l-.79 10.28A2.5 2.5 0 0 1 14.62 20H9.38a2.5 2.5 0 0 1-2.49-2.22L6.1 7.5H5a.75.75 0 0 1 0-1.5h3V4.75a1 1 0 0 1 1-1Zm5.5 2.25v-.75h-5V6h5Zm-6.9 1.5.78 10.17a1 1 0 0 0 1 .83h5.24a1 1 0 0 0 1-.83l.78-10.17Zm2.4 2.25c.41 0 .75.34.75.75v4.5a.75.75 0 0 1-1.5 0v-4.5c0-.41.34-.75.75-.75Zm4 0c.41 0 .75.34.75.75v4.5a.75.75 0 0 1-1.5 0v-4.5c0-.41.34-.75.75-.75Z"
        fill="currentColor"
      />
    </svg>
  );
}

function RefreshIcon({ spinning = false }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
      className={spinning ? "icon-spin" : ""}
    >
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

function renderTocSummary(toc) {
  return (
    <div className="toc-record-list">
      {toc.map((entry, index) => (
        <article key={`${entry.title || "section"}-${index}`} className="toc-record-card">
          <strong>{entry.title || `Section ${index + 1}`}</strong>
          {entry.children?.length ? (
            <p>{entry.children.map((child) => child.title).filter(Boolean).join(" • ")}</p>
          ) : (
            <p>{entry.type === "topic" ? "Topic" : "Section"}</p>
          )}
        </article>
      ))}
    </div>
  );
}

function renderFilterLinks(values, queryKey, emptyLabel = "", extraFilters = {}) {
  if (!values?.length) {
    return emptyLabel || null;
  }

  return values.map((value, index) => (
    <Fragment key={`${queryKey}-${value}`}>
      <Link to={`/library${toQueryString({ ...extraFilters, [queryKey]: value })}`} className="meta-link">
        {value}
      </Link>
      {index < values.length - 1 ? <span className="meta-divider">, </span> : null}
    </Fragment>
  ));
}

function normalizeIdentityLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeFrontMatterEntries(entries, bookIdValue) {
  if (!entries?.length) {
    return [];
  }

  let replacedIdentity = false;

  return entries.reduce((normalizedEntries, entry) => {
    const normalizedLabel = normalizeIdentityLabel(entry.label);
    const normalizedKey = normalizeIdentityLabel(entry.key);
    const isIdentityEntry = ["unique id", "book id", "catalog code", "catalog id", "id"].includes(normalizedLabel)
      || ["unique id", "book id", "catalog code", "catalog id", "id"].includes(normalizedKey);

    if (isIdentityEntry) {
      if (!replacedIdentity) {
        normalizedEntries.push({
          ...entry,
          key: "book_id",
          label: "Book ID",
          value: bookIdValue
        });
        replacedIdentity = true;
      }
      return normalizedEntries;
    }

    normalizedEntries.push(entry);
    return normalizedEntries;
  }, []);
}

export default function BookDetailPage() {
  const navigate = useNavigate();
  const { user } = useSession();
  const toast = useToast();
  const { slug } = useParams();
  const epubInputRef = useRef(null);
  const [book, setBook] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState({
    title: "",
    summary: "",
    contributors: "",
    series: "",
    categories: "",
    notes: ""
  });
  const [metadataVersions, setMetadataVersions] = useState([]);
  const [metadataReviews, setMetadataReviews] = useState([]);
  const [reviewForm, setReviewForm] = useState({ state: "pending", notes: "" });
  const [readerState, setReaderState] = useState({
    last_location: "",
    progress_percent: 0,
    last_opened_at: ""
  });
  const [readerAccess, setReaderAccess] = useState(false);
  const [bookmarks, setBookmarks] = useState([]);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [launchingReader, setLaunchingReader] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [savingReview, setSavingReview] = useState(false);
  const [reviewUpdating, setReviewUpdating] = useState({ id: "", state: "" });
  const [deletingBookmarkId, setDeletingBookmarkId] = useState("");
  const [replacingEpub, setReplacingEpub] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const canEditMetadata = hasCapability(user, "metadata:edit");
  const bookLinkFilters = book?.record_type === "manual" ? { record_type: "manual" } : {};

  function applyReaderState(sessionPayload) {
    if (sessionPayload) {
      setReaderAccess(true);
      setReaderState({
        last_location: sessionPayload.last_location || "",
        progress_percent: sessionPayload.progress_percent || 0,
        last_opened_at: sessionPayload.last_opened_at || ""
      });
      return;
    }

    setReaderAccess(false);
    setReaderState({ last_location: "", progress_percent: 0, last_opened_at: "" });
  }

  async function fetchBook(targetSlug = slug) {
    const payload = await apiFetch(`/catalog/books/${targetSlug}/`);
    setBook(payload);
    setError("");
    if (payload.slug && payload.slug !== targetSlug) {
      navigate(`/books/${payload.slug}`, { replace: true });
    }
    return payload;
  }

  async function refreshMetadataCollections(targetSlug = slug) {
    if (!canEditMetadata) {
      setMetadataVersions([]);
      setMetadataReviews([]);
      return;
    }

    const [versionsPayload, reviewsPayload] = await Promise.all([
      apiFetch(`/catalog/books/${targetSlug}/metadata-versions/`),
      apiFetch(`/catalog/books/${targetSlug}/metadata-reviews/`)
    ]);
    setMetadataVersions(versionsPayload);
    setMetadataReviews(reviewsPayload);
  }

  async function fetchReaderCollections(targetSlug = slug) {
    const [sessionPayload, bookmarkPayload] = await Promise.all([
      apiFetch(`/access/books/${targetSlug}/reading-session/`).catch((nextError) => {
        if ([401, 403].includes(nextError.status)) {
          return null;
        }
        throw nextError;
      }),
      apiFetch(`/access/books/${targetSlug}/bookmarks/`).catch((nextError) => {
        if ([401, 403].includes(nextError.status)) {
          return [];
        }
        throw nextError;
      })
    ]);

    return { sessionPayload, bookmarkPayload };
  }

  useEffect(() => {
    let active = true;

    async function loadBook() {
      try {
        setLoading(true);
        await fetchBook(slug);
      } catch (nextError) {
        if (active) {
          setError(nextError.message);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadBook();

    return () => {
      active = false;
    };
  }, [slug]);

  useEffect(() => {
    if (!book) {
      return;
    }
    setEditor({
      title: book.title || "",
      summary: book.summary || "",
      contributors: (book.contributors || []).map((entry) => `${entry.name}|${entry.role}`).join("\n"),
      series: (book.series || []).join(", "),
      categories: (book.categories || []).join(", "),
      notes: ""
    });
  }, [book]);

  useEffect(() => {
    if (!book || !user) {
      setMetadataVersions([]);
      setMetadataReviews([]);
      setBookmarks([]);
      applyReaderState(null);
      return;
    }

    let active = true;

    async function loadSupplementalData() {
      try {
        const requests = [fetchReaderCollections(slug)];

        if (canEditMetadata) {
          requests.push(
            Promise.all([
              apiFetch(`/catalog/books/${slug}/metadata-versions/`).catch((nextError) => {
                if ([401, 403].includes(nextError.status)) {
                  return [];
                }
                throw nextError;
              }),
              apiFetch(`/catalog/books/${slug}/metadata-reviews/`).catch((nextError) => {
                if ([401, 403].includes(nextError.status)) {
                  return [];
                }
                throw nextError;
              })
            ])
          );
        }

        const [{ sessionPayload, bookmarkPayload }, metadataPayload = [[], []]] = await Promise.all(requests);
        if (!active) {
          return;
        }

        applyReaderState(sessionPayload);
        setBookmarks(bookmarkPayload);
        setMetadataVersions(metadataPayload[0] || []);
        setMetadataReviews(metadataPayload[1] || []);
      } catch (nextError) {
        if (active) {
          toast.error(nextError.message);
        }
      }
    }

    loadSupplementalData();

    return () => {
      active = false;
    };
  }, [book?.id, slug, user?.id, canEditMetadata]);

  useEffect(() => {
    const nextJob = book?.latest_processing_job;
    if (!nextJob || !["queued", "processing"].includes(nextJob.status)) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      fetchBook(slug).catch(() => {});
    }, 4000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [book?.latest_processing_job?.id, book?.latest_processing_job?.status, slug]);

  async function launchReader() {
    if (launchingReader) {
      return;
    }

    try {
      setLaunchingReader(true);
      const payload = await apiFetch(`/access/books/${slug}/reader-launch/`, {
        method: "POST",
        body: {}
      });
      window.open(resolveAppUrl(payload.launch_url), "_blank", "noopener,noreferrer");
      const { sessionPayload, bookmarkPayload } = await fetchReaderCollections(slug);
      applyReaderState(sessionPayload);
      setBookmarks(bookmarkPayload);
      toast.success("Reader opened.");
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setLaunchingReader(false);
    }
  }

  async function saveMetadata(event) {
    event.preventDefault();
    if (savingMetadata) {
      return;
    }

    try {
      setSavingMetadata(true);
      const contributors = editor.contributors
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, role = "author"] = line.split("|").map((part) => part.trim());
          return { name, role: role || "author" };
        });

      const payload = await apiFetch(`/catalog/books/${slug}/metadata/`, {
        method: "PATCH",
        body: {
          title: editor.title,
          summary: editor.summary,
          contributors,
          series: editor.series.split(",").map((value) => value.trim()).filter(Boolean),
          categories: editor.categories.split(",").map((value) => value.trim()).filter(Boolean),
          notes: editor.notes
        }
      });
      setBook(payload);
      if (payload.slug && payload.slug !== slug) {
        navigate(`/books/${payload.slug}`, { replace: true });
      }
      await refreshMetadataCollections(payload.slug || slug);
      toast.success("Metadata updated.");
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setSavingMetadata(false);
    }
  }

  async function deleteBookmark(id) {
    if (deletingBookmarkId) {
      return;
    }

    try {
      setDeletingBookmarkId(id);
      await apiFetch(`/access/bookmarks/${id}/`, { method: "DELETE" });
      setBookmarks((current) => current.filter((bookmark) => bookmark.id !== id));
      toast.success("Bookmark removed.");
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setDeletingBookmarkId("");
    }
  }

  async function createMetadataReview(event) {
    event.preventDefault();
    if (savingReview) {
      return;
    }

    try {
      setSavingReview(true);
      const payload = await apiFetch(`/catalog/books/${slug}/metadata-reviews/`, {
        method: "POST",
        body: reviewForm
      });
      setMetadataReviews((current) => [payload, ...current]);
      setReviewForm({ state: "pending", notes: "" });
      await fetchBook(slug);
      toast.success("Review saved.");
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setSavingReview(false);
    }
  }

  async function updateMetadataReview(reviewId, state) {
    if (reviewUpdating.id) {
      return;
    }

    try {
      setReviewUpdating({ id: reviewId, state });
      const payload = await apiFetch(`/catalog/metadata-reviews/${reviewId}/`, {
        method: "PATCH",
        body: { state }
      });
      setMetadataReviews((current) =>
        current.map((review) => (review.id === reviewId ? payload : review))
      );
      await fetchBook(slug);
      toast.success("Review updated.");
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setReviewUpdating({ id: "", state: "" });
    }
  }

  function requestDeleteBook() {
    if (!book || deleting || hasActiveProcessing) {
      return;
    }
    setDeleteDialogOpen(true);
  }

  async function confirmDeleteBook() {
    if (!book || deleting || hasActiveProcessing) {
      return;
    }

    try {
      setDeleting(true);
      await apiFetch(`/catalog/books/${slug}/`, { method: "DELETE" });
      toast.success("Book deleted.");
      navigate("/library", { replace: true });
    } catch (nextError) {
      toast.error(nextError.message);
      setDeleting(false);
    }
  }

  function openEpubPicker() {
    if (replacingEpub || regenerating || hasActiveProcessing) {
      return;
    }
    epubInputRef.current?.click();
  }

  async function replaceEpub(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      setReplacingEpub(true);
      const formData = new FormData();
      formData.append("file", file);
      const payload = await apiFetch(`/catalog/books/${slug}/assets/epub/`, {
        method: "POST",
        body: formData
      });
      setBook(payload);
      if (payload.slug && payload.slug !== slug) {
        navigate(`/books/${payload.slug}`, { replace: true });
      }
      toast.success("EPUB updated.");
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      event.target.value = "";
      setReplacingEpub(false);
    }
  }

  async function regenerateBook() {
    if (!book || regenerating || hasActiveProcessing) {
      return;
    }

    try {
      setRegenerating(true);
      const payload = await apiFetch(`/catalog/books/${slug}/regenerate/`, {
        method: "POST",
        body: {}
      });
      if (payload.book) {
        setBook(payload.book);
        if (payload.book.slug && payload.book.slug !== slug) {
          navigate(`/books/${payload.book.slug}`, { replace: true });
        }
      }

      if (!payload.created) {
        toast.success("Book regeneration is already in progress.");
      } else if (payload.job?.status === "succeeded") {
        toast.success("Book regenerated.");
      } else {
        toast.success("Book regeneration started.");
      }
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setRegenerating(false);
    }
  }

  if (loading) {
    return <BookDetailSkeleton />;
  }

  if (error) {
    return <div className="page-state page-state-error">{error}</div>;
  }

  const sourceRecords = book.source_records?.length
    ? book.source_records
    : (book.source_urls || []).map((url) => ({
        url,
        display_url: decodeURIComponent(url),
        display_path: decodeURIComponent(url).replace(/^https?:\/\/[^/]+\//, ""),
        source_title: "",
        site: "",
        is_primary: false
      }));
  const contributorGroups = getContributorGroups(book);
  const primaryContributorGroup = getPrimaryContributorGroup(book);
  const supportingContributorGroups = contributorGroups.filter((group) => group.role !== primaryContributorGroup?.role);
  const bookIdValue = book.catalog_code || "Pending";
  const frontMatter = normalizeFrontMatterEntries(book.front_matter || [], bookIdValue);
  const hasFrontMatter = Boolean(frontMatter.length || book.book_info_html?.trim());
  const hasDedication = Boolean(book.dedication_html?.trim());
  const hasToc = Boolean(book.toc?.length);
  const progressPercent = Math.max(0, Math.min(100, Math.round(Number(readerState.progress_percent) || 0)));
  const latestProcessingJob = book.latest_processing_job || null;
  const hasActiveProcessing = Boolean(
    latestProcessingJob && ["queued", "processing"].includes(latestProcessingJob.status)
  );
  const hasFailedProcessing = latestProcessingJob?.status === "failed";
  const epubAsset = (book.assets || []).find((asset) => asset.asset_type === "epub");
  const downloadableAssets = (book.assets || []).filter((asset) => asset.download_url);
  const processingHeading =
    latestProcessingJob?.job_type === "reprocess" ? "Regenerating book" : "Processing book";
  const processingBody = hasFailedProcessing
    ? latestProcessingJob?.last_error || "The latest processing job failed."
    : hasActiveProcessing
      ? "New book files are being prepared. This page refreshes automatically while the job is running."
      : "";

  return (
    <div className="book-detail-page page-stack">
      <section className="detail-card book-hero">
        {canEditMetadata ? (
          <div className="book-hero-controls">
            <button
              type="button"
              className="book-refresh-control"
              onClick={regenerateBook}
              aria-label={hasActiveProcessing ? "Book regeneration in progress" : "Regenerate book"}
              title={hasActiveProcessing ? "Book regeneration in progress" : "Regenerate book"}
              disabled={regenerating || hasActiveProcessing}
            >
              <RefreshIcon spinning={regenerating || hasActiveProcessing} />
            </button>
            <button
              type="button"
              className="book-delete-control"
              onClick={requestDeleteBook}
              aria-label={deleting ? "Deleting book" : "Delete book"}
              title={deleting ? "Deleting book" : "Delete book"}
              disabled={deleting || hasActiveProcessing}
            >
              {deleting ? <LoadingSpinner size={18} /> : <TrashIcon />}
            </button>
          </div>
        ) : null}

        <div className="book-hero-cover">
          <BookCoverArt book={book} className="book-cover-large book-hero-placeholder" ariaHidden />
        </div>

        <div className="book-hero-copy">
          <strong className="book-hero-id">{bookIdValue}</strong>
          <h1>{book.title}</h1>
          {primaryContributorGroup ? (
            primaryContributorGroup.role === "author" ? (
              <p className="detail-lead">
                {renderFilterLinks(primaryContributorGroup.names, "author", "Contributor unavailable", bookLinkFilters)}
              </p>
            ) : (
              <p className="detail-meta-row detail-lead-row">
                <span className="fact-label">{primaryContributorGroup.label}</span>
                <span className="detail-meta-values">
                  {renderFilterLinks(primaryContributorGroup.names, "contributor", "Contributor unavailable", bookLinkFilters)}
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

          {supportingContributorGroups.length || book.series?.length || book.categories?.length ? (
            <div className="book-meta-stack">
              {supportingContributorGroups.map((group) => (
                <p key={group.role} className="detail-meta-row">
                  <span className="fact-label">{group.label}</span>
                  <span className="detail-meta-values">
                    {renderFilterLinks(
                      group.names,
                      group.role === "author" ? "author" : "contributor",
                      "",
                      bookLinkFilters
                    )}
                  </span>
                </p>
              ))}
              {book.series?.length ? (
                <p className="detail-meta-row">
                  <span className="fact-label">Series</span>
                  <span className="detail-meta-values">{renderFilterLinks(book.series, "series", "", bookLinkFilters)}</span>
                </p>
              ) : null}
              {book.categories?.length ? (
                <p className="detail-meta-row">
                  <span className="fact-label">Categories</span>
                  <span className="detail-meta-values">{renderFilterLinks(book.categories, "category", "", bookLinkFilters)}</span>
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="book-hero-actions">
            <button type="button" className="primary-button" onClick={launchReader} disabled={launchingReader}>
              <span className="button-label">
                {launchingReader ? <LoadingSpinner size={16} /> : null}
                {launchingReader ? "Opening..." : "Open reader"}
              </span>
            </button>
            {downloadableAssets.map((asset) => (
              <a
                key={asset.id}
                className="ghost-button asset-link"
                href={resolveAppUrl(asset.download_url)}
                target="_blank"
                rel="noreferrer"
              >
                {assetLabels[asset.asset_type] || `Download ${asset.asset_type.toUpperCase()}`}
              </a>
            ))}
            {canEditMetadata ? (
              <>
                <input
                  ref={epubInputRef}
                  type="file"
                  accept=".epub,application/epub+zip"
                  hidden
                  onChange={replaceEpub}
                />
                <button
                  type="button"
                  className="ghost-button"
                  onClick={openEpubPicker}
                  disabled={replacingEpub || regenerating || hasActiveProcessing}
                >
                  <span className="button-label">
                    {replacingEpub ? <LoadingSpinner size={16} /> : null}
                    {replacingEpub ? "Uploading..." : epubAsset ? "Replace EPUB" : "Upload EPUB"}
                  </span>
                </button>
              </>
            ) : null}
          </div>

          {latestProcessingJob && (hasActiveProcessing || hasFailedProcessing) ? (
            <div
              className={`book-status-note${hasActiveProcessing ? " book-status-note-processing" : ""}${
                hasFailedProcessing ? " book-status-note-error" : ""
              }`}
            >
              <div className="book-status-note-head">
                <span className="fact-label">Processing</span>
                {hasActiveProcessing ? <LoadingSpinner size={14} /> : null}
              </div>
              <strong>{processingHeading}</strong>
              <p>{processingBody}</p>
            </div>
          ) : null}
        </div>
      </section>

      {sourceRecords.length ? (
        <section className="detail-card">
          <div className="panel-header">
            <div className="section-title-block">
              <p className="eyebrow">Source</p>
              <h2>Source Records</h2>
            </div>
          </div>
          <div className="source-record-list">
            {sourceRecords.map((source, index) => (
              <article key={`${source.url}-${index}`} className="source-record-card">
                <div className="source-record-copy">
                  <span className="fact-label">{source.is_primary ? "Primary" : "Linked"}</span>
                  <strong>{getSourceLabel(source) || "Source page"}</strong>
                  <a className="source-link" href={source.url} target="_blank" rel="noreferrer">
                    {source.display_url || source.url}
                  </a>
                </div>
                <a className="ghost-button" href={source.url} target="_blank" rel="noreferrer">
                  Open
                </a>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {hasFrontMatter ? (
        <section className="detail-card">
          <div className="section-title-block">
            <p className="eyebrow">Extracted</p>
            <h2>Book Details</h2>
          </div>
          {frontMatter.length ? (
            <div className="metadata-list">
              {frontMatter.map((entry) => (
                <div key={`${entry.key}-${entry.value}`} className="metadata-row">
                  <span className="fact-label">{entry.label}</span>
                  <strong className="metadata-value">{entry.value}</strong>
                </div>
              ))}
            </div>
          ) : (
            <div className="rich-content-block" dangerouslySetInnerHTML={{ __html: book.book_info_html }} />
          )}
        </section>
      ) : null}

      {hasDedication ? (
        <section className="detail-card">
          <div className="section-title-block">
            <p className="eyebrow">Extracted</p>
            <h2>Dedication</h2>
          </div>
          <div className="rich-content-block" dangerouslySetInnerHTML={{ __html: book.dedication_html }} />
        </section>
      ) : null}

      {hasToc ? (
        <section className="detail-card">
          <div className="section-title-block">
            <p className="eyebrow">Structure</p>
            <h2>Table of Contents</h2>
          </div>
          {renderTocSummary(book.toc || [])}
        </section>
      ) : null}

      <section className="book-detail-grid">
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
                <strong className="metadata-value">{readerState.last_location || "Not synced"}</strong>
              </article>
              <article className="book-detail-chip">
                <span className="fact-label">Last opened</span>
                <strong>{readerState.last_opened_at ? formatBookDateTime(readerState.last_opened_at) : "Not synced"}</strong>
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
                      <button type="button" className="ghost-button" onClick={() => deleteBookmark(bookmark.id)}>
                        <span className="button-label">
                          {deletingBookmarkId === bookmark.id ? <LoadingSpinner size={14} /> : null}
                          {deletingBookmarkId === bookmark.id ? "Removing..." : "Remove"}
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

      {canEditMetadata ? (
        <section className="detail-card">
          <div className="section-title-block">
            <p className="eyebrow">Editorial</p>
            <h2>Metadata Workspace</h2>
          </div>

          <div className="book-admin-grid">
            <form className="stack-form metadata-form" onSubmit={saveMetadata}>
              <div className="metadata-form-grid">
                <label className="field-span-full">
                  <span>Title</span>
                  <input value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} />
                </label>
                <label className="field-span-full">
                  <span>Summary</span>
                  <textarea
                    rows="4"
                    value={editor.summary}
                    onChange={(event) => setEditor({ ...editor, summary: event.target.value })}
                  />
                </label>
                <label className="field-span-full">
                  <span>Contributors</span>
                  <textarea
                    rows="5"
                    value={editor.contributors}
                    onChange={(event) => setEditor({ ...editor, contributors: event.target.value })}
                    placeholder="Name|author"
                  />
                </label>
                <label>
                  <span>Series</span>
                  <input value={editor.series} onChange={(event) => setEditor({ ...editor, series: event.target.value })} />
                </label>
                <label>
                  <span>Categories</span>
                  <input
                    value={editor.categories}
                    onChange={(event) => setEditor({ ...editor, categories: event.target.value })}
                  />
                </label>
                <label className="field-span-full">
                  <span>Edit note</span>
                  <input value={editor.notes} onChange={(event) => setEditor({ ...editor, notes: event.target.value })} />
                </label>
              </div>
              <button type="submit" className="primary-button" disabled={savingMetadata}>
                <span className="button-label">
                  {savingMetadata ? <LoadingSpinner size={16} /> : null}
                  {savingMetadata ? "Saving..." : "Save metadata"}
                </span>
              </button>
            </form>

            <section className="stack-form editorial-panel">
              <form className="stack-form" onSubmit={createMetadataReview}>
                <div className="section-title-block">
                  <h3>Review</h3>
                </div>
                <label>
                  <span>Review state</span>
                  <select value={reviewForm.state} onChange={(event) => setReviewForm({ ...reviewForm, state: event.target.value })}>
                    <option value="pending">Awaiting review</option>
                    <option value="needs_review">Needs review</option>
                    <option value="approved">Reviewed</option>
                    <option value="rejected">Needs correction</option>
                  </select>
                </label>
                <label>
                  <span>Notes</span>
                  <input value={reviewForm.notes} onChange={(event) => setReviewForm({ ...reviewForm, notes: event.target.value })} />
                </label>
                <button type="submit" className="ghost-button" disabled={savingReview}>
                  <span className="button-label">
                    {savingReview ? <LoadingSpinner size={16} /> : null}
                    {savingReview ? "Saving..." : "Save review"}
                  </span>
                </button>
              </form>
            </section>

            <section className="stack-form editorial-panel">
              <div className="section-title-block">
                <h3>Metadata History</h3>
              </div>
              <div className="queue-list">
                {metadataVersions.length ? (
                  metadataVersions.map((version) => (
                    <article key={version.id} className="queue-card">
                      <strong>{version.source}</strong>
                      <p>{version.notes || "No notes"}</p>
                      <p>{formatBookDateTime(version.created_at)}</p>
                    </article>
                  ))
                ) : (
                  <p className="muted-copy">No history yet.</p>
                )}
              </div>
            </section>

            <section className="stack-form editorial-panel">
              <div className="section-title-block">
                <h3>Review Log</h3>
              </div>
              <div className="queue-list">
                {metadataReviews.length ? (
                  metadataReviews.map((review) => (
                    <article key={review.id} className="queue-card">
                      <strong>{getStatusMeta(review.state).label}</strong>
                      <p>{review.notes || "No notes"}</p>
                      <p>
                        {review.requested_by_email || "Unknown"}
                        {review.updated_at ? ` · ${formatBookDateTime(review.updated_at)}` : ""}
                      </p>
                      <div className="inline-pills">
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => updateMetadataReview(review.id, "approved")}
                          disabled={Boolean(reviewUpdating.id)}
                        >
                          <span className="button-label">
                            {reviewUpdating.id === review.id && reviewUpdating.state === "approved" ? (
                              <LoadingSpinner size={14} />
                            ) : null}
                            {reviewUpdating.id === review.id && reviewUpdating.state === "approved" ? "Approving..." : "Approve"}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => updateMetadataReview(review.id, "rejected")}
                          disabled={Boolean(reviewUpdating.id)}
                        >
                          <span className="button-label">
                            {reviewUpdating.id === review.id && reviewUpdating.state === "rejected" ? (
                              <LoadingSpinner size={14} />
                            ) : null}
                            {reviewUpdating.id === review.id && reviewUpdating.state === "rejected" ? "Rejecting..." : "Reject"}
                          </span>
                        </button>
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="muted-copy">No reviews yet.</p>
                )}
              </div>
            </section>
          </div>
        </section>
      ) : null}

      {book.raw_provenance && Object.keys(book.raw_provenance).length ? (
        <section className="detail-card raw-provenance-card">
          <div className="section-title-block">
            <p className="eyebrow">Staff</p>
            <h2>Raw Provenance</h2>
          </div>
          <pre className="json-block raw-provenance-block">{JSON.stringify(book.raw_provenance, null, 2)}</pre>
        </section>
      ) : null}

      <ConfirmationDialog
        open={deleteDialogOpen}
        title="Delete Book?"
        body={book ? `Delete "${book.title}"? This will hide it from the catalog.` : ""}
        confirmLabel="Delete Book"
        loading={deleting}
        onCancel={() => {
          if (!deleting) {
            setDeleteDialogOpen(false);
          }
        }}
        onConfirm={confirmDeleteBook}
      />
    </div>
  );
}
