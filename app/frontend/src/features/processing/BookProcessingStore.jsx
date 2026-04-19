import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiFetch, resolveAppUrl } from "../../api/client";
import { useSession } from "../../hooks/useSession";
import { useToast } from "../../hooks/useToast";
import { hasCapability } from "../../utils/capabilities";

const ProcessingPagesContext = createContext(null);
const PROCESSING_STREAM_RECONNECT_MS = 4000;
const PROCESSING_MONITOR_IDLE_MS = 4000;
const PROCESSING_MONITOR_ACTIVE_MS = 1000;
const PROCESSING_SYNC_SCOPE_CATALOG = "catalog";
const PROCESSING_SYNC_SCOPE_INCOMPLETE = "incomplete";
const PROCESSING_STATE_PATH = "/processing/state/?includeLists=0";
const PROCESSING_DATA_TARGETS = [
  "catalog-overview",
  "create-overview",
  "on-hold-overview",
  "incomplete-overview",
  "catalog-records",
  "create-requests",
  "create-queue",
  "create-processing",
  "create-created",
  "on-hold-paused",
  "on-hold-failed",
  "on-hold-duplicate",
  "on-hold-deleted",
  "incomplete-records",
  "incomplete-completed",
];
const CATALOG_SYNC_TARGETS = [
  "catalog-sync",
  "catalog-automation",
  "catalog-overview",
  "catalog-records",
];
const INCOMPLETE_SYNC_TARGETS = [
  "incomplete-automation",
  "incomplete-overview",
  "incomplete-records",
  "incomplete-completed",
];
const ALL_PROCESSING_TARGETS = Array.from(
  new Set([
    ...PROCESSING_DATA_TARGETS,
    ...CATALOG_SYNC_TARGETS,
    ...INCOMPLETE_SYNC_TARGETS,
  ]),
);

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets)) {
    return [];
  }
  return Array.from(
    new Set(
      targets
        .map((target) => String(target || "").trim())
        .filter(Boolean),
    ),
  );
}

function scopedSyncPath(scope, action) {
  return `/processing/sync/${scope}/${action}/`;
}

function summaryOnlyPath(path) {
  return `${path}${path.includes("?") ? "&" : "?"}includeLists=0`;
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
  const [refreshVersions, setRefreshVersions] = useState({});
  const [streamMode, setStreamMode] = useState("idle");
  const reconnectTimerRef = useRef(null);
  const eventSourceRef = useRef(null);
  const monitorTimerRef = useRef(null);
  const monitorRequestRef = useRef(false);
  const hasStreamConnectedRef = useRef(false);
  const { authenticated, loading, user } = useSession();
  const toast = useToast();
  const canLoadProcessingState =
    authenticated && !loading && hasCapability(user, "processing:manage");

  const refreshTargets = useCallback((targets) => {
    const normalizedTargets = normalizeTargets(targets);
    if (!normalizedTargets.length) {
      return;
    }
    setRefreshVersions((current) => {
      const next = { ...current };
      normalizedTargets.forEach((target) => {
        next[target] = (next[target] || 0) + 1;
      });
      return next;
    });
  }, []);

  const runCardAction = useCallback(
    async (cardId, request, options = {}) => {
      setBusyCards((current) => ({
        ...current,
        [cardId]: (current[cardId] || 0) + 1,
      }));
      try {
        const payload = await request();
        refreshTargets(options.targets);
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
    [refreshTargets, toast],
  );

  useEffect(() => {
    if (!canLoadProcessingState || typeof window === "undefined") {
      setStreamMode("idle");
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      hasStreamConnectedRef.current = false;
      return undefined;
    }

    if (typeof EventSource === "undefined") {
      refreshTargets(ALL_PROCESSING_TARGETS);
      setStreamMode("fallback");
      return undefined;
    }

    let disposed = false;

    const connect = () => {
      if (disposed) {
        return;
      }

      setStreamMode("connecting");

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const nextSource = new EventSource(
        resolveAppUrl("/processing/stream/"),
        { withCredentials: true },
      );
      eventSourceRef.current = nextSource;

      nextSource.addEventListener("connected", () => {
        if (disposed || eventSourceRef.current !== nextSource) {
          return;
        }
        if (hasStreamConnectedRef.current) {
          refreshTargets(ALL_PROCESSING_TARGETS);
        }
        hasStreamConnectedRef.current = true;
        setStreamMode("connected");
      });

      nextSource.addEventListener("invalidation", (event) => {
        try {
          const payload = JSON.parse(event.data || "{}");
          refreshTargets(payload.targets);
        } catch {
          refreshTargets(ALL_PROCESSING_TARGETS);
        }
      });

      nextSource.onerror = () => {
        if (eventSourceRef.current === nextSource) {
          nextSource.close();
          eventSourceRef.current = null;
        }
        refreshTargets(ALL_PROCESSING_TARGETS);
        setStreamMode("fallback");
        if (disposed || reconnectTimerRef.current) {
          return;
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, PROCESSING_STREAM_RECONNECT_MS);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setStreamMode("idle");
      hasStreamConnectedRef.current = false;
    };
  }, [
    canLoadProcessingState,
    refreshTargets,
  ]);

  useEffect(() => {
    if (
      !canLoadProcessingState ||
      streamMode !== "fallback" ||
      typeof window === "undefined"
    ) {
      if (monitorTimerRef.current !== null) {
        window.clearTimeout(monitorTimerRef.current);
        monitorTimerRef.current = null;
      }
      monitorRequestRef.current = false;
      return undefined;
    }

    let disposed = false;

    const schedule = (delayMs) => {
      if (disposed) {
        return;
      }
      if (monitorTimerRef.current !== null) {
        window.clearTimeout(monitorTimerRef.current);
      }
      monitorTimerRef.current = window.setTimeout(runMonitorTick, delayMs);
    };

    const runMonitorTick = async () => {
      if (disposed || monitorRequestRef.current) {
        schedule(PROCESSING_MONITOR_IDLE_MS);
        return;
      }

      monitorRequestRef.current = true;
      try {
        const payload = await apiFetch(PROCESSING_STATE_PATH);
        const syncStates = payload?.syncStates || {};
        const catalogSync = syncStates.catalog || payload?.sync || null;
        const incompleteSync = syncStates.incomplete || payload?.sync || null;
        const manualPipelineAdvance = Boolean(
          payload?.orchestration?.manualPipelineAdvance,
        );
        const activeSyncScopes = [
          ["catalog", catalogSync, CATALOG_SYNC_TARGETS],
          ["incomplete", incompleteSync, INCOMPLETE_SYNC_TARGETS],
        ].filter(([, syncState]) =>
          ["syncing", "pausing"].includes(syncState?.status) &&
          !syncState?.workerManaged,
        );
        const hasActiveRequests =
          Number(payload?.summary?.notifications?.activeRequests || 0) > 0;

        let nextDelay = PROCESSING_MONITOR_IDLE_MS;
        const refreshedTargets = [];
        const shouldRefreshLocally = !hasStreamConnectedRef.current;

        for (const [scope, _syncState, targets] of activeSyncScopes) {
          await apiFetch(
            `${scopedSyncPath(scope, "advance")}?includeLists=0`,
            {
              method: "POST",
            },
          );
          if (shouldRefreshLocally) {
            refreshedTargets.push(...targets);
          }
          nextDelay = PROCESSING_MONITOR_ACTIVE_MS;
        }

        if (
          manualPipelineAdvance &&
          hasActiveRequests &&
          !activeSyncScopes.length
        ) {
          const advancePayload = await apiFetch(
            "/processing/pipeline/advance/?includeLists=0",
            {
              method: "POST",
            },
          );
          if (
            shouldRefreshLocally &&
            Number(advancePayload?.advancedCount || 0) > 0
          ) {
            refreshedTargets.push(...PROCESSING_DATA_TARGETS);
          }
          nextDelay = PROCESSING_MONITOR_ACTIVE_MS;
        }

        if (refreshedTargets.length) {
          refreshTargets(refreshedTargets);
        }

        schedule(nextDelay);
      } catch (monitorError) {
        if (
          ![401, 403].includes(monitorError?.status) &&
          !hasStreamConnectedRef.current
        ) {
          refreshTargets(ALL_PROCESSING_TARGETS);
        }
        schedule(PROCESSING_MONITOR_IDLE_MS);
      } finally {
        monitorRequestRef.current = false;
      }
    };

    schedule(PROCESSING_MONITOR_ACTIVE_MS);

    return () => {
      disposed = true;
      if (monitorTimerRef.current !== null) {
        window.clearTimeout(monitorTimerRef.current);
        monitorTimerRef.current = null;
      }
      monitorRequestRef.current = false;
    };
  }, [canLoadProcessingState, refreshTargets, streamMode]);

  const startCatalogSync = useCallback(
    (remotePages) =>
      runCardAction(
        "catalog-sync",
        () =>
          apiFetch(summaryOnlyPath("/processing/sync/start/"), {
            method: "POST",
            ...(catalogRemotePages(remotePages).length
              ? { body: { remotePages: catalogRemotePages(remotePages) } }
              : {}),
          }),
        {
          targets: CATALOG_SYNC_TARGETS,
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
            summaryOnlyPath(
              scopedSyncPath(PROCESSING_SYNC_SCOPE_CATALOG, "pause"),
            ),
            {
            method: "POST",
            },
          ),
        {
          targets: CATALOG_SYNC_TARGETS,
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
            summaryOnlyPath(
              scopedSyncPath(PROCESSING_SYNC_SCOPE_CATALOG, "resume"),
            ),
            {
            method: "POST",
            body: { runMode: "manual" },
            },
          ),
        {
          targets: CATALOG_SYNC_TARGETS,
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
            summaryOnlyPath(
              scopedSyncPath(PROCESSING_SYNC_SCOPE_CATALOG, "stop"),
            ),
            {
            method: "POST",
            },
          ),
        {
          targets: CATALOG_SYNC_TARGETS,
        },
      ),
    [runCardAction],
  );

  const createRequestsForRecords = useCallback(
    (recordIds) =>
      runCardAction(
        "catalog-records",
        () =>
          apiFetch(summaryOnlyPath("/processing/records/create-requests/"), {
            method: "POST",
            body: { ids: recordIds },
          }),
        {
          targets: PROCESSING_DATA_TARGETS,
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
          apiFetch(summaryOnlyPath("/processing/automation/catalog/"), {
            method: "POST",
            body: form,
          }),
        {
          targets: ["catalog-automation"],
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
          apiFetch(summaryOnlyPath("/processing/automation/catalog/run/"), {
            method: "POST",
          }),
        {
          targets: CATALOG_SYNC_TARGETS,
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
            summaryOnlyPath(
              scopedSyncPath(PROCESSING_SYNC_SCOPE_CATALOG, "pause"),
            ),
            {
            method: "POST",
            },
          ),
        {
          targets: CATALOG_SYNC_TARGETS,
          onSuccess: (_, nextToast) =>
            nextToast.info({
              title: "Catalog automation pausing",
              description:
                "Automated catalog sync will pause after the current page.",
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
            summaryOnlyPath(
              scopedSyncPath(PROCESSING_SYNC_SCOPE_CATALOG, "resume"),
            ),
            {
            method: "POST",
            body: { runMode: "catalog_automation" },
            },
          ),
        {
          targets: CATALOG_SYNC_TARGETS,
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
            summaryOnlyPath(
              scopedSyncPath(PROCESSING_SYNC_SCOPE_CATALOG, "stop"),
            ),
            {
            method: "POST",
            },
          ),
        {
          targets: CATALOG_SYNC_TARGETS,
        },
      ),
    [runCardAction],
  );

  const saveIncompleteAutomation = useCallback(
    (form) =>
      runCardAction(
        "incomplete-automation-save",
        () =>
          apiFetch(summaryOnlyPath("/processing/automation/incomplete/"), {
            method: "POST",
            body: form,
          }),
        {
          targets: ["incomplete-automation"],
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
          apiFetch(summaryOnlyPath("/processing/automation/incomplete/run/"), {
            method: "POST",
          }),
        {
          targets: INCOMPLETE_SYNC_TARGETS,
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
            summaryOnlyPath(
              scopedSyncPath(PROCESSING_SYNC_SCOPE_INCOMPLETE, "pause"),
            ),
            {
            method: "POST",
            },
          ),
        {
          targets: INCOMPLETE_SYNC_TARGETS,
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
            summaryOnlyPath(
              scopedSyncPath(PROCESSING_SYNC_SCOPE_INCOMPLETE, "resume"),
            ),
            {
            method: "POST",
            body: { runMode: "incomplete_automation" },
            },
          ),
        {
          targets: INCOMPLETE_SYNC_TARGETS,
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
            summaryOnlyPath(
              scopedSyncPath(PROCESSING_SYNC_SCOPE_INCOMPLETE, "stop"),
            ),
            {
            method: "POST",
            },
          ),
        {
          targets: INCOMPLETE_SYNC_TARGETS,
        },
      ),
    [runCardAction],
  );

  const applyRequestAction = useCallback(
    (cardId, requestIds, action, extra = {}) =>
      runCardAction(
        cardId,
        () =>
          apiFetch(summaryOnlyPath("/processing/requests/action/"), {
            method: "POST",
            body: {
              ids: requestIds,
              action,
              ...extra,
            },
          }),
        {
          targets: PROCESSING_DATA_TARGETS,
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
      refreshTargets,
      refreshVersions,
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
      markDuplicateRequestsAsNew,
      pauseCatalogAutomation,
      pauseCatalogSync,
      pauseIncompleteAutomation,
      pauseRequests,
      recreateCompletedRequests,
      refreshTargets,
      refreshVersions,
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
