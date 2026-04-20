import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router-dom";
import { apiFetch, resolveApiUrl } from "../../api/client";
import { useSession } from "../../hooks/useSession";
import { useToast } from "../../hooks/useToast";
import { hasCapability } from "../../utils/capabilities";

const ProcessingPagesContext = createContext(null);
const PROCESSING_ROUTE_PATHS = new Set([
  "/catalog",
  "/create",
  "/on-hold",
  "/incomplete",
]);
const PROCESSING_SYNC_SCOPE_CATALOG = "catalog";
const PROCESSING_SYNC_SCOPE_INCOMPLETE = "incomplete";
const PROCESSING_CARD_KEYS = [
  "catalog-overview",
  "catalog-sync",
  "catalog-automation",
  "catalog-records",
  "create-overview",
  "create-requests",
  "create-queue",
  "create-processing",
  "create-created",
  "on-hold-overview",
  "on-hold-paused",
  "on-hold-failed",
  "on-hold-duplicate",
  "on-hold-deleted",
  "incomplete-overview",
  "incomplete-automation",
  "incomplete-records",
  "incomplete-completed",
];

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function scopedSyncPath(scope, action) {
  return `/processing/sync/${scope}/${action}/`;
}

function isCatalogRemotePage(page) {
  return (
    Array.isArray(page) &&
    page.every(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item),
    )
  );
}

function catalogRemotePages(remotePages) {
  if (
    Array.isArray(remotePages) &&
    remotePages.every((page) => isCatalogRemotePage(page))
  ) {
    return remotePages;
  }
  return [];
}

function processingPath(path) {
  return path.includes("?") ? `${path}&includeLists=0` : `${path}?includeLists=0`;
}

function normalizeTargets(targets) {
  if (Array.isArray(targets) && targets.length > 0) {
    return Array.from(new Set(targets.filter(Boolean)));
  }
  return [...PROCESSING_CARD_KEYS];
}

function notifyRequestAction(toast, action, changedCount, options = {}) {
  if (!changedCount) {
    toast.info({
      title: "No changes applied",
      description: "The selected rows were already in the requested state.",
    });
    return;
  }

  if (action === "delete") {
    toast.success({
      title: options.deleteBook ? "Book deleted" : "Request deleted",
      description: options.deleteBook
        ? `${countLabel(changedCount, "request")} moved to Deleted and removed the linked book.`
        : `${countLabel(changedCount, "request")} moved to Deleted.`,
    });
    return;
  }

  const copy = {
    pause: {
      title: "Request paused",
      description: `${countLabel(changedCount, "request")} saved progress and moved to On Hold.`,
      type: "info",
    },
    resume: {
      title: "Request resumed",
      description: `${countLabel(changedCount, "request")} returned to Requests.`,
      type: "success",
    },
    retry: {
      title: "Retry started",
      description: `${countLabel(changedCount, "request")} returned to Requests.`,
      type: "success",
    },
    new: {
      title: "Marked as new",
      description: `${countLabel(changedCount, "request")} will continue without duplicate locking.`,
      type: "success",
    },
    confirm_duplicate: {
      title: "Duplicate confirmed",
      description: `${countLabel(changedCount, "request")} will stay locked to the original until it becomes terminal.`,
      type: "info",
    },
    create_again: {
      title: "Request recreated",
      description: `${countLabel(changedCount, "request")} returned to Requests.`,
      type: "success",
    },
    recreate: {
      title: "Request recreated",
      description: `${countLabel(changedCount, "request")} returned to Requests.`,
      type: "success",
    },
  }[action];

  if (!copy) {
    return;
  }

  toast[copy.type]({
    title: copy.title,
    description: copy.description,
  });
}

export function BookProcessingProvider({ children }) {
  const [busyCards, setBusyCards] = useState({});
  const [streamMode, setStreamMode] = useState("idle");
  const [cardRefreshTokens, setCardRefreshTokens] = useState({});
  const eventSourceRef = useRef(null);
  const location = useLocation();
  const { authenticated, loading, user } = useSession();
  const toast = useToast();
  const canLoadProcessingState =
    authenticated && !loading && hasCapability(user, "processing:manage");
  const onProcessingPage = PROCESSING_ROUTE_PATHS.has(location.pathname);

  const invalidateProcessingTargets = useCallback((targets) => {
    const nextTargets = normalizeTargets(targets);
    setCardRefreshTokens((current) => {
      const next = { ...current };
      nextTargets.forEach((target) => {
        next[target] = (next[target] || 0) + 1;
      });
      return next;
    });
  }, []);

  const getCardRefreshToken = useCallback(
    (cardKey) => cardRefreshTokens[cardKey] || 0,
    [cardRefreshTokens],
  );

  useEffect(() => {
    if (canLoadProcessingState) {
      return undefined;
    }
    setCardRefreshTokens({});
    setStreamMode("idle");
    return undefined;
  }, [canLoadProcessingState]);

  const runCardAction = useCallback(
    async (cardId, request, options = {}) => {
      setBusyCards((current) => ({
        ...current,
        [cardId]: (current[cardId] || 0) + 1,
      }));
      try {
        const payload = await request();
        invalidateProcessingTargets(
          payload?.targets || options.invalidateTargets || [cardId],
        );
        if (typeof options.onSuccess === "function") {
          options.onSuccess(payload, toast);
        }
        return payload;
      } catch (actionError) {
        const message =
          options.errorMessage ||
          actionError.message ||
          "Unable to complete the action.";
        if (![401, 403].includes(actionError?.status)) {
          toast.error(message);
        }
        return null;
      } finally {
        setBusyCards((current) => {
          const currentCount = current[cardId] || 0;
          const next = { ...current };
          if (currentCount > 1) {
            next[cardId] = currentCount - 1;
          } else {
            delete next[cardId];
          }
          return next;
        });
      }
    },
    [invalidateProcessingTargets, toast],
  );

  useEffect(() => {
    if (
      !onProcessingPage ||
      !canLoadProcessingState ||
      typeof window === "undefined"
    ) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setStreamMode("idle");
      return undefined;
    }

    if (typeof EventSource === "undefined") {
      setStreamMode("unsupported");
      return undefined;
    }

    let disposed = false;
    const nextSource = new EventSource(
      resolveApiUrl("/processing/stream/?includeLists=0"),
      {
        withCredentials: true,
      },
    );
    eventSourceRef.current = nextSource;
    setStreamMode("connecting");

    const handlePayload = (event) => {
      if (disposed || eventSourceRef.current !== nextSource) {
        return;
      }
      try {
        const payload = JSON.parse(event.data || "{}");
        invalidateProcessingTargets(payload.targets);
      } catch {
        invalidateProcessingTargets(PROCESSING_CARD_KEYS);
      }
    };

    nextSource.addEventListener("connected", () => {
      if (disposed || eventSourceRef.current !== nextSource) {
        return;
      }
      setStreamMode("connected");
    });
    nextSource.addEventListener("invalidation", handlePayload);
    nextSource.addEventListener("state", handlePayload);
    nextSource.addEventListener("snapshot", handlePayload);
    nextSource.onerror = () => {
      if (disposed || eventSourceRef.current !== nextSource) {
        return;
      }
      setStreamMode("reconnecting");
    };

    return () => {
      disposed = true;
      if (eventSourceRef.current === nextSource) {
        nextSource.close();
        eventSourceRef.current = null;
      }
      setStreamMode("idle");
    };
  }, [canLoadProcessingState, invalidateProcessingTargets, onProcessingPage]);

  const startCatalogSync = useCallback(
    (remotePages) =>
      runCardAction(
        "catalog-sync",
        () =>
          apiFetch(processingPath("/processing/sync/start/"), {
            method: "POST",
            ...(catalogRemotePages(remotePages).length
              ? { body: { remotePages: catalogRemotePages(remotePages) } }
              : {}),
          }),
        {
          onSuccess: (_, nextToast) =>
            nextToast.info({
              title: "Sync started",
              description: "Catalog sync is running.",
            }),
        },
      ),
    [runCardAction],
  );

  const pauseCatalogSync = useCallback(
    () =>
      runCardAction(
        "catalog-sync",
        () =>
          apiFetch(
            processingPath(scopedSyncPath(PROCESSING_SYNC_SCOPE_CATALOG, "pause")),
            {
              method: "POST",
            },
          ),
        {
          onSuccess: (_, nextToast) =>
            nextToast.info({
              title: "Pause requested",
              description: "Catalog sync will pause after the current page.",
            }),
        },
      ),
    [runCardAction],
  );

  const resumeCatalogSync = useCallback(
    () =>
      runCardAction(
        "catalog-sync",
        () =>
          apiFetch(
            processingPath(scopedSyncPath(PROCESSING_SYNC_SCOPE_CATALOG, "resume")),
            {
              method: "POST",
              body: { runMode: "manual" },
            },
          ),
        {
          onSuccess: (_, nextToast) =>
            nextToast.info({
              title: "Sync resumed",
              description: "Catalog sync resumed from saved progress.",
            }),
        },
      ),
    [runCardAction],
  );

  const stopCatalogSync = useCallback(
    () =>
      runCardAction(
        "catalog-sync",
        () =>
          apiFetch(
            processingPath(scopedSyncPath(PROCESSING_SYNC_SCOPE_CATALOG, "stop")),
            {
              method: "POST",
            },
          ),
      ),
    [runCardAction],
  );

  const createRequestsForRecords = useCallback(
    (recordIds) =>
      runCardAction(
        "catalog-records",
        () =>
          apiFetch(processingPath("/processing/records/create-requests/"), {
            method: "POST",
            body: { ids: recordIds },
          }),
        {
          onSuccess: (payload, nextToast) => {
            if (payload?.createdCount) {
              nextToast.success({
                title: "Requests created",
                description: `${countLabel(payload.createdCount, "request")} entered the pipeline.`,
              });
              return;
            }
            nextToast.info({
              title: "No requests created",
              description: "The selected records already have active requests.",
            });
          },
        },
      ),
    [runCardAction],
  );

  const saveCatalogAutomation = useCallback(
    (form) =>
      runCardAction(
        "catalog-automation-save",
        () =>
          apiFetch(processingPath("/processing/automation/catalog/"), {
            method: "POST",
            body: form,
          }),
        {
          onSuccess: (_, nextToast) =>
            nextToast.success({
              title: "Catalog automation saved",
              description: "The schedule settings were updated.",
            }),
        },
      ),
    [runCardAction],
  );

  const runCatalogAutomation = useCallback(
    () =>
      runCardAction(
        "catalog-automation-run",
        () =>
          apiFetch(processingPath("/processing/automation/catalog/run/"), {
            method: "POST",
          }),
        {
          onSuccess: (_, nextToast) =>
            nextToast.info({
              title: "Catalog automation started",
              description: "Automated catalog sync is running.",
            }),
        },
      ),
    [runCardAction],
  );

  const pauseCatalogAutomation = useCallback(
    () =>
      runCardAction(
        "catalog-automation-run",
        () =>
          apiFetch(
            processingPath(scopedSyncPath(PROCESSING_SYNC_SCOPE_CATALOG, "pause")),
            {
              method: "POST",
            },
          ),
        {
          onSuccess: (_, nextToast) =>
            nextToast.info({
              title: "Catalog automation pausing",
              description:
                "Automated catalog sync will pause after the current page finishes.",
            }),
        },
      ),
    [runCardAction],
  );

  const resumeCatalogAutomation = useCallback(
    () =>
      runCardAction(
        "catalog-automation-run",
        () =>
          apiFetch(
            processingPath(scopedSyncPath(PROCESSING_SYNC_SCOPE_CATALOG, "resume")),
            {
              method: "POST",
              body: { runMode: "catalog_automation" },
            },
          ),
        {
          onSuccess: (_, nextToast) =>
            nextToast.info({
              title: "Catalog automation resumed",
              description:
                "Automated catalog sync resumed from saved progress.",
            }),
        },
      ),
    [runCardAction],
  );

  const stopCatalogAutomation = useCallback(
    () =>
      runCardAction(
        "catalog-automation-run",
        () =>
          apiFetch(
            processingPath(scopedSyncPath(PROCESSING_SYNC_SCOPE_CATALOG, "stop")),
            {
              method: "POST",
            },
          ),
      ),
    [runCardAction],
  );

  const saveIncompleteAutomation = useCallback(
    (form) =>
      runCardAction(
        "incomplete-automation-save",
        () =>
          apiFetch(processingPath("/processing/automation/incomplete/"), {
            method: "POST",
            body: form,
          }),
        {
          onSuccess: (_, nextToast) =>
            nextToast.success({
              title: "Incomplete automation saved",
              description: "The schedule settings were updated.",
            }),
        },
      ),
    [runCardAction],
  );

  const runIncompleteAutomation = useCallback(
    () =>
      runCardAction(
        "incomplete-automation-run",
        () =>
          apiFetch(processingPath("/processing/automation/incomplete/run/"), {
            method: "POST",
          }),
        {
          onSuccess: (_, nextToast) =>
            nextToast.info({
              title: "Incomplete automation started",
              description: "Incomplete catalog sync is running.",
            }),
        },
      ),
    [runCardAction],
  );

  const pauseIncompleteAutomation = useCallback(
    () =>
      runCardAction(
        "incomplete-automation-run",
        () =>
          apiFetch(
            processingPath(scopedSyncPath(PROCESSING_SYNC_SCOPE_INCOMPLETE, "pause")),
            {
              method: "POST",
            },
          ),
        {
          onSuccess: (_, nextToast) =>
            nextToast.info({
              title: "Incomplete automation pausing",
              description:
                "Incomplete catalog sync will pause after the current batch.",
            }),
        },
      ),
    [runCardAction],
  );

  const resumeIncompleteAutomation = useCallback(
    () =>
      runCardAction(
        "incomplete-automation-run",
        () =>
          apiFetch(
            processingPath(scopedSyncPath(PROCESSING_SYNC_SCOPE_INCOMPLETE, "resume")),
            {
              method: "POST",
              body: { runMode: "incomplete_automation" },
            },
          ),
        {
          onSuccess: (_, nextToast) =>
            nextToast.info({
              title: "Incomplete automation resumed",
              description:
                "Incomplete catalog sync restarted from the beginning.",
            }),
        },
      ),
    [runCardAction],
  );

  const stopIncompleteAutomation = useCallback(
    () =>
      runCardAction(
        "incomplete-automation-run",
        () =>
          apiFetch(
            processingPath(scopedSyncPath(PROCESSING_SYNC_SCOPE_INCOMPLETE, "stop")),
            {
              method: "POST",
            },
          ),
      ),
    [runCardAction],
  );

  const applyRequestAction = useCallback(
    (cardId, requestIds, action, extra = {}) =>
      runCardAction(
        cardId,
        () =>
          apiFetch(processingPath("/processing/requests/action/"), {
            method: "POST",
            body: {
              ids: requestIds,
              action,
              ...extra,
            },
          }),
        {
          onSuccess: (payload, nextToast) =>
            notifyRequestAction(
              nextToast,
              action,
              payload?.changedCount || 0,
              extra,
            ),
        },
      ),
    [runCardAction],
  );

  const deleteRequests = useCallback(
    (cardId, requestIds, options = {}) =>
      applyRequestAction(cardId, requestIds, "delete", {
        deleteBook: Boolean(options.deleteBook),
      }),
    [applyRequestAction],
  );

  const pauseRequests = useCallback(
    (cardId, requestIds) => applyRequestAction(cardId, requestIds, "pause"),
    [applyRequestAction],
  );

  const resumePausedRequests = useCallback(
    (cardId, requestIds) => applyRequestAction(cardId, requestIds, "resume"),
    [applyRequestAction],
  );

  const retryFailedRequests = useCallback(
    (cardId, requestIds) => applyRequestAction(cardId, requestIds, "retry"),
    [applyRequestAction],
  );

  const markDuplicateRequestsAsNew = useCallback(
    (cardId, requestIds) => applyRequestAction(cardId, requestIds, "new"),
    [applyRequestAction],
  );

  const confirmDuplicateRequests = useCallback(
    (cardId, requestIds) =>
      applyRequestAction(cardId, requestIds, "confirm_duplicate"),
    [applyRequestAction],
  );

  const createAgainRequests = useCallback(
    (cardId, requestIds) =>
      applyRequestAction(cardId, requestIds, "create_again"),
    [applyRequestAction],
  );

  const recreateCompletedRequests = useCallback(
    (cardId, requestIds) => applyRequestAction(cardId, requestIds, "recreate"),
    [applyRequestAction],
  );

  const value = useMemo(
    () => ({
      busyCards,
      canLoadProcessingState,
      streamMode,
      getCardRefreshToken,
      invalidateProcessingTargets,
      startCatalogSync,
      pauseCatalogSync,
      resumeCatalogSync,
      stopCatalogSync,
      createRequestsForRecords,
      saveCatalogAutomation,
      runCatalogAutomation,
      pauseCatalogAutomation,
      resumeCatalogAutomation,
      stopCatalogAutomation,
      deleteRequests,
      pauseRequests,
      resumePausedRequests,
      retryFailedRequests,
      markDuplicateRequestsAsNew,
      confirmDuplicateRequests,
      createAgainRequests,
      saveIncompleteAutomation,
      runIncompleteAutomation,
      pauseIncompleteAutomation,
      resumeIncompleteAutomation,
      stopIncompleteAutomation,
      recreateCompletedRequests,
    }),
    [
      busyCards,
      canLoadProcessingState,
      confirmDuplicateRequests,
      createAgainRequests,
      createRequestsForRecords,
      deleteRequests,
      getCardRefreshToken,
      invalidateProcessingTargets,
      markDuplicateRequestsAsNew,
      pauseCatalogAutomation,
      pauseCatalogSync,
      pauseIncompleteAutomation,
      pauseRequests,
      recreateCompletedRequests,
      resumeCatalogAutomation,
      resumeCatalogSync,
      resumeIncompleteAutomation,
      resumePausedRequests,
      retryFailedRequests,
      runCatalogAutomation,
      runIncompleteAutomation,
      saveCatalogAutomation,
      saveIncompleteAutomation,
      startCatalogSync,
      stopCatalogAutomation,
      stopCatalogSync,
      stopIncompleteAutomation,
      streamMode,
    ],
  );

  return (
    <ProcessingPagesContext.Provider value={value}>
      {children}
    </ProcessingPagesContext.Provider>
  );
}

export function useBookProcessing() {
  const context = useContext(ProcessingPagesContext);
  if (!context) {
    throw new Error(
      "useBookProcessing must be used within BookProcessingProvider",
    );
  }
  return context;
}
