import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import ToastViewport from "../components/ToastViewport";
import {
  createNotificationSoundPlayer,
  readNotificationSoundMuted,
  writeNotificationSoundMuted,
} from "../utils/notificationAudio";
import { createToastManager } from "../utils/toastManager";

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [manager] = useState(() =>
    createToastManager({
      initialMuted: readNotificationSoundMuted(globalThis?.localStorage),
      playSound: createNotificationSoundPlayer(),
    }),
  );
  const [snapshot, setSnapshot] = useState(() => manager.getState());

  useEffect(() => manager.subscribe(setSnapshot), [manager]);

  useEffect(() => {
    writeNotificationSoundMuted(globalThis?.localStorage, snapshot.muted);
  }, [snapshot.muted]);

  useEffect(
    () => () => {
      manager.destroy();
    },
    [manager],
  );

  const value = useMemo(
    () => ({
      show: (input) => manager.push(input),
      info: (input) => manager.push(input, "info"),
      success: (input) => manager.push(input, "success"),
      error: (input) => manager.push(input, "error"),
      dismiss: manager.dismiss,
      muted: snapshot.muted,
      setMuted: (value) => manager.setMuted(value),
      toggleMuted: () => manager.toggleMuted(),
    }),
    [manager, snapshot.muted],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={snapshot.toasts} onDismiss={manager.dismiss} />
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
