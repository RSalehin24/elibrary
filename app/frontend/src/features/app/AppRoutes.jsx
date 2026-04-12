import { Navigate, Route, Routes } from "react-router-dom";
import AccessPage from "../../pages/AccessPage";
import BookDetailPage from "../../pages/BookDetailPage";
import CategoryPage from "../../pages/CategoryPage";
import CreateBooksPage from "../../pages/CreateBooksPage";
import CreatedBooksPage from "../../pages/CreatedBooksPage";
import HomePage from "../../pages/HomePage";
import LibraryPage from "../../pages/LibraryPage";
import LoginPage from "../../pages/LoginPage";
import ManualBooksPage from "../../pages/ManualBooksPage";
import PasswordLinkPage from "../../pages/PasswordLinkPage";
import PasswordResetPage from "../../pages/PasswordResetPage";
import ProcessingAllActivityPage from "../../pages/ProcessingAllActivityPage";
import ProcessingAutomationPage from "../../pages/ProcessingAutomationPage";
import ProcessingCatalogBooksPage from "../../pages/ProcessingCatalogBooksPage";
import ProcessingIncompleteAutomationPage from "../../pages/ProcessingIncompleteAutomationPage";
import ProcessingMyRequestsPage from "../../pages/ProcessingMyRequestsPage";
import ProfilePage from "../../pages/ProfilePage";
import ReaderPage from "../../pages/ReaderPage";
import SeriesPage from "../../pages/SeriesPage";
import TwoFactorSetupPage from "../../pages/TwoFactorSetupPage";
import WriterPage from "../../pages/WriterPage";
import ProtectedRoute from "./ProtectedRoute";

const protectedRoutes = [
  { path: "/home", element: <HomePage /> },
  { path: "/create", element: <CreateBooksPage /> },
  { path: "/library", element: <LibraryPage /> },
  { path: "/categories", element: <CategoryPage /> },
  { path: "/series", element: <SeriesPage /> },
  { path: "/writers", element: <WriterPage /> },
  { path: "/translators", element: <WriterPage /> },
  { path: "/compilers", element: <WriterPage /> },
  { path: "/editors", element: <WriterPage /> },
  { path: "/manual-books", element: <ManualBooksPage /> },
  { path: "/created-books", element: <CreatedBooksPage /> },
  { path: "/processing-my-requests", element: <ProcessingMyRequestsPage /> },
  {
    path: "/processing-catalog-books",
    element: <ProcessingCatalogBooksPage />,
  },
  { path: "/processing-automation", element: <ProcessingAutomationPage /> },
  { path: "/processing-all-activity", element: <ProcessingAllActivityPage /> },
  {
    path: "/processing-incomplete-check",
    element: <ProcessingIncompleteAutomationPage />,
  },
  { path: "/books/:slug", element: <BookDetailPage /> },
  { path: "/access", element: <AccessPage /> },
  { path: "/profile", element: <ProfilePage /> },
  { path: "/two-factor-setup", element: <TwoFactorSetupPage /> },
  { path: "/reader", element: <ReaderPage /> },
];

function renderProtectedRoute({ path, element }) {
  return (
    <Route
      key={path}
      path={path}
      element={<ProtectedRoute>{element}</ProtectedRoute>}
    />
  );
}

export default function AppRoutes() {
  return (
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
        path="/reset-password/confirm"
        element={<PasswordLinkPage mode="reset" />}
      />
      <Route
        path="/create-password"
        element={<PasswordLinkPage mode="create" />}
      />
      {protectedRoutes.map(renderProtectedRoute)}
      <Route
        path="/processing"
        element={<Navigate to="/processing-my-requests" replace />}
      />
      <Route
        path="/queue"
        element={<Navigate to="/processing-my-requests" replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
