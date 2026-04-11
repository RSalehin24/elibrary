import {
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

export function ProcessingActivityProvider({ children }) {
  const location = useLocation();
  const { authenticated, loading: sessionLoading } = useSession();
  const requestIdRef = useRef(0);
  const [state, setState] = useState({
    loading: false,
    loaded: false,
    canManageProcessing: false,
    hasVisibleActivity: false,
    activeScopes: [],
  });

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

  const value = useMemo(
    () => ({
      ...state,
      busy: state.loading || state.hasVisibleActivity,
    }),
    [state],
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
