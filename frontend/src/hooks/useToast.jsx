import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import ToastViewport from "../components/ToastViewport";

const ToastContext = createContext(null);
const DEFAULT_TOAST_COPY = {
  success: {
    title: "Success",
    description: "The action completed."
  },
  error: {
    title: "Something went wrong",
    description: "Please try again."
  },
  info: {
    title: "Notice",
    description: ""
  }
};

function cleanToastText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeToast(input, fallbackType = "info") {
  const defaults = DEFAULT_TOAST_COPY[fallbackType] || DEFAULT_TOAST_COPY.info;

  if (typeof input === "string") {
    return {
      title: defaults.title,
      description: cleanToastText(input) || defaults.description,
      type: fallbackType
    };
  }

  const title = cleanToastText(input?.title || input?.message);
  const description = cleanToastText(input?.description);

  return {
    title: title || defaults.title,
    description: description || (!title ? defaults.description : ""),
    type: input?.type || fallbackType
  };
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());

  const dismiss = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (input, fallbackType = "info") => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const toast = {
        id,
        ...normalizeToast(input, fallbackType)
      };

      setToasts((current) => [...current, toast]);
      const timer = window.setTimeout(() => dismiss(id), 3600);
      timersRef.current.set(id, timer);
      return id;
    },
    [dismiss]
  );

  useEffect(
    () => () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current.clear();
    },
    []
  );

  const value = useMemo(
    () => ({
      show: push,
      info: (input) => push(input, "info"),
      success: (input) => push(input, "success"),
      error: (input) => push(input, "error"),
      dismiss
    }),
    [dismiss, push]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}
