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
const PROCESSING_ROUTE_PAGES = {
  "/catalog": "catalog",
  "/create": "create",
  "/on-hold": "on-hold",
  "/incomplete": "incomplete",
};
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
const SHARED_PROCESSING_CARD_KEYS = new Set([
  "catalog-overview",
  "catalog-sync",
  "catalog-automation",
  "create-overview",
  "on-hold-overview",
  "incomplete-overview",
  "incomplete-automation",
]);

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

function processingPageForPathname(pathname) {
  return PROCESSING_ROUTE_PAGES[pathname] || "";
}

function normalizeVersionValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function versionSignature(versions, domains) {
  return domains
    .map((domain) => `${domain}:${normalizeVersionValue(versions?.[domain])}`)
    .join("|");
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
  const [domainVersions, setDomainVersions] = useState({});
  const [processingStateStatus, setProcessingStateStatus] = useState({
    data: null,
    loadedOnce: false,
    initialLoading: false,
    refreshing: false,
    error: "",
  });
  const eventSourceRef = useRef(null);
  const loadProcessingStateRef = useRef(() => Promise.resolve(null));
  const processingStateLoadPromiseRef = useRef(null);
  const processingStateReloadQueuedRef = useRef(false);
  const processingStateRequestIdRef = useRef(0);
  const processingStateAppliedRequestIdRef = useRef(0);
  const processingStateAppliedSharedSignatureRef = useRef("");
  const lastLoadedProcessingPageRef = useRef("");
  const location = useLocation();
  const { authenticated, loading, user } = useSession();
  const toast = useToast();
  const canLoadProcessingState =
    authenticated && !loading && hasCapability(user, "processing:manage");
  const processingPage = processingPageForPathname(location.pathname);
  const onProcessingPage = Boolean(processingPage);
  const sharedProcessingCardKeys = useMemo(
    () => [...SHARED_PROCESSING_CARD_KEYS],
    [],
  );
  const sharedVersionSignature = useMemo(
    () => versionSignature(domainVersions, sharedProcessingCardKeys),
    [domainVersions, sharedProcessingCardKeys],
  );
  const sharedVersionSignatureRef = useRef(sharedVersionSignature);
  const domainVersionsRef = useRef(domainVersions);

  useEffect(() => {
    sharedVersionSignatureRef.current = sharedVersionSignature;
  }, [sharedVersionSignature]);

  useEffect(() => {
    domainVersionsRef.current = domainVersions;
  }, [domainVersions]);

  const applyProcessingVersions = useCallback((incomingVersions) => {
    if (!incomingVersions || typeof incomingVersions !== "object") {
      return {
        changed: false,
        sharedChanged: false,
      };
    }

    let changed = false;
    let sharedChanged = false;
    const currentVersions = domainVersionsRef.current || {};
    const nextVersions = { ...currentVersions };
    Object.entries(incomingVersions).forEach(([domain, rawValue]) => {
      if (!PROCESSING_CARD_KEYS.includes(domain)) {
        return;
      }
      const nextValue = normalizeVersionValue(rawValue);
      if (nextValue <= normalizeVersionValue(nextVersions[domain])) {
        return;
      }
      nextVersions[domain] = nextValue;
      changed = true;
      if (SHARED_PROCESSING_CARD_KEYS.has(domain)) {
        sharedChanged = true;
      }
    });
    if (!changed) {
      return {
        changed: false,
        sharedChanged: false,
      };
    }

    domainVersionsRef.current = nextVersions;
    setDomainVersions((current) => {
      let next = current;
      Object.entries(incomingVersions).forEach(([domain, rawValue]) => {
        if (!PROCESSING_CARD_KEYS.includes(domain)) {
          return;
        }
        const nextValue = normalizeVersionValue(rawValue);
        if (nextValue <= normalizeVersionValue(current[domain])) {
          return;
        }
        if (next === current) {
          next = { ...current };
        }
        next[domain] = nextValue;
        changed = true;
      });
      return next;
    });
    return {
      changed,
      sharedChanged,
    };
  }, []);

  const getDomainVersion = useCallback(
    (cardKey) => normalizeVersionValue(domainVersions[cardKey]),
    [domainVersions],
  );

  const loadProcessingState = useCallback(() => {
    if (!onProcessingPage || !canLoadProcessingState) {
      return Promise.resolve(null);
    }

    if (processingStateLoadPromiseRef.current) {
      processingStateReloadQueuedRef.current = true;
      return processingStateLoadPromiseRef.current;
    }

    let disposed = false;
    const requestId = processingStateRequestIdRef.current + 1;
    processingStateRequestIdRef.current = requestId;
    setProcessingStateStatus((current) => ({
      ...current,
      initialLoading: !current.loadedOnce,
      refreshing: current.loadedOnce,
      error: "",
    }));

    const request = apiFetch(processingPath("/processing/state/"), {
      cache: "no-store",
    })
      .then((payload) => {
        if (
          disposed ||
          requestId < processingStateAppliedRequestIdRef.current
        ) {
          return payload;
        }
        processingStateAppliedRequestIdRef.current = requestId;
        applyProcessingVersions(payload?.versions || {});
        processingStateAppliedSharedSignatureRef.current = versionSignature(
          payload?.versions || {},
          sharedProcessingCardKeys,
        );
        sharedVersionSignatureRef.current =
          processingStateAppliedSharedSignatureRef.current;
        setProcessingStateStatus({
          data: payload,
          loadedOnce: true,
          initialLoading: false,
          refreshing: false,
          error: "",
        });
        return payload;
      })
      .catch((loadError) => {
        if (
          disposed ||
          requestId < processingStateAppliedRequestIdRef.current
        ) {
          return null;
        }
        setProcessingStateStatus((current) => ({
          ...current,
          loadedOnce: true,
          initialLoading: false,
          refreshing: false,
          error: loadError.message || "Unable to load processing state.",
        }));
        return null;
      })
      .finally(() => {
        disposed = true;
        if (processingStateLoadPromiseRef.current === request) {
          processingStateLoadPromiseRef.current = null;
        }
        const shouldReload =
          processingStateReloadQueuedRef.current ||
          sharedVersionSignatureRef.current !==
            processingStateAppliedSharedSignatureRef.current;
        processingStateReloadQueuedRef.current = false;
        if (shouldReload && onProcessingPage && canLoadProcessingState) {
          void loadProcessingStateRef.current?.();
        }
      });
    processingStateLoadPromiseRef.current = request;
    return request;
  }, [
    applyProcessingVersions,
    canLoadProcessingState,
    onProcessingPage,
    sharedProcessingCardKeys,
  ]);

  useEffect(() => {
    loadProcessingStateRef.current = loadProcessingState;
  }, [loadProcessingState]);

  const queueProcessingStateReload = useCallback(() => {
    if (!onProcessingPage || !canLoadProcessingState) {
      return;
    }
    processingStateReloadQueuedRef.current = true;
    if (!processingStateLoadPromiseRef.current) {
      void loadProcessingStateRef.current?.();
    }
  }, [canLoadProcessingState, onProcessingPage]);

  useEffect(() => {
    if (canLoadProcessingState) {
      return undefined;
    }
    setDomainVersions({});
    setProcessingStateStatus({
      data: null,
      loadedOnce: false,
      initialLoading: false,
      refreshing: false,
      error: "",
    });
    processingStateLoadPromiseRef.current = null;
    processingStateReloadQueuedRef.current = false;
    processingStateAppliedRequestIdRef.current = 0;
    processingStateAppliedSharedSignatureRef.current = "";
    lastLoadedProcessingPageRef.current = "";
    setStreamMode("idle");
    return undefined;
  }, [canLoadProcessingState]);

  useEffect(() => {
    if (!onProcessingPage || !canLoadProcessingState) {
      setProcessingStateStatus({
        data: null,
        loadedOnce: false,
        initialLoading: false,
        refreshing: false,
        error: "",
      });
      processingStateLoadPromiseRef.current = null;
      processingStateReloadQueuedRef.current = false;
      processingStateAppliedRequestIdRef.current = 0;
      processingStateAppliedSharedSignatureRef.current = "";
      lastLoadedProcessingPageRef.current = "";
      return undefined;
    }
    const pageChanged = lastLoadedProcessingPageRef.current !== processingPage;
    if (pageChanged) {
      lastLoadedProcessingPageRef.current = processingPage;
    }
    if (
      pageChanged ||
      !processingStateStatus.loadedOnce ||
      sharedVersionSignature !== processingStateAppliedSharedSignatureRef.current
    ) {
      loadProcessingState();
    }
    return undefined;
  }, [
    canLoadProcessingState,
    loadProcessingState,
    onProcessingPage,
    processingPage,
    processingStateStatus.loadedOnce,
    sharedVersionSignature,
  ]);

  const runCardAction = useCallback(
    async (cardId, request, options = {}) => {
      setBusyCards((current) => ({
        ...current,
        [cardId]: (current[cardId] || 0) + 1,
      }));
      try {
        const payload = await request();
        const versionUpdate = applyProcessingVersions(payload?.versions || {});
        if (versionUpdate.sharedChanged) {
          queueProcessingStateReload();
        }
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
    [applyProcessingVersions, queueProcessingStateReload, toast],
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
      resolveApiUrl(`/processing/stream/?page=${encodeURIComponent(processingPage)}`),
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
        const versionUpdate = applyProcessingVersions(payload.versions || {});
        if (versionUpdate.sharedChanged) {
          queueProcessingStateReload();
        }
      } catch {}
    };

    nextSource.addEventListener("connected", () => {
      if (disposed || eventSourceRef.current !== nextSource) {
        return;
      }
      setStreamMode("connected");
    });
    nextSource.addEventListener("versions", handlePayload);
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
  }, [
    applyProcessingVersions,
    canLoadProcessingState,
    onProcessingPage,
    processingPage,
    queueProcessingStateReload,
  ]);

  useEffect(() => {
    if (
      !onProcessingPage ||
      !canLoadProcessingState ||
      !["reconnecting", "unsupported"].includes(streamMode) ||
      typeof window === "undefined"
    ) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      loadProcessingState();
    }, 15000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [canLoadProcessingState, loadProcessingState, onProcessingPage, streamMode]);

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
              description: "Catalog sync resumed from the saved endpoint.",
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
              title: "Catalog automation running",
              description: "Catalog automation picked up the shared catalog work.",
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
              description: "Catalog automation resumed shared progress.",
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
      isSharedProcessingCard: (cardKey) =>
        SHARED_PROCESSING_CARD_KEYS.has(cardKey),
      processingState: processingStateStatus.data,
      processingStateLoaded: processingStateStatus.loadedOnce,
      processingStateInitialLoading: processingStateStatus.initialLoading,
      processingStateRefreshing: processingStateStatus.refreshing,
      processingStateError: processingStateStatus.error,
      streamMode,
      getDomainVersion,
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
      getDomainVersion,
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
      processingStateStatus.data,
      processingStateStatus.error,
      processingStateStatus.initialLoading,
      processingStateStatus.loadedOnce,
      processingStateStatus.refreshing,
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
