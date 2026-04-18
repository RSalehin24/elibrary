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
import { apiFetch } from "../../api/client";
import { useSession } from "../../hooks/useSession";
import { isProcessingRoute } from "../layout/navigation";
import { useToast } from "../../hooks/useToast";
import { ACTIVE_REQUEST_STATES } from "./types";

const ProcessingPagesContext = createContext(null);
const AGGREGATED_NOTIFICATION_WINDOW_MS = 2 * 60 * 1000;
const SYNC_RUN_MODE_MANUAL = "manual";
const SYNC_RUN_MODE_CATALOG_AUTOMATION = "catalog_automation";
const SYNC_RUN_MODE_INCOMPLETE_AUTOMATION = "incomplete_automation";

const DEFAULT_SYNC_STATE = {
  status: "idle",
  progress: null,
  fetchedCount: 0,
  skippedCount: 0,
  updatedCount: 0,
  appendedCount: 0,
  message: "Ready to sync.",
  remotePages: [],
  pageIndex: 0,
  runMode: SYNC_RUN_MODE_MANUAL,
};

const DEFAULT_AUTOMATION_STATE = {
  catalog: {
    enabled: false,
    interval: "weekly",
    time: "03:00",
    saved: false,
    lastRunAt: null,
    statusMessage: "",
  },
  incomplete: {
    enabled: false,
    interval: "weekly",
    time: "03:00",
    saved: false,
    lastRunAt: null,
    statusMessage: "",
  },
};

const DEFAULT_STATE = {
  records: [],
  requests: [],
  sync: DEFAULT_SYNC_STATE,
  automation: DEFAULT_AUTOMATION_STATE,
  ui: {
    pipelineDelayMs: 500,
  },
};

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
  return Array.isArray(remotePages) && remotePages.every(isCatalogRemotePage)
    ? remotePages
    : [];
}

function normalizeState(payload) {
  const state = payload && typeof payload === "object" ? payload : {};
  return {
    records: Array.isArray(state.records) ? state.records : [],
    requests: Array.isArray(state.requests) ? state.requests : [],
    sync: {
      ...DEFAULT_SYNC_STATE,
      ...(state.sync || {}),
    },
    automation: {
      catalog: {
        ...DEFAULT_AUTOMATION_STATE.catalog,
        ...(state.automation?.catalog || {}),
      },
      incomplete: {
        ...DEFAULT_AUTOMATION_STATE.incomplete,
        ...(state.automation?.incomplete || {}),
      },
    },
    ui: {
      ...DEFAULT_STATE.ui,
      ...(state.ui || {}),
    },
  };
}

function buildRecordMap(records) {
  return new Map(records.map((record) => [record.id, record]));
}

function syncCompletionCopy(previousState, nextState) {
  const runMode = previousState.sync?.runMode || SYNC_RUN_MODE_MANUAL;
  if (runMode === SYNC_RUN_MODE_CATALOG_AUTOMATION) {
    return {
      title: "Catalog automation finished",
      description:
        nextState.automation?.catalog?.statusMessage ||
        nextState.sync?.message ||
        "Automated catalog sync completed.",
    };
  }
  if (runMode === SYNC_RUN_MODE_INCOMPLETE_AUTOMATION) {
    return {
      title: "Incomplete automation finished",
      description:
        nextState.automation?.incomplete?.statusMessage ||
        nextState.sync?.message ||
        "Incomplete catalog sync completed.",
    };
  }
  return {
    title: "Sync complete",
    description: nextState.sync?.message || "Catalog sync completed.",
  };
}

function syncPausedCopy(nextState) {
  const runMode = nextState.sync?.runMode || SYNC_RUN_MODE_MANUAL;
  if (runMode === SYNC_RUN_MODE_CATALOG_AUTOMATION) {
    return {
      title: "Catalog automation paused",
      description:
        nextState.sync?.message || "Automated catalog sync progress was saved.",
    };
  }
  if (runMode === SYNC_RUN_MODE_INCOMPLETE_AUTOMATION) {
    return {
      title: "Incomplete automation paused",
      description:
        nextState.sync?.message || "Incomplete catalog sync progress was saved.",
    };
  }
  return {
    title: "Sync paused",
    description: nextState.sync?.message || "Catalog sync progress was saved.",
  };
}

function requestTimestamp(request) {
  const parsed = Date.parse(request?.updatedAt || request?.createdAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestRequestForRecord(requests, recordId) {
  return requests
    .filter((request) => request.bookRecordId === recordId)
    .sort((left, right) => requestTimestamp(right) - requestTimestamp(left))[0];
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function recordNameMap(records) {
  return new Map(records.map((record) => [record.id, record.name || "Untitled book"]));
}

function changedRequestsByState(previousState, nextState) {
  const previousRequests = new Map(
    previousState.requests.map((request) => [request.id, request]),
  );
  return nextState.requests.reduce(
    (groups, request) => {
      const previous = previousRequests.get(request.id);
      if (!previous || previous.state === request.state) {
        return groups;
      }

      if (request.state === "created") {
        groups.created.push(request);
      } else if (request.state === "failed") {
        groups.failed.push(request);
      } else if (request.state === "duplicate") {
        groups.duplicate.push(request);
      }

      return groups;
    },
    { created: [], failed: [], duplicate: [] },
  );
}

function describeRequestNames(requests, records) {
  const names = requests
    .map((request) => records.get(request.bookRecordId))
    .filter(Boolean);

  if (!names.length) {
    return "";
  }
  if (names.length === 1) {
    return names[0];
  }
  return `${names[0]} and ${names.length - 1} more`;
}

function notifyStateTransitions(previousState, nextState, toast) {
  const changed = changedRequestsByState(previousState, nextState);
  const records = recordNameMap(nextState.records);

  if (changed.created.length) {
    toast.success({
      title:
        changed.created.length === 1 ? "Book created" : "Books created",
      description:
        changed.created.length === 1
          ? `${describeRequestNames(changed.created, records)} completed successfully.`
          : `${countLabel(changed.created.length, "request")} completed successfully.`,
    });
  }

  if (changed.failed.length) {
    const firstError =
      changed.failed.find((request) => request.errorMessage)?.errorMessage ||
      "Review the Failed card for details.";
    toast.error({
      title:
        changed.failed.length === 1 ? "Request failed" : "Requests failed",
      description:
        changed.failed.length === 1
          ? firstError
          : `${countLabel(changed.failed.length, "request")} failed. ${firstError}`,
      groupKey: "processing-failed",
      holdOpenMs: AGGREGATED_NOTIFICATION_WINDOW_MS,
    });
  }

  if (changed.duplicate.length) {
    toast.info({
      title:
        changed.duplicate.length === 1
          ? "Duplicate detected"
          : "Duplicates detected",
      description:
        changed.duplicate.length === 1
          ? `${describeRequestNames(changed.duplicate, records)} needs duplicate review.`
          : `${countLabel(changed.duplicate.length, "request")} need duplicate review.`,
      groupKey: "processing-duplicate",
      holdOpenMs: AGGREGATED_NOTIFICATION_WINDOW_MS,
      soundType: "error",
    });
  }

  const previousHasActiveRequests = previousState.requests?.some((request) =>
    ACTIVE_REQUEST_STATES.includes(request.state),
  );
  const nextHasActiveRequests = nextState.requests?.some((request) =>
    ACTIVE_REQUEST_STATES.includes(request.state),
  );
  if (previousHasActiveRequests && !nextHasActiveRequests) {
    toast.success({
      title: "Pipeline complete",
      description: "All requests reached a terminal or holding state.",
    });
  }

  const previousSyncStatus = previousState.sync?.status;
  const nextSyncStatus = nextState.sync?.status;
  if (previousSyncStatus === nextSyncStatus) {
    return;
  }

  if (
    previousSyncStatus &&
    previousSyncStatus !== "idle" &&
    nextSyncStatus === "idle"
  ) {
    if (String(nextState.sync?.message || "").toLowerCase().includes("stopped")) {
      return;
    }
    toast.success(syncCompletionCopy(previousState, nextState));
    return;
  }

  if (nextSyncStatus === "paused") {
    toast.info(syncPausedCopy(nextState));
  }
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
  const [state, setState] = useState(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busyCards, setBusyCards] = useState({});
  const stateRef = useRef(state);
  const hasAppliedInitialStateRef = useRef(false);
  const location = useLocation();
  const { authenticated, loading } = useSession();
  const toast = useToast();
  const processingRouteActive = isProcessingRoute(location.pathname);
  const canLoadProcessingState =
    processingRouteActive && authenticated && !loading;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const applyServerState = useCallback((payload) => {
    const nextState = normalizeState(payload);
    const previousState = stateRef.current;
    stateRef.current = nextState;
    setState(nextState);
    setLoaded(true);
    setError("");
    if (hasAppliedInitialStateRef.current) {
      notifyStateTransitions(previousState, nextState, toast);
    } else {
      hasAppliedInitialStateRef.current = true;
    }
    return nextState;
  }, [toast]);

  const loadState = useCallback(async () => {
    try {
      const payload = await apiFetch("/processing/state/");
      return applyServerState(payload);
    } catch (loadError) {
      const message = loadError.message || "Unable to load processing state.";
      setLoaded(true);
      setError(message);
      if (![401, 403].includes(loadError?.status)) {
        toast.error(message);
      }
      throw loadError;
    }
  }, [applyServerState, toast]);

  useEffect(() => {
    if (!canLoadProcessingState) {
      return;
    }
    loadState().catch(() => {});
  }, [canLoadProcessingState, loadState]);

  const runCardAction = useCallback(
    async (cardId, request, options = {}) => {
      setBusyCards((current) => ({
        ...current,
        [cardId]: (current[cardId] || 0) + 1,
      }));
      try {
        const payload = await request();
        const nextState = applyServerState(payload);
        if (typeof options.onSuccess === "function") {
          options.onSuccess(payload, nextState, toast);
        }
        return nextState;
      } catch (actionError) {
        const message =
          options.errorMessage ||
          actionError.message ||
          "Unable to complete the action.";
        setError(message);
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
    [applyServerState, toast],
  );

  const startCatalogSync = useCallback(
    () => {
      const remotePages = catalogRemotePages(stateRef.current.sync.remotePages);
      return runCardAction(
        "catalog-sync",
        () =>
          apiFetch("/processing/sync/start/", {
            method: "POST",
            body: remotePages.length ? { remotePages } : {},
          }),
        {
          onSuccess: (_, __, nextToast) =>
            nextToast.info({
              title: "Sync started",
              description: "Catalog sync is running.",
            }),
        },
      );
    },
    [runCardAction],
  );

  const pauseCatalogSync = useCallback(
    () =>
      runCardAction(
        "catalog-sync",
        () => apiFetch("/processing/sync/pause/", { method: "POST" }),
        {
          onSuccess: (_, __, nextToast) =>
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
        () => apiFetch("/processing/sync/resume/", { method: "POST" }),
        {
          onSuccess: (_, __, nextToast) =>
            nextToast.info({
              title: "Sync resumed",
              description: "Catalog reconciliation restarted from the beginning.",
            }),
        },
      ),
    [runCardAction],
  );

  const stopSync = useCallback(
    (cardId = "catalog-sync") =>
      runCardAction(
        cardId,
        () => apiFetch("/processing/sync/stop/", { method: "POST" }),
        {
          onSuccess: (_, nextState, nextToast) =>
            nextToast.info({
              title: "Sync stopped",
              description:
                nextState?.sync?.message || "The active sync was stopped.",
            }),
        },
      ),
    [runCardAction],
  );

  const createRequestsForRecords = useCallback(
    (recordIds) =>
      runCardAction(
        "catalog-records",
        () =>
          apiFetch("/processing/records/create-requests/", {
            method: "POST",
            body: { ids: recordIds },
          }),
        {
          onSuccess: (payload, __, nextToast) => {
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
          apiFetch("/processing/automation/catalog/", {
            method: "POST",
            body: form,
          }),
        {
          onSuccess: (_, __, nextToast) =>
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
        () => apiFetch("/processing/automation/catalog/run/", { method: "POST" }),
        {
          onSuccess: (_, __, nextToast) =>
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
        () => apiFetch("/processing/sync/pause/", { method: "POST" }),
        {
          onSuccess: (_, __, nextToast) =>
            nextToast.info({
              title: "Catalog automation pausing",
              description: "Automated catalog sync will pause after the current page.",
            }),
        },
      ),
    [runCardAction],
  );

  const stopCatalogAutomation = useCallback(
    () => stopSync("catalog-automation-run"),
    [stopSync],
  );

  const saveIncompleteAutomation = useCallback(
    (form) =>
      runCardAction(
        "incomplete-automation-save",
        () =>
          apiFetch("/processing/automation/incomplete/", {
            method: "POST",
            body: form,
          }),
        {
          onSuccess: (_, __, nextToast) =>
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
        () => apiFetch("/processing/automation/incomplete/run/", { method: "POST" }),
        {
          onSuccess: (_, __, nextToast) => {
            nextToast.info({
              title: "Incomplete automation started",
              description: "Incomplete catalog sync is running.",
            });
          },
        },
      ),
    [runCardAction],
  );

  const pauseIncompleteAutomation = useCallback(
    () =>
      runCardAction(
        "incomplete-automation-run",
        () => apiFetch("/processing/sync/pause/", { method: "POST" }),
        {
          onSuccess: (_, __, nextToast) =>
            nextToast.info({
              title: "Incomplete automation pausing",
              description:
                "Incomplete catalog sync will pause after the current batch.",
            }),
        },
      ),
    [runCardAction],
  );

  const stopIncompleteAutomation = useCallback(
    () => stopSync("incomplete-automation-run"),
    [stopSync],
  );

  const applyRequestAction = useCallback(
    (cardId, requestIds, action, extra = {}) =>
      runCardAction(
        cardId,
        () =>
          apiFetch("/processing/requests/action/", {
            method: "POST",
            body: {
              ids: requestIds,
              action,
              ...extra,
            },
          }),
        {
          onSuccess: (payload, __, nextToast) =>
            notifyRequestAction(nextToast, action, payload?.changedCount || 0, extra),
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
    (cardId, requestIds) =>
      applyRequestAction(cardId, requestIds, "pause"),
    [applyRequestAction],
  );

  const resumePausedRequests = useCallback(
    (cardId, requestIds) =>
      applyRequestAction(cardId, requestIds, "resume"),
    [applyRequestAction],
  );

  const retryFailedRequests = useCallback(
    (cardId, requestIds) =>
      applyRequestAction(cardId, requestIds, "retry"),
    [applyRequestAction],
  );

  const markDuplicateRequestsAsNew = useCallback(
    (cardId, requestIds) =>
      applyRequestAction(cardId, requestIds, "new"),
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
    (cardId, requestIds) =>
      applyRequestAction(cardId, requestIds, "recreate"),
    [applyRequestAction],
  );

  useEffect(() => {
    if (!canLoadProcessingState) {
      return undefined;
    }

    const activeSync =
      state.sync.status === "syncing" || state.sync.status === "pausing";
    if (!activeSync) {
      return undefined;
    }

    const timerId = window.setInterval(async () => {
      try {
        const payload = await apiFetch("/processing/sync/advance/", {
          method: "POST",
        });
        applyServerState(payload);
      } catch (syncError) {
        toast.error(syncError.message || "Catalog sync stalled.");
        window.clearInterval(timerId);
      }
    }, Math.max(150, Number(state.ui?.syncDelayMs) || 250));

    return () => {
      window.clearInterval(timerId);
    };
  }, [
    applyServerState,
    canLoadProcessingState,
    state.sync.status,
    state.ui?.syncDelayMs,
    toast,
  ]);

  useEffect(() => {
    if (!canLoadProcessingState) {
      return undefined;
    }

    const hasActiveRequests = state.requests.some((request) =>
      ACTIVE_REQUEST_STATES.includes(request.state),
    );
    if (!hasActiveRequests) {
      return undefined;
    }

    const timerId = window.setInterval(async () => {
      try {
        const payload = await apiFetch("/processing/pipeline/advance/", {
          method: "POST",
        });
        applyServerState(payload);
      } catch (pipelineError) {
        toast.error(pipelineError.message || "Processing pipeline stalled.");
        window.clearInterval(timerId);
      }
    }, Math.max(100, Number(state.ui?.pipelineDelayMs) || 500));

    return () => {
      window.clearInterval(timerId);
    };
  }, [
    applyServerState,
    canLoadProcessingState,
    state.requests,
    state.ui?.pipelineDelayMs,
    toast,
  ]);

  const recordMap = useMemo(() => buildRecordMap(state.records), [state.records]);

  const value = useMemo(
    () => ({
      state,
      records: state.records,
      requests: state.requests,
      recordMap,
      busyCards,
      loaded,
      error,
      reload: loadState,
      isRecordSelectable: (record) => Boolean(record?.selectable),
      startCatalogSync,
      pauseCatalogSync,
      resumeCatalogSync,
      stopSync,
      createRequestsForRecords,
      saveCatalogAutomation,
      runCatalogAutomation,
      pauseCatalogAutomation,
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
      stopIncompleteAutomation,
      recreateCompletedRequests,
    }),
    [
      busyCards,
      confirmDuplicateRequests,
      createAgainRequests,
      createRequestsForRecords,
      deleteRequests,
      error,
      loaded,
      loadState,
      markDuplicateRequestsAsNew,
      pauseCatalogSync,
      pauseCatalogAutomation,
      pauseIncompleteAutomation,
      pauseRequests,
      recordMap,
      recreateCompletedRequests,
      resumeCatalogSync,
      resumePausedRequests,
      retryFailedRequests,
      runCatalogAutomation,
      runIncompleteAutomation,
      saveCatalogAutomation,
      saveIncompleteAutomation,
      stopCatalogAutomation,
      stopIncompleteAutomation,
      stopSync,
      startCatalogSync,
      state,
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

export { latestRequestForRecord };
