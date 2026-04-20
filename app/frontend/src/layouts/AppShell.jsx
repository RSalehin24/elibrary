import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import NavDropdown from "../features/layout/NavDropdown";
import ProfileMenu from "../features/layout/ProfileMenu";
import { initialsForUser } from "../features/layout/utils";
import {
  authenticatedNavigation,
  bookPropertiesItems,
  isBookPropertiesRoute,
  isProcessingRoute,
  processingItems,
} from "../features/layout/navigation";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import { hasCapability } from "../utils/capabilities";

function MenuIcon({ open = false }) {
  if (open) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      >
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
    >
      <path d="M4.5 7.5h15M4.5 12h15M4.5 16.5h15" />
    </svg>
  );
}

function ChevronIcon({ open = false }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={open ? "M3.5 10 8 5.5 12.5 10" : "M3.5 6 8 10.5 12.5 6"} />
    </svg>
  );
}

function MobileProfileSummary({ displayName, email, profileImageUrl }) {
  const label = displayName || email || "Account";

  return (
    <div className="mobile-nav-profile">
      {profileImageUrl ? (
        <img className="profile-avatar" src={profileImageUrl} alt={label} />
      ) : (
        <div className="profile-avatar">{initialsForUser(label)}</div>
      )}
      <div className="mobile-nav-profile-copy">
        <strong>{label}</strong>
        {email ? <span>{email}</span> : null}
      </div>
    </div>
  );
}

export default function AppShell({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { authenticated, user, logout } = useSession();
  const toast = useToast();
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobilePropertiesOpen, setMobilePropertiesOpen] = useState(false);
  const [mobileProcessingOpen, setMobileProcessingOpen] = useState(false);
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
  const useAppTopbar = authenticated && !useMinimalTopbar;
  const showMobileNav = useAppTopbar && showTopbar;

  useEffect(() => {
    setMenuOpen(false);
    setPropertiesOpen(false);
    setProcessingOpen(false);
    setMobileNavOpen(false);
    setMobilePropertiesOpen(false);
    setMobileProcessingOpen(false);
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

  useEffect(() => {
    if (!mobileNavOpen) {
      return undefined;
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) {
      return undefined;
    }

    const mediaQuery = window.matchMedia("(min-width: 981px)");
    function handleChange(event) {
      if (event.matches) {
        setMobileNavOpen(false);
      }
    }

    mediaQuery.addEventListener("change", handleChange);
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    document.body.classList.toggle("app-mobile-nav-open", mobileNavOpen);
    return () => {
      document.body.classList.remove("app-mobile-nav-open");
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!showMobileNav && mobileNavOpen) {
      setMobileNavOpen(false);
    }
  }, [showMobileNav, mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) {
      return;
    }

    if (isBookPropertiesActive) {
      setMobilePropertiesOpen(true);
    }
    if (isProcessingPropertiesActive) {
      setMobileProcessingOpen(true);
    }
  }, [mobileNavOpen, isBookPropertiesActive, isProcessingPropertiesActive]);

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
            useAppTopbar
              ? "topbar topbar-app"
              : "topbar topbar-public"
          }
        >
          <div
            className={isReaderRoute ? "brand-block brand-block-reader" : "brand-block"}
          >
            <NavLink to="/home" className="brand-mark">
              <span className="brand-mark-name">RSalehin24</span>
              <span className="brand-mark-suffix">Library</span>
            </NavLink>
          </div>
          {showMobileNav ? (
            <button
              type="button"
              className={`mobile-nav-trigger${mobileNavOpen ? " is-active" : ""}`}
              onClick={() => setMobileNavOpen((current) => !current)}
              aria-expanded={mobileNavOpen}
              aria-controls="app-mobile-nav"
              aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
              data-testid="mobile-nav-trigger"
            >
              <MenuIcon open={mobileNavOpen} />
            </button>
          ) : null}
          {useAppTopbar ? (
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
                    alertsMuted={toast.muted}
                    menuOpen={menuOpen}
                    menuRef={profileMenuRef}
                    onToggle={() => setMenuOpen((current) => !current)}
                    onClose={() => setMenuOpen(false)}
                    onToggleAlerts={toast.toggleMuted}
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
      {showMobileNav ? (
        <>
          <button
            type="button"
            className={`mobile-nav-backdrop${mobileNavOpen ? " is-open" : ""}`}
            aria-hidden={mobileNavOpen ? "false" : "true"}
            tabIndex={mobileNavOpen ? 0 : -1}
            onClick={() => setMobileNavOpen(false)}
          />
          <div
            id="app-mobile-nav"
            className={`mobile-nav-panel${mobileNavOpen ? " is-open" : ""}`}
            aria-hidden={mobileNavOpen ? "false" : "true"}
          >
            <div className="mobile-nav-panel-header">
              <MobileProfileSummary
                displayName={displayName}
                email={user?.email}
                profileImageUrl={user?.profile_image_url}
              />
              <button
                type="button"
                className="mobile-nav-close"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close menu"
              >
                <MenuIcon open />
              </button>
            </div>

            <div className="mobile-nav-links">
              {navigation.map((item) => (
                <NavLink
                  key={`mobile-${item.to}`}
                  to={item.to}
                  className={({ isActive }) =>
                    isActive ? "mobile-nav-link is-active" : "mobile-nav-link"
                  }
                  onClick={() => setMobileNavOpen(false)}
                >
                  {item.label}
                </NavLink>
              ))}
              <NavLink
                to="/created-books"
                className={({ isActive }) =>
                  isActive ? "mobile-nav-link is-active" : "mobile-nav-link"
                }
                onClick={() => setMobileNavOpen(false)}
              >
                My Books
              </NavLink>
            </div>

            <div className="mobile-nav-section">
              <button
                type="button"
                className={`mobile-nav-group-toggle${
                  isBookPropertiesActive ? " is-active" : ""
                }${mobilePropertiesOpen ? " is-open" : ""}`}
                onClick={() =>
                  setMobilePropertiesOpen((current) => !current)
                }
                aria-expanded={mobilePropertiesOpen}
              >
                <span>Book Properties</span>
                <span className="mobile-nav-group-caret" aria-hidden="true">
                  <ChevronIcon open={mobilePropertiesOpen} />
                </span>
              </button>
              <div
                className={`mobile-nav-group-panel${
                  mobilePropertiesOpen ? " is-open" : ""
                }`}
              >
                {bookPropertiesItems.map((item) => (
                  <NavLink
                    key={`book-properties-${item.to}`}
                    to={item.to}
                    className={({ isActive }) =>
                      isActive
                        ? "mobile-nav-sub-link is-active"
                        : "mobile-nav-sub-link"
                    }
                    onClick={() => setMobileNavOpen(false)}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>

            <div className="mobile-nav-section">
              <button
                type="button"
                className={`mobile-nav-group-toggle${
                  isProcessingPropertiesActive ? " is-active" : ""
                }${mobileProcessingOpen ? " is-open" : ""}`}
                onClick={() =>
                  setMobileProcessingOpen((current) => !current)
                }
                aria-expanded={mobileProcessingOpen}
              >
                <span>Processing</span>
                <span className="mobile-nav-group-caret" aria-hidden="true">
                  <ChevronIcon open={mobileProcessingOpen} />
                </span>
              </button>
              <div
                className={`mobile-nav-group-panel${
                  mobileProcessingOpen ? " is-open" : ""
                }`}
              >
                {visibleProcessingItems.map((item) => (
                  <NavLink
                    key={`processing-${item.to}`}
                    to={item.to}
                    className={({ isActive }) =>
                      isActive
                        ? "mobile-nav-sub-link is-active"
                        : "mobile-nav-sub-link"
                    }
                    onClick={() => setMobileNavOpen(false)}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>

            <div className="mobile-nav-session">
              <NavLink
                to="/profile"
                className={({ isActive }) =>
                  isActive ? "mobile-nav-link is-active" : "mobile-nav-link"
                }
                onClick={() => setMobileNavOpen(false)}
              >
                Profile
              </NavLink>
              <label className="profile-menu-toggle-row mobile-nav-alerts-row">
                <div className="profile-menu-toggle-copy">
                  <span className="profile-menu-toggle-title">Alerts</span>
                </div>
                <span className="profile-menu-toggle">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={!toast.muted}
                    onChange={toast.toggleMuted}
                    data-testid="mobile-profile-alerts-toggle"
                  />
                  <span className="profile-menu-toggle-track" aria-hidden="true">
                    <span className="profile-menu-toggle-state">
                      {toast.muted ? "Off" : "On"}
                    </span>
                    <span className="profile-menu-toggle-thumb" />
                  </span>
                </span>
              </label>
              <button
                type="button"
                className="mobile-nav-link mobile-nav-logout"
                onClick={async () => {
                  setMobileNavOpen(false);
                  await logout();
                }}
              >
                Sign Out
              </button>
            </div>
          </div>
        </>
      ) : null}
      {isReaderRoute && showTopbar ? (
        <button
          type="button"
          className="reader-topbar-floating-hide"
          onClick={hideReaderTopbar}
          aria-label="Hide reader header"
          title="Hide reader header"
          data-testid="reader-hide-header-button"
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
