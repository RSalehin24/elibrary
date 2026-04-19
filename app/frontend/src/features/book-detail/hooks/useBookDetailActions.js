import { useRef, useState } from "react";
import { apiFetch, resolveAppUrl } from "../../../api/client";
import { getPreviewLockKey, isPreviewLocked } from "../../../utils/previewLock";
import { launchBookReader } from "../readerLaunch";
import {
  openManagedPreviewWindow,
  waitForMinimumLoader,
  waitForUiFrame,
} from "../utils";

const previewWindows = new Map();

export function useBookDetailActions({
  book,
  currentDetailPath,
  detail,
  editor,
  fetchBook,
  htmlPreviewLockedByAssetId,
  navigate,
  refreshMetadataCollections,
  replaceBookRoute,
  returnTarget,
  reviewForm,
  setBook,
  setHtmlPreviewLockedByAssetId,
  setMetadataReviews,
  setReviewForm,
  slug,
  toast,
  user,
}) {
  const epubInputRef = useRef(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [launchingReader, setLaunchingReader] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [savingReview, setSavingReview] = useState(false);
  const [reviewUpdating, setReviewUpdating] = useState({ id: "", state: "" });
  const [deletingBookmarkId, setDeletingBookmarkId] = useState("");
  const [assetLoadingCounts, setAssetLoadingCounts] = useState({});
  const [pickingEpub, setPickingEpub] = useState(false);
  const [replacingEpub, setReplacingEpub] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [sendingToKindle, setSendingToKindle] = useState(false);

  function clearAssetLoading(assetId) {
    setAssetLoadingCounts((current) => {
      const nextCount = (current[assetId] || 1) - 1;
      if (nextCount > 0) {
        return {
          ...current,
          [assetId]: nextCount,
        };
      }
      const { [assetId]: _removed, ...rest } = current;
      return rest;
    });
  }

  async function launchReader() {
    if (launchingReader) {
      return;
    }

    try {
      setLaunchingReader(true);
      const startedAt = Date.now();
      await waitForUiFrame();
      await launchBookReader({
        slug,
        apiClient: apiFetch,
        navigate,
        resolveUrl: resolveAppUrl,
      });
      await waitForMinimumLoader(startedAt);
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
          const [name, role = "author"] = line
            .split("|")
            .map((part) => part.trim());
          return { name, role: role || "author" };
        });

      const payload = await apiFetch(`/catalog/books/${slug}/metadata/`, {
        method: "PATCH",
        body: {
          title: editor.title,
          summary: editor.summary,
          contributors,
          series: editor.series
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          categories: editor.categories
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          notes: editor.notes,
        },
      });
      setBook(payload);
      if (payload.slug && payload.slug !== slug) {
        replaceBookRoute(payload.slug);
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
      setBookmarks((current) =>
        current.filter((bookmark) => bookmark.id !== id),
      );
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
        body: reviewForm,
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
        body: { state },
      });
      setMetadataReviews((current) =>
        current.map((review) => (review.id === reviewId ? payload : review)),
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
    if (!book || deleting || detail.hasActiveProcessing) {
      return;
    }
    setDeleteDialogOpen(true);
  }

  async function confirmDeleteBook() {
    if (!book || deleting || detail.hasActiveProcessing) {
      return;
    }

    try {
      setDeleting(true);
      await apiFetch(`/catalog/books/${slug}/`, { method: "DELETE" });
      toast.success("Book deleted.");
      navigate(
        returnTarget && returnTarget !== currentDetailPath
          ? returnTarget
          : "/library",
        { replace: true },
      );
    } catch (nextError) {
      toast.error(nextError.message);
      setDeleting(false);
    }
  }

  function openEpubPicker() {
    if (pickingEpub || replacingEpub || regenerating || detail.hasActiveProcessing) {
      return;
    }
    setPickingEpub(true);
    const handleFocusBack = () => {
      setPickingEpub(false);
      window.removeEventListener("focus", handleFocusBack);
    };
    window.addEventListener("focus", handleFocusBack);
    epubInputRef.current?.click();
  }

  async function replaceEpub(event) {
    const file = event.target.files?.[0];
    if (!file) {
      setPickingEpub(false);
      return;
    }

    try {
      setPickingEpub(false);
      setReplacingEpub(true);
      const formData = new FormData();
      formData.append("file", file);
      const payload = await apiFetch(`/catalog/books/${slug}/assets/epub/`, {
        method: "POST",
        body: formData,
      });
      setBook(payload);
      if (payload.slug && payload.slug !== slug) {
        replaceBookRoute(payload.slug);
      }
      toast.success("EPUB updated.");
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      event.target.value = "";
      setReplacingEpub(false);
      setPickingEpub(false);
    }
  }

  async function regenerateBook() {
    if (!book || regenerating || detail.hasActiveProcessing) {
      return;
    }

    try {
      setRegenerating(true);
      const payload = await apiFetch(`/catalog/books/${slug}/regenerate/`, {
        method: "POST",
        body: {},
      });
      if (payload.book) {
        setBook(payload.book);
        if (payload.book.slug && payload.book.slug !== slug) {
          replaceBookRoute(payload.book.slug);
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

  async function downloadAsset(asset) {
    if (!asset?.download_url) {
      return;
    }
    if (asset.asset_type === "html" && htmlPreviewLockedByAssetId[asset.id]) {
      const previewKey = `${user?.id || "anon"}:${book?.id || slug}`;
      const existingWindow = previewWindows.get(previewKey);
      if (existingWindow && !existingWindow.closed) {
        existingWindow.focus();
      }
      toast.info("Preview is already open for this book.");
      return;
    }

    setAssetLoadingCounts((current) => ({
      ...current,
      [asset.id]: (current[asset.id] || 0) + 1,
    }));

    try {
      const startedAt = Date.now();
      await waitForUiFrame();
      const previewUrl = resolveAppUrl(asset.download_url);
      if (asset.asset_type === "html") {
        const lockKey = getPreviewLockKey(previewUrl);
        if (lockKey && isPreviewLocked(lockKey)) {
          toast.info("Preview is already open for this book.");
          return;
        }

        const previewKey = `${user?.id || "anon"}:${book?.id || slug}`;
        const existingWindow = previewWindows.get(previewKey);

        if (existingWindow && !existingWindow.closed) {
          existingWindow.focus();
          toast.info("Preview is already open for this book.");
        } else {
          const target = `html_preview_${user?.id || "anon"}_${book?.id || slug}`;
          const openedWindow = openManagedPreviewWindow(previewUrl, target);
          if (openedWindow) {
            previewWindows.set(previewKey, openedWindow);
            openedWindow.focus();
            setHtmlPreviewLockedByAssetId((current) => ({
              ...current,
              [asset.id]: true,
            }));
          } else {
            toast.error(
              "Preview window could not be opened. Please allow popups.",
            );
          }
        }
      } else {
        window.open(previewUrl, "_blank", "noopener,noreferrer");
      }
      await waitForMinimumLoader(startedAt, 420);
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      clearAssetLoading(asset.id);
    }
  }

  async function sendToKindle() {
    if (!book || !detail.epubAsset || sendingToKindle) {
      return;
    }

    try {
      setSendingToKindle(true);
      const payload = await apiFetch(`/access/books/${slug}/send-to-kindle/`, {
        method: "POST",
        body: {},
      });
      toast.success(payload?.detail || "Sent to Kindle.");
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setSendingToKindle(false);
    }
  }

  return {
    assetLoadingCounts,
    confirmDeleteBook,
    createMetadataReview,
    deleteBookmark,
    deleteDialogOpen,
    deleting,
    deletingBookmarkId,
    downloadAsset,
    epubInputRef,
    launchReader,
    launchingReader,
    openEpubPicker,
    pickingEpub,
    regenerateBook,
    regenerating,
    replaceEpub,
    replacingEpub,
    requestDeleteBook,
    reviewUpdating,
    savingMetadata,
    savingReview,
    sendToKindle,
    sendingToKindle,
    saveMetadata,
    setDeleteDialogOpen,
    updateMetadataReview,
  };
}
