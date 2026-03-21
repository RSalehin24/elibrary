import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import AppShell from "./layouts/AppShell";
import AccessPage from "./pages/AccessPage";
import BookDetailPage from "./pages/BookDetailPage";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import PasswordResetPage from "./pages/PasswordResetPage";
import QueuePage from "./pages/QueuePage";
import SubmissionPage from "./pages/SubmissionPage";
import { useSession } from "./hooks/useSession";

function ProtectedRoute({ children }) {
  const { authenticated, loading } = useSession();
  const location = useLocation();

  if (loading) {
    return <div className="page-state">Loading your session...</div>;
  }

  if (!authenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return children;
}

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<PasswordResetPage />} />
        <Route path="/books/:slug" element={<BookDetailPage />} />
        <Route
          path="/submit"
          element={
            <ProtectedRoute>
              <SubmissionPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/queue"
          element={
            <ProtectedRoute>
              <QueuePage />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
