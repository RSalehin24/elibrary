import { useEffect, useRef, useState } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import AppShell from "./layouts/AppShell";
import AccessPage from "./pages/AccessPage";
import BookDetailPage from "./pages/BookDetailPage";
import CategoryPage from "./pages/CategoryPage";
import CreateBooksPage from "./pages/CreateBooksPage";
import CreatedBooksPage from "./pages/CreatedBooksPage";
import HomePage from "./pages/HomePage";
import LibraryPage from "./pages/LibraryPage";
import LoginPage from "./pages/LoginPage";
import ManualBooksPage from "./pages/ManualBooksPage";
import PasswordResetPage from "./pages/PasswordResetPage";
import ProfilePage from "./pages/ProfilePage";
import QueuePage from "./pages/QueuePage";
import ReaderPage from "./pages/ReaderPage";
import SeriesPage from "./pages/SeriesPage";
import WriterPage from "./pages/WriterPage";
import PageLoader from "./components/PageLoader";
import { useSession } from "./hooks/useSession";
import { useToast } from "./hooks/useToast";
import { probeBackendHealth } from "./api/client";

function SessionRestartHandler() {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { expireSession } = useSession();

  useEffect(() => {
    function handleSessionExpired() {
      expireSession("The application has restarted. Please log in again.");
      toast.info("The application has restarted. Please log in again.");
      if (location.pathname !== "/login") {
        navigate("/login", {
          replace: true,
          state: { from: location.pathname, reason: "app-restarted" },
        });
      }
    }

    window.addEventListener("app:session-expired", handleSessionExpired);
    return () =>
      window.removeEventListener("app:session-expired", handleSessionExpired);
  }, [expireSession, location.pathname, navigate, toast]);

  return null;
}

function BackendStatusModal() {
  const [status, setStatus] = useState(null);
  const shouldRefreshOnRecoveryRef = useRef(false);

  useEffect(() => {
    function handleBackendStatus(event) {
      const detail = event.detail || {};
      if (detail.state === "up") {
        if (shouldRefreshOnRecoveryRef.current) {
          shouldRefreshOnRecoveryRef.current = false;
          window.location.reload();
          return;
        }
        setStatus(null);
        return;
      }
      if (detail.state === "down") {
        shouldRefreshOnRecoveryRef.current = true;
        setStatus({ mode: detail.mode || "outage" });
      }
    }

    window.addEventListener("app:backend-status", handleBackendStatus);
    return () => {
      window.removeEventListener("app:backend-status", handleBackendStatus);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkHealth = async () => {
      const healthy = await probeBackendHealth();
      if (cancelled) {
        return;
      }
      if (!healthy) {
        shouldRefreshOnRecoveryRef.current = true;
        setStatus((current) => current || { mode: "outage" });
      } else {
        setStatus(null);
      }
    };

    checkHealth();
    const healthInterval = window.setInterval(checkHealth, 6000);

    return () => {
      cancelled = true;
      window.clearInterval(healthInterval);
    };
  }, []);

  useEffect(() => {
    if (!status) {
      return undefined;
    }

    let cancelled = false;
    const timer = window.setInterval(async () => {
      const healthy = await probeBackendHealth();
      if (healthy && !cancelled) {
        if (shouldRefreshOnRecoveryRef.current) {
          shouldRefreshOnRecoveryRef.current = false;
          window.location.reload();
          return;
        }
        setStatus(null);
      }
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status]);

  if (!status) {
    return null;
  }

  const waitingMessage =
    status.mode === "restarting"
      ? "Please wait a few minutes while the server restarts."
      : "Please wait a few hours and try again.";

  return (
    <div className="backend-status-overlay" role="presentation">
      <section
        className="backend-status-modal"
        role="alertdialog"
        aria-modal="true"
        aria-live="assertive"
      >
        <h2>There is an error.</h2>
        <p>{waitingMessage}</p>
      </section>
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { authenticated, loading, user } = useSession();
  const location = useLocation();

  if (loading) {
    return (
      <PageLoader
        label="Loading your session"
        detail="Checking sign-in and workspace access."
      />
    );
  }

  if (!authenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (user?.totp_setup_required && location.pathname !== "/profile") {
    return (
      <Navigate to="/profile" replace state={{ from: location.pathname }} />
    );
  }

  return children;
}

export default function App() {
  return (
    <AppShell>
      <SessionRestartHandler />
      <BackendStatusModal />
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Navigate to="/home" replace />
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<PasswordResetPage />} />
        <Route
          path="/home"
          element={
            <ProtectedRoute>
              <HomePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/create"
          element={
            <ProtectedRoute>
              <CreateBooksPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/library"
          element={
            <ProtectedRoute>
              <LibraryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/categories"
          element={
            <ProtectedRoute>
              <CategoryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/series"
          element={
            <ProtectedRoute>
              <SeriesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/writers"
          element={
            <ProtectedRoute>
              <WriterPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/translators"
          element={
            <ProtectedRoute>
              <WriterPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/compilers"
          element={
            <ProtectedRoute>
              <WriterPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/editors"
          element={
            <ProtectedRoute>
              <WriterPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/manual-books"
          element={
            <ProtectedRoute>
              <ManualBooksPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/created-books"
          element={
            <ProtectedRoute>
              <CreatedBooksPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/processing"
          element={<Navigate to="/processing-my-requests" replace />}
        />
        <Route
          path="/processing-my-requests"
          element={
            <ProtectedRoute>
              <QueuePage
                key="processing-my-requests"
                sectionKey="my-requests"
              />
            </ProtectedRoute>
          }
        />
        <Route
          path="/processing-catalog-books"
          element={
            <ProtectedRoute>
              <QueuePage
                key="processing-catalog-books"
                sectionKey="catalog-books"
              />
            </ProtectedRoute>
          }
        />
        <Route
          path="/processing-automation"
          element={
            <ProtectedRoute>
              <QueuePage key="processing-automation" sectionKey="automation" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/processing-all-activity"
          element={
            <ProtectedRoute>
              <QueuePage
                key="processing-all-activity"
                sectionKey="all-activity"
              />
            </ProtectedRoute>
          }
        />
        <Route
          path="/processing-incomplete-check"
          element={
            <ProtectedRoute>
              <QueuePage
                key="processing-incomplete-check"
                sectionKey="incomplete-monitor"
              />
            </ProtectedRoute>
          }
        />
        <Route
          path="/queue"
          element={<Navigate to="/processing-my-requests" replace />}
        />
        <Route
          path="/books/:slug"
          element={
            <ProtectedRoute>
              <BookDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/access"
          element={
            <ProtectedRoute>
              <AccessPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <ProtectedRoute>
              <ProfilePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reader"
          element={
            <ProtectedRoute>
              <ReaderPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
