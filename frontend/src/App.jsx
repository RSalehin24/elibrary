import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import AppShell from "./layouts/AppShell";
import AccessPage from "./pages/AccessPage";
import BookDetailPage from "./pages/BookDetailPage";
import CategoryPage from "./pages/CategoryPage";
import CreatedBooksPage from "./pages/CreatedBooksPage";
import HomePage from "./pages/HomePage";
import LibraryPage from "./pages/LibraryPage";
import LoginPage from "./pages/LoginPage";
import ManualBooksPage from "./pages/ManualBooksPage";
import PasswordResetPage from "./pages/PasswordResetPage";
import ProfilePage from "./pages/ProfilePage";
import QueuePage from "./pages/QueuePage";
import WriterPage from "./pages/WriterPage";
import { useSession } from "./hooks/useSession";

function ProtectedRoute({ children }) {
  const { authenticated, loading, user } = useSession();
  const location = useLocation();

  if (loading) {
    return <div className="page-state">Loading your session...</div>;
  }

  if (!authenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (user?.totp_setup_required && location.pathname !== "/profile") {
    return <Navigate to="/profile" replace state={{ from: location.pathname }} />;
  }

  return children;
}

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Navigate to="/create" replace />
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<PasswordResetPage />} />
        <Route
          path="/create"
          element={
            <ProtectedRoute>
              <HomePage />
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
          path="/writers"
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
          element={
            <ProtectedRoute>
              <QueuePage />
            </ProtectedRoute>
          }
        />
        <Route path="/queue" element={<Navigate to="/processing" replace />} />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
