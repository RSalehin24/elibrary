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
import { useSession } from "../../hooks/useSession";
import { useToast } from "../../hooks/useToast";
import { hasCapability } from "../../utils/capabilities";
import {
  createCreatedNotificationBuffer,
  createdNotificationDescription,
} from "../../utils/processingCreatedNotificationBuffer";
import { ACTIVE_REQUEST_STATES } from "./types";

const ProcessingPagesContext = createContext(null);
const AGGREGATED_NOTIFICATION_WINDOW_MS = 2 * 60 * 1000;
const PROCESSING_STATE_REFRESH_MS = 15 * 1000;
const SYNC_RUN_MODE_MANUAL = "manual";
const SYNC_RUN_MODE_CATALOG_AUTOMATION = "catalog_automation";
const SYNC_RUN_MODE_INCOMPLETE_AUTOMATION = "incomplete_automation";
const INCOMPLETE_CATEGORY_KEYWORDS = [
  "incomplete",
  "unfinished",
  "অসম্পূর্ণ",
  "অসম্পূর্ণ বই",
];

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

const DEFAULT_SUMMARY = {
  catalog: {
    records: 0,
    notCreated: 0,
    active: 0,
    created: 0,
    onHold: 0,
  },
  create: {
    requests: 0,
    queue: 0,
    processing: 0,
    created: 0,
  },
  onHold: {
    paused: 0,
    failed: 0,
    duplicate: 0,
    deleted: 0,
  },
  incomplete: {
    incomplete: 0,
    resolved: 0,
  },
  notifications: {
    activeRequests: 0,
    createdCount: 0,
    failedCount: 0,
    duplicateCount: 0,
    latestFailedMessage: "",
  },
};

const DEFAULT_STATE = {
  summary: DEFAULT_SUMMARY,
  records: [],
  requests: [],
  sync: DEFAULT_SYNC_STATE,
  automation: DEFAULT_AUTOMATION_STATE,
  ui: {
    pipelineDelayMs: 500,
  },
};
const PROCESSING_SUMMARY_QUERY = "?includeLists=0";

function processingSummaryPath(path) {
  return `${path}${PROCESSING_SUMMARY_QUERY}`;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isIncompleteCategory(value) {
  const normalized = normalizeText(value);
  return INCOMPLETE_CATEGORY_KEYWORDS.some((keyword) =>
    normalized.includes(keyword.toLowerCase()),
  );
}

function isCatalogRemotePage(page) {
  return (
    Array.isArray(page) &&
    page.every(
      (item) => item && typeof item === "object" && !Array.isArray(item),
    )
  );
}

function catalogRemotePages(remotePages) {
  return Array.isArray(remotePages) && remotePages.every(isCatalogRemotePage)
    ? remotePages
    : [];
}

function deriveSummary(records, requests) {
  const requestCounts = requests.reduce(
    (counts, request) => ({
      ...counts,
      [request.state]: (counts[request.state] || 0) + 1,
    }),
    {},
  );
  const activeRequests = ACTIVE_REQUEST_STATES.reduce(
    (total, state) => total + (requestCounts[state] || 0),
    0,
  );
  const onHoldRequests = ["paused", "failed", "duplicate", "deleted"].reduce(
    (total, state) => total + (requestCounts[state] || 0),
    0,
  );
  const latestFailedMessage =
    requests.find(
      (request) => request.state === "failed" && request.errorMessage,
    )?.errorMessage || "";

  return {
    catalog: {
      records: records.length,
      notCreated: records.filter(
        (record) => record.bookCreationState === "not_created",
      ).length,
      active: activeRequests,
      created: requestCounts.created || 0,
      onHold: onHoldRequests,
    },
    create: {
      requests: requestCounts.initial || 0,
      queue: requestCounts.queued || 0,
      processing: requestCounts.processing || 0,
      created: requestCounts.created || 0,
    },
    onHold: {
      paused: requestCounts.paused || 0,
      failed: requestCounts.failed || 0,
      duplicate: requestCounts.duplicate || 0,
      deleted: requestCounts.deleted || 0,
    },
    incomplete: {
      incomplete: records.filter(
        (record) =>
          (record.wasIncomplete || isIncompleteCategory(record.category)) &&
          !record.resolvedFromIncomplete,
      ).length,
      resolved: records.filter(
        (record) => record.wasIncomplete && record.resolvedFromIncomplete,
      ).length,
    },
    notifications: {
      activeRequests,
      createdCount: requestCounts.created || 0,
      failedCount: requestCounts.failed || 0,
      duplicateCount: requestCounts.duplicate || 0,
      latestFailedMessage,
    },
  };
}

function normalizeState(payload) {
  const state = payload && typeof payload === "object" ? payload : {};
  const records = Array.isArray(state.records) ? state.records : [];
  const requests = Array.isArray(state.requests) ? state.requests : [];
  const fallbackSummary = deriveSummary(records, requests);
  return {
    summary: {
      ...DEFAULT_SUMMARY,
      ...fallbackSummary,
      ...(state.summary || {}),
      catalog: {
        ...DEFAULT_SUMMARY.catalog,
        ...fallbackSummary.catalog,
        ...(state.summary?.catalog || {}),
      },
      create: {
        ...DEFAULT_SUMMARY.create,
        ...fallbackSummary.create,
        ...(state.summary?.create || {}),
      },
      onHold: {
        ...DEFAULT_SUMMARY.onHold,
        ...fallbackSummary.onHold,
        ...(state.summary?.onHold || {}),
      },
      incomplete: {
        ...DEFAULT_SUMMARY.incomplete,
        ...fallbackSummary.incomplete,
        ...(state.summary?.incomplete || {}),
      },
      notifications: {
        ...DEFAULT_SUMMARY.notifications,
        ...fallbackSummary.notifications,
        ...(state.summary?.notifications || {}),
      },
    },
    records,
    requests,
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
        nextState.sync?.message ||
        "Incomplete catalog sync progress was saved.",
    };
  }
  return {
    title: "Sync paused",
    description: nextState.sync?.message || "Catalog sync progress was saved.",
  };
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function notifyStateTransitions(previousState, nextState, toast, options = {}) {
  const handleCreatedCompletions =
    typeof options.handleCreatedCompletions === "function"
      ? options.handleCreatedCompletions
      : () => {};
  const previousNotifications =
    previousState.summary?.notifications || DEFAULT_SUMMARY.notifications;
  const nextNotifications =
    nextState.summary?.notifications || DEFAULT_SUMMARY.notifications;
  const createdDelta = Math.max(
    0,
    (nextNotifications.createdCount || 0) -
      (previousNotifications.createdCount || 0),
  );
  const failedDelta = Math.max(
    0,
    (nextNotifications.failedCount || 0) -
      (previousNotifications.failedCount || 0),
  );
  const duplicateDelta = Math.max(
    0,
    (nextNotifications.duplicateCount || 0) -
      (previousNotifications.duplicateCount || 0),
  );
  const previousHasActiveRequests =
    (previousNotifications.activeRequests || 0) > 0;
  const nextHasActiveRequests = (nextNotifications.activeRequests || 0) > 0;
  const nextQueueCount = nextState.summary?.create?.queue || 0;
  const nextProcessingCount = nextState.summary?.create?.processing || 0;
  const pipelineDrained = nextQueueCount === 0 && nextProcessingCount === 0;

  if (createdDelta > 0) {
    handleCreatedCompletions(createdDelta, {
      flushImmediately: pipelineDrained,
    });
  } else if (pipelineDrained) {
    handleCreatedCompletions(0, { flushImmediately: true });
  }

  if (failedDelta) {
    const firstError =
      nextNotifications.latestFailedMessage ||
      "Review the Failed card for details.";
    toast.error({
      title: failedDelta === 1 ? "Request failed" : "Requests failed",
      description:
        failedDelta === 1
          ? firstError
          : `${countLabel(failedDelta, "request")} failed. ${firstError}`,
      groupKey: "processing-failed",
      holdOpenMs: AGGREGATED_NOTIFICATION_WINDOW_MS,
    });
  }

  if (duplicateDelta) {
    toast.info({
      title:
        duplicateDelta === 1 ? "Duplicate detected" : "Duplicates detected",
      description:
        duplicateDelta === 1
          ? "A request needs duplicate review."
          : `${countLabel(duplicateDelta, "request")} need duplicate review.`,
      groupKey: "processing-duplicate",
      holdOpenMs: AGGREGATED_NOTIFICATION_WINDOW_MS,
      soundType: "error",
    });
  }

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
    if (
      String(nextState.sync?.message || "")
        .toLowerCase()
        .includes("stopped")
    ) {
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
  const [stateVersion, setStateVersion] = useState(0);
  const stateRef = useRef(state);
  const hasAppliedInitialStateRef = useRef(false);
  const syncAdvanceInFlightRef = useRef(false);
  const syncControlInFlightRef = useRef(false);
  const pipelineAdvanceInFlightRef = useRef(false);
  const { authenticated, loading, user } = useSession();
  const toast = useToast();
  const canLoadProcessingState =
    authenticated && !loading && hasCapability(user, "processing:manage");

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const createdNotificationBuffer = useMemo(
    () =>
      createCreatedNotificationBuffer({
        onFlush: (completedCount) => {
          toast.success({
            title: completedCount === 1 ? "Book created" : "Books created",
            description: createdNotificationDescription(completedCount),
          });
        },
      }),
    [toast],
  );

  useEffect(
    () => () => {
      createdNotificationBuffer.destroy();
    },
    [createdNotificationBuffer],
  );

  const handleCreatedCompletions = useCallback(
    (createdDelta, { flushImmediately = false } = {}) => {
      if (createdDelta > 0) {
        createdNotificationBuffer.addCompletedCount(createdDelta);
      }
      if (flushImmediately) {
        createdNotificationBuffer.flushIfPending();
      }
    },
    [createdNotificationBuffer],
  );

  const applyServerState = useCallback(
    (payload) => {
      const nextState = normalizeState(payload);
      const previousState = stateRef.current;
      stateRef.current = nextState;
      setState(nextState);
      setStateVersion((current) => current + 1);
      setLoaded(true);
      setError("");
      if (hasAppliedInitialStateRef.current) {
        notifyStateTransitions(previousState, nextState, toast, {
          handleCreatedCompletions,
        });
      } else {
        hasAppliedInitialStateRef.current = true;
      }
      return nextState;
    },
    [handleCreatedCompletions, toast],
  );

  const loadState = useCallback(async () => {
    try {
      const payload = await apiFetch(
        processingSummaryPath("/processing/state/"),
      );
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

  useEffect(() => {
    if (!canLoadProcessingState) {
      return undefined;
    }

    const hasActiveRequests =
      (state.summary?.notifications?.activeRequests || 0) > 0;
    const activeSync =
      state.sync.status === "syncing" ||
      state.sync.status === "pausing" ||
      state.sync.status === "paused";
    if (hasActiveRequests || activeSync) {
      return undefined;
    }

    const timerId = window.setInterval(() => {
      loadState().catch(() => {});
    }, PROCESSING_STATE_REFRESH_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, [
    canLoadProcessingState,
    loadState,
    state.summary?.notifications?.activeRequests,
    state.sync.status,
  ]);

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

  const runSyncControlAction = useCallback(
    async (cardId, request, options = {}) => {
      syncControlInFlightRef.current = true;
      try {
        return await runCardAction(cardId, request, options);
      } finally {
        syncControlInFlightRef.current = false;
      }
    },
    [runCardAction],
  );

  const startCatalogSync = useCallback(() => {
    const remotePages = catalogRemotePages(stateRef.current.sync.remotePages);
    return runSyncControlAction(
      "catalog-sync",
      () =>
        apiFetch(processingSummaryPath("/processing/sync/start/"), {
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
  }, [runSyncControlAction]);

  const pauseCatalogSync = useCallback(
    () =>
      runSyncControlAction(
        "catalog-sync",
        () =>
          apiFetch(processingSummaryPath("/processing/sync/pause/"), {
            method: "POST",
          }),
        {
          onSuccess: (_, __, nextToast) =>
            nextToast.info({
              title: "Pause requested",
              description: "Catalog sync will pause after the current page.",
            }),
        },
      ),
    [runSyncControlAction],
  );

  const resumeCatalogSync = useCallback(
    () =>
      runSyncControlAction(
        "catalog-sync",
        () =>
          apiFetch(processingSummaryPath("/processing/sync/resume/"), {
            method: "POST",
          }),
        {
          onSuccess: (_, __, nextToast) =>
            nextToast.info({
              title: "Sync resumed",
              description:
                "Catalog reconciliation restarted from the beginning.",
            }),
        },
      ),
    [runSyncControlAction],
  );

  const stopSync = useCallback(
    (cardId = "catalog-sync") =>
      runSyncControlAction(
        cardId,
        () =>
          apiFetch(processingSummaryPath("/processing/sync/stop/"), {
            method: "POST",
          }),
        {
          onSuccess: (_, nextState, nextToast) =>
            nextToast.info({
              title: "Sync stopped",
              description:
                nextState?.sync?.message || "The active sync was stopped.",
            }),
        },
      ),
    [runSyncControlAction],
  );

  const createRequestsForRecords = useCallback(
    (recordIds) =>
      runCardAction(
        "catalog-records",
        () =>
          apiFetch(
            processingSummaryPath("/processing/records/create-requests/"),
            {
              method: "POST",
              body: { ids: recordIds },
            },
          ),
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
          apiFetch(processingSummaryPath("/processing/automation/catalog/"), {
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
      runSyncControlAction(
        "catalog-automation-run",
        () =>
          apiFetch(
            processingSummaryPath("/processing/automation/catalog/run/"),
            {
              method: "POST",
            },
          ),
        {
          onSuccess: (_, __, nextToast) =>
            nextToast.info({
              title: "Catalog automation started",
              description: "Automated catalog sync is running.",
            }),
        },
      ),
    [runSyncControlAction],
  );

  const pauseCatalogAutomation = useCallback(
    () =>
      runSyncControlAction(
        "catalog-automation-run",
        () =>
          apiFetch(processingSummaryPath("/processing/sync/pause/"), {
            method: "POST",
          }),
        {
          onSuccess: (_, __, nextToast) =>
            nextToast.info({
              title: "Catalog automation pausing",
              description:
                "Automated catalog sync will pause after the current page.",
            }),
        },
      ),
    [runSyncControlAction],
  );

  const stopCatalogAutomation = useCallback(
    () => stopSync("catalog-automation-run"),
    [stopSync],
  );

  const resumeCatalogAutomation = useCallback(
    () =>
      runSyncControlAction(
        "catalog-automation-run",
        () =>
          apiFetch(processingSummaryPath("/processing/sync/resume/"), {
            method: "POST",
          }),
        {
          onSuccess: (_, __, nextToast) =>
            nextToast.info({
              title: "Catalog automation resumed",
              description:
                "Automated catalog sync restarted from the beginning.",
            }),
        },
      ),
    [runSyncControlAction],
  );

  const saveIncompleteAutomation = useCallback(
    (form) =>
      runCardAction(
        "incomplete-automation-save",
        () =>
          apiFetch(
            processingSummaryPath("/processing/automation/incomplete/"),
            {
              method: "POST",
              body: form,
            },
          ),
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
      runSyncControlAction(
        "incomplete-automation-run",
        () =>
          apiFetch(
            processingSummaryPath("/processing/automation/incomplete/run/"),
            {
              method: "POST",
            },
          ),
        {
          onSuccess: (_, __, nextToast) => {
            nextToast.info({
              title: "Incomplete automation started",
              description: "Incomplete catalog sync is running.",
            });
          },
        },
      ),
    [runSyncControlAction],
  );

  const pauseIncompleteAutomation = useCallback(
    () =>
      runSyncControlAction(
        "incomplete-automation-run",
        () =>
          apiFetch(processingSummaryPath("/processing/sync/pause/"), {
            method: "POST",
          }),
        {
          onSuccess: (_, __, nextToast) =>
            nextToast.info({
              title: "Incomplete automation pausing",
              description:
                "Incomplete catalog sync will pause after the current batch.",
            }),
        },
      ),
    [runSyncControlAction],
  );

  const stopIncompleteAutomation = useCallback(
    () => stopSync("incomplete-automation-run"),
    [stopSync],
  );

  const resumeIncompleteAutomation = useCallback(
    () =>
      runSyncControlAction(
        "incomplete-automation-run",
        () =>
          apiFetch(processingSummaryPath("/processing/sync/resume/"), {
            method: "POST",
          }),
        {
          onSuccess: (_, __, nextToast) =>
            nextToast.info({
              title: "Incomplete automation resumed",
              description:
                "Incomplete catalog sync restarted from the remaining records.",
            }),
        },
      ),
    [runSyncControlAction],
  );

  const applyRequestAction = useCallback(
    (cardId, requestIds, action, extra = {}) =>
      runCardAction(
        cardId,
        () =>
          apiFetch(processingSummaryPath("/processing/requests/action/"), {
            method: "POST",
            body: {
              ids: requestIds,
              action,
              ...extra,
            },
          }),
        {
          onSuccess: (payload, __, nextToast) =>
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

  useEffect(() => {
    if (!canLoadProcessingState) {
      return undefined;
    }

    const activeSync =
      state.sync.status === "syncing" || state.sync.status === "pausing";
    if (!activeSync) {
      return undefined;
    }

    const timerId = window.setInterval(
      async () => {
        if (
          syncAdvanceInFlightRef.current ||
          syncControlInFlightRef.current
        ) {
          return;
        }
        syncAdvanceInFlightRef.current = true;
        try {
          const payload = await apiFetch(
            processingSummaryPath("/processing/sync/advance/"),
            {
              method: "POST",
            },
          );
          applyServerState(payload);
        } catch (syncError) {
          toast.error(syncError.message || "Catalog sync stalled.");
          window.clearInterval(timerId);
        } finally {
          syncAdvanceInFlightRef.current = false;
        }
      },
      Math.max(150, Number(state.ui?.syncDelayMs) || 250),
    );

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

    const hasActiveRequests =
      (state.summary?.notifications?.activeRequests || 0) > 0;
    if (!hasActiveRequests) {
      return undefined;
    }

    const timerId = window.setInterval(
      async () => {
        if (pipelineAdvanceInFlightRef.current) {
          return;
        }
        pipelineAdvanceInFlightRef.current = true;
        try {
          const payload = await apiFetch(
            processingSummaryPath("/processing/pipeline/advance/"),
            {
              method: "POST",
            },
          );
          applyServerState(payload);
        } catch (pipelineError) {
          toast.error(pipelineError.message || "Processing pipeline stalled.");
          window.clearInterval(timerId);
        } finally {
          pipelineAdvanceInFlightRef.current = false;
        }
      },
      Math.max(100, Number(state.ui?.pipelineDelayMs) || 500),
    );

    return () => {
      window.clearInterval(timerId);
    };
  }, [
    applyServerState,
    canLoadProcessingState,
    state.summary?.notifications?.activeRequests,
    state.ui?.pipelineDelayMs,
    toast,
  ]);

  const value = useMemo(
    () => ({
      state,
      busyCards,
      loaded,
      error,
      stateVersion,
      canLoadProcessingState,
      reload: loadState,
      startCatalogSync,
      pauseCatalogSync,
      resumeCatalogSync,
      stopSync,
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
      error,
      loaded,
      loadState,
      markDuplicateRequestsAsNew,
      pauseCatalogSync,
      pauseCatalogAutomation,
      resumeCatalogAutomation,
      pauseIncompleteAutomation,
      pauseRequests,
      recreateCompletedRequests,
      resumeCatalogSync,
      resumeIncompleteAutomation,
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
      stateVersion,
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
