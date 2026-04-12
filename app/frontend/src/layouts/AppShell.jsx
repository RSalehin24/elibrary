import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import NavDropdown from "../features/layout/NavDropdown";
import ProfileMenu from "../features/layout/ProfileMenu";
import {
  authenticatedNavigation,
  bookPropertiesItems,
  isBookPropertiesRoute,
  isProcessingRoute,
  processingItems,
} from "../features/layout/navigation";
import { useSession } from "../hooks/useSession";
import { hasCapability } from "../utils/capabilities";

export default function AppShell({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { authenticated, user, logout } = useSession();
  const isReaderRoute = location.pathname === "/reader";
  const isCreatePasswordRoute = location.pathname === "/create-password";
  const isTotpSetupRoute = location.pathname === "/two-factor-setup";
  const readerNavHidden =
    isReaderRoute &&
    new URLSearchParams(location.search).get("appNav") !== "shown";
  const showTopbar = !readerNavHidden;
  const useMinimalTopbar = isTotpSetupRoute || isCreatePasswordRoute;
  const [menuOpen, setMenuOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [processingOpen, setProcessingOpen] = useState(false);
  const profileMenuRef = useRef(null);
  const propertiesMenuRef = useRef(null);
  const processingMenuRef = useRef(null);
  const canManageProcessing = hasCapability(user, "processing:manage");
  const visibleProcessingItems = processingItems.filter(
    (item) => !item.capabilityRequired || canManageProcessing,
  );
  const navigation = authenticated ? authenticatedNavigation(user) : [];
  const isBookPropertiesActive = isBookPropertiesRoute(location.pathname);
  const isProcessingPropertiesActive = isProcessingRoute(location.pathname);
  const isLoginRoute = location.pathname === "/login";

  useEffect(() => {
    setMenuOpen(false);
    setPropertiesOpen(false);
    setProcessingOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen && !propertiesOpen && !processingOpen) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (
        profileMenuRef.current &&
        !profileMenuRef.current.contains(event.target)
      ) {
        setMenuOpen(false);
      }

      if (
        propertiesMenuRef.current &&
        !propertiesMenuRef.current.contains(event.target)
      ) {
        setPropertiesOpen(false);
      }

      if (
        processingMenuRef.current &&
        !processingMenuRef.current.contains(event.target)
      ) {
        setProcessingOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [menuOpen, propertiesOpen, processingOpen]);

  const displayName = user?.full_name || user?.email || "";

  function hideReaderTopbar() {
    if (!isReaderRoute) {
      return;
    }

    const nextParams = new URLSearchParams(location.search);
    nextParams.set("appNav", "hidden");
    navigate(
      {
        pathname: location.pathname,
        search: `?${nextParams.toString()}`,
      },
      { replace: true },
    );
  }

  return (
    <div className={isReaderRoute ? "shell shell-reader-mode" : "shell"}>
      {!isReaderRoute ? (
        <div
          className="shell-ornament shell-ornament-left"
          aria-hidden="true"
        />
      ) : null}
      {!isReaderRoute ? (
        <div
          className="shell-ornament shell-ornament-right"
          aria-hidden="true"
        />
      ) : null}
      {showTopbar ? (
        <header
          className={
            authenticated && !useMinimalTopbar
              ? "topbar"
              : "topbar topbar-public"
          }
        >
          <div className="brand-block">
            <NavLink to="/home" className="brand-mark">
              <span className="brand-mark-name">RSalehin24</span>
              <span className="brand-mark-suffix">Library</span>
            </NavLink>
          </div>
          {authenticated && !useMinimalTopbar ? (
            <nav className="topnav" aria-label="Primary">
              {navigation.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    isActive ? "nav-link is-active" : "nav-link"
                  }
                >
                  {item.label}
                </NavLink>
              ))}
              <NavDropdown
                menuRef={propertiesMenuRef}
                active={isBookPropertiesActive}
                open={propertiesOpen}
                label="Book Properties"
                items={bookPropertiesItems}
                onToggle={() => setPropertiesOpen((current) => !current)}
                onItemClick={() => setPropertiesOpen(false)}
              />
              <NavDropdown
                menuRef={processingMenuRef}
                active={isProcessingPropertiesActive}
                open={processingOpen}
                label="Processing"
                items={visibleProcessingItems}
                onToggle={() => setProcessingOpen((current) => !current)}
                onItemClick={() => setProcessingOpen(false)}
              />
            </nav>
          ) : null}
          {!useMinimalTopbar ? (
            <div className="session-box">
              {authenticated ? (
                <>
                  <NavLink
                    to="/created-books"
                    className={({ isActive }) =>
                      isActive ? "nav-link is-active" : "nav-link"
                    }
                  >
                    My Books
                  </NavLink>
                  <ProfileMenu
                    displayName={displayName}
                    email={user?.email}
                    profileImageUrl={user?.profile_image_url}
                    menuOpen={menuOpen}
                    menuRef={profileMenuRef}
                    onToggle={() => setMenuOpen((current) => !current)}
                    onClose={() => setMenuOpen(false)}
                    onLogout={async () => {
                      setMenuOpen(false);
                      await logout();
                    }}
                  />
                </>
              ) : !isLoginRoute ? (
                <NavLink to="/login" className="ghost-button">
                  Sign in
                </NavLink>
              ) : null}
            </div>
          ) : null}
        </header>
      ) : null}
      {isReaderRoute && showTopbar ? (
        <button
          type="button"
          className="reader-topbar-floating-hide"
          onClick={hideReaderTopbar}
          aria-label="Hide reader header"
          title="Hide reader header"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3.25" y="4" width="17.5" height="15.5" rx="2.3" ry="2.3" />
            <path d="M3.5 9h17" />
            <path d="M12 16.5v-4M10.5 14l1.5-1.5 1.5 1.5" />
          </svg>
        </button>
      ) : null}
      <main
        className={
          isReaderRoute ? "page-shell page-shell-reader" : "page-shell"
        }
      >
        {children}
      </main>
    </div>
  );
}
