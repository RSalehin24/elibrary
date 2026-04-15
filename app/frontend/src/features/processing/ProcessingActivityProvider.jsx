import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router-dom";
import { apiFetch } from "../../api/client";
import { useSession } from "../../hooks/useSession";
import {
  normalizeProcessingActivityPayload,
  shouldPollProcessingActivity,
} from "./helpers/activityTracker";

const ProcessingActivityContext = createContext(null);
const POLL_INTERVAL_MS = 5000;
const PERSISTENT_PAGE_STATE_STORAGE_KEY =
  "processing.persistent-page-state";

function readPersistentPageState() {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const rawValue = window.sessionStorage.getItem(
      PERSISTENT_PAGE_STATE_STORAGE_KEY,
    );
    if (!rawValue) {
      return {};
    }

    const parsedValue = JSON.parse(rawValue);
    return parsedValue && typeof parsedValue === "object" ? parsedValue : {};
  } catch {
    return {};
  }
}

function writePersistentPageState(nextValue) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      PERSISTENT_PAGE_STATE_STORAGE_KEY,
      JSON.stringify(nextValue),
    );
  } catch {
    // Ignore storage write failures and keep the in-memory fallback.
  }
}

export function ProcessingActivityProvider({ children }) {
  const location = useLocation();
  const { authenticated, loading: sessionLoading } = useSession();
  const requestIdRef = useRef(0);
  const persistentPageStateRef = useRef(null);
  if (persistentPageStateRef.current === null) {
    persistentPageStateRef.current = readPersistentPageState();
  }
  const [state, setState] = useState({
    loading: false,
    loaded: false,
    canManageProcessing: false,
    hasVisibleActivity: false,
    activeScopes: [],
  });
  const [, setPersistentPageStateVersion] = useState(0);

  useEffect(() => {
    if (
      !shouldPollProcessingActivity({
        authenticated,
        pathname: location.pathname,
        sessionLoading,
      })
    ) {
      return undefined;
    }

    let cancelled = false;

    async function loadActivity({ markLoading = false } = {}) {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      if (markLoading) {
        setState((current) => ({ ...current, loading: true }));
      }

      try {
        const payload = normalizeProcessingActivityPayload(
          await apiFetch("/ingestion/activity/"),
        );
        if (cancelled || requestId !== requestIdRef.current) {
          return;
        }
        setState({
          loading: false,
          loaded: true,
          ...payload,
        });
      } catch {
        if (cancelled || requestId !== requestIdRef.current) {
          return;
        }
        setState((current) => ({
          ...current,
          loading: false,
          loaded: true,
        }));
      }
    }

    loadActivity({ markLoading: !state.loaded }).catch(() => {});
    const intervalId = window.setInterval(() => {
      loadActivity().catch(() => {});
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [authenticated, location.pathname, sessionLoading, state.loaded]);

  const setPersistentPageState = useCallback((pageKey, field, nextValue) => {
    if (!pageKey || !field) {
      return;
    }

    const currentPageState = persistentPageStateRef.current[pageKey] || {};
    const previousValue = currentPageState[field];
    const resolvedValue =
      typeof nextValue === "function" ? nextValue(previousValue) : nextValue;

    if (Object.is(previousValue, resolvedValue)) {
      return;
    }

    persistentPageStateRef.current = {
      ...persistentPageStateRef.current,
      [pageKey]: {
        ...currentPageState,
        [field]: resolvedValue,
      },
    };
    writePersistentPageState(persistentPageStateRef.current);
    setPersistentPageStateVersion((current) => current + 1);
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      busy: state.loading || state.hasVisibleActivity,
      persistentPageState: persistentPageStateRef.current,
      setPersistentPageState,
    }),
    [setPersistentPageState, state],
  );

  return (
    <ProcessingActivityContext.Provider value={value}>
      {children}
    </ProcessingActivityContext.Provider>
  );
}

export function useProcessingActivity() {
  const context = useContext(ProcessingActivityContext);
  if (!context) {
    throw new Error(
      "useProcessingActivity must be used within ProcessingActivityProvider",
    );
  }
  return context;
}

export function usePersistentProcessingPageState(
  pageKey,
  field,
  initialValue,
  options = {},
) {
  const { persist = true } = options;
  const { persistentPageState, setPersistentPageState } = useProcessingActivity();
  const pageState = persistentPageState?.[pageKey] || {};
  const [ephemeralValue, setEphemeralValue] = useState(initialValue);
  const hasStoredValue = persist && Object.hasOwn(pageState, field);
  const value = hasStoredValue ? pageState[field] : ephemeralValue;

  const setValue = useCallback(
    (nextValue) => {
      if (!persist) {
        setEphemeralValue((previousValue) =>
          typeof nextValue === "function"
            ? nextValue(previousValue)
            : nextValue,
        );
        return;
      }

      setPersistentPageState(pageKey, field, nextValue);
    },
    [field, pageKey, persist, setPersistentPageState],
  );

  return [value, setValue];
}
