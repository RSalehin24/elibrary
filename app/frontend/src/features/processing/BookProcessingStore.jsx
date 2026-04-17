import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiFetch } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { ACTIVE_REQUEST_STATES } from "./types";

const ProcessingPagesContext = createContext(null);

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
};

const DEFAULT_AUTOMATION_STATE = {
  catalog: {
    enabled: false,
    interval: "daily",
    time: "02:00",
    saved: false,
    lastRunAt: null,
    statusMessage: "Not configured.",
  },
  incomplete: {
    enabled: false,
    interval: "daily",
    time: "03:00",
    saved: false,
    lastRunAt: null,
    statusMessage: "Not configured.",
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
    toast.success({
      title: "Sync complete",
      description: nextState.sync?.message || "Catalog sync completed.",
    });
    return;
  }

  if (nextSyncStatus === "paused") {
    toast.info({
      title: "Sync paused",
      description: nextState.sync?.message || "Catalog sync progress was saved.",
    });
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
  const toast = useToast();

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
      toast.error(message);
      throw loadError;
    }
  }, [applyServerState, toast]);

  useEffect(() => {
    loadState().catch(() => {});
  }, [loadState]);

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
        toast.error(message);
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
    () =>
      runCardAction(
        "catalog-sync",
        () =>
          apiFetch("/processing/sync/start/", {
            method: "POST",
            body: { remotePages: stateRef.current.sync.remotePages || [] },
          }),
        {
          onSuccess: (_, __, nextToast) =>
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
        "catalog-automation",
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
        "catalog-automation",
        () => apiFetch("/processing/automation/catalog/run/", { method: "POST" }),
        {
          onSuccess: (payload, __, nextToast) => {
            if (payload?.createdCount) {
              nextToast.success({
                title: "Catalog automation finished",
              description: `${countLabel(payload.createdCount, "request")} entered the pipeline.`,
            });
            return;
          }
          nextToast.info({
            title: "Catalog automation finished",
              description: "No eligible records were found.",
            });
          },
        },
      ),
    [runCardAction],
  );

  const saveIncompleteAutomation = useCallback(
    (form) =>
      runCardAction(
        "incomplete-automation",
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
        "incomplete-automation",
        () => apiFetch("/processing/automation/incomplete/run/", { method: "POST" }),
        {
          onSuccess: (payload, __, nextToast) => {
            if (payload?.resolvedCount) {
              nextToast.success({
                title: "Incomplete automation finished",
              description: `${countLabel(payload.resolvedCount, "book")} moved out of Incomplete.`,
            });
            return;
          }
          nextToast.info({
            title: "Incomplete automation finished",
              description: "No incomplete records were resolved.",
            });
          },
        },
      ),
    [runCardAction],
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
  }, [applyServerState, state.sync.status, state.ui?.syncDelayMs, toast]);

  useEffect(() => {
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
  }, [applyServerState, state.requests, state.ui?.pipelineDelayMs, toast]);

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
      createRequestsForRecords,
      saveCatalogAutomation,
      runCatalogAutomation,
      deleteRequests,
      pauseRequests,
      resumePausedRequests,
      retryFailedRequests,
      markDuplicateRequestsAsNew,
      confirmDuplicateRequests,
      createAgainRequests,
      saveIncompleteAutomation,
      runIncompleteAutomation,
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
