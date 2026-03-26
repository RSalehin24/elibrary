import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../hooks/useSession";
import { hasCapability } from "../utils/capabilities";

function initialsForUser(value) {
  return (
    (value || "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "?"
  );
}

const bookPropertiesItems = [
  { to: "/library", label: "Books" },
  { to: "/categories", label: "Categories" },
  { to: "/series", label: "Series" },
  { to: "/writers", label: "Writers" },
  { to: "/manual-books", label: "Physical Books' List" },
];

const processingPropertiesItems = [
  {
    to: "/processing-my-requests",
    label: "My Requests",
    capabilityRequired: false,
  },
  {
    to: "/processing-catalog-books",
    label: "Catalog Books",
    capabilityRequired: true,
  },
  {
    to: "/processing-automation",
    label: "Automation",
    capabilityRequired: true,
  },

  {
    to: "/processing-incomplete-check",
    label: "Incomplete Automation",
    capabilityRequired: true,
  },
  {
    to: "/processing-all-activity",
    label: "All Activity",
    capabilityRequired: true,
  },
];

export default function AppShell({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { authenticated, user, logout } = useSession();
  const isReaderRoute = location.pathname === "/reader";
  const readerNavHidden =
    isReaderRoute &&
    new URLSearchParams(location.search).get("appNav") !== "shown";
  const showTopbar = !readerNavHidden;
  const [menuOpen, setMenuOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [processingOpen, setProcessingOpen] = useState(false);
  const profileMenuRef = useRef(null);
  const propertiesMenuRef = useRef(null);
  const processingMenuRef = useRef(null);
  const canManageProcessing = hasCapability(user, "processing:manage");
  const visibleProcessingItems = processingPropertiesItems.filter(
    (item) => !item.capabilityRequired || canManageProcessing,
  );
  const navigation = authenticated
    ? [
        { to: "/home", label: "Home" },
        { to: "/create", label: "Create Books" },
        ...(user?.is_superuser
          ? [{ to: "/access", label: "Users & Access" }]
          : []),
      ]
    : [];
  const isBookPropertiesActive =
    location.pathname === "/library" ||
    location.pathname === "/categories" ||
    location.pathname === "/series" ||
    location.pathname === "/writers" ||
    location.pathname === "/translators" ||
    location.pathname === "/compilers" ||
    location.pathname === "/editors" ||
    location.pathname === "/manual-books" ||
    location.pathname.startsWith("/books/");
  const isProcessingPropertiesActive =
    location.pathname.startsWith("/processing");
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
  const initials = initialsForUser(displayName);

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
        <header className={authenticated ? "topbar" : "topbar topbar-public"}>
          <div className="brand-block">
            <NavLink to="/home" className="brand-mark">
              <span className="brand-mark-name">RSalehin24</span>
              <span className="brand-mark-suffix">Library</span>
            </NavLink>
          </div>
          {authenticated ? (
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
              <div ref={propertiesMenuRef} className="nav-dropdown-shell">
                <button
                  type="button"
                  className={
                    isBookPropertiesActive
                      ? "nav-link is-active nav-dropdown-trigger"
                      : "nav-link nav-dropdown-trigger"
                  }
                  onClick={() => setPropertiesOpen((current) => !current)}
                  aria-expanded={propertiesOpen}
                  aria-haspopup="menu"
                >
                  <span>Book Properties</span>
                  <span
                    className={
                      propertiesOpen
                        ? "nav-dropdown-caret is-open"
                        : "nav-dropdown-caret"
                    }
                    aria-hidden="true"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m3.5 6 4.5 4 4.5-4" />
                    </svg>
                  </span>
                </button>
                {propertiesOpen ? (
                  <div className="nav-dropdown-panel" role="menu">
                    {bookPropertiesItems.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className={({ isActive }) =>
                          isActive
                            ? "nav-dropdown-link is-active"
                            : "nav-dropdown-link"
                        }
                        onClick={() => setPropertiesOpen(false)}
                      >
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                ) : null}
              </div>
              <div ref={processingMenuRef} className="nav-dropdown-shell">
                <button
                  type="button"
                  className={
                    isProcessingPropertiesActive
                      ? "nav-link is-active nav-dropdown-trigger"
                      : "nav-link nav-dropdown-trigger"
                  }
                  onClick={() => setProcessingOpen((current) => !current)}
                  aria-expanded={processingOpen}
                  aria-haspopup="menu"
                >
                  <span>Processing</span>
                  <span
                    className={
                      processingOpen
                        ? "nav-dropdown-caret is-open"
                        : "nav-dropdown-caret"
                    }
                    aria-hidden="true"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m3.5 6 4.5 4 4.5-4" />
                    </svg>
                  </span>
                </button>
                {processingOpen ? (
                  <div className="nav-dropdown-panel" role="menu">
                    {visibleProcessingItems.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className={({ isActive }) =>
                          isActive
                            ? "nav-dropdown-link is-active"
                            : "nav-dropdown-link"
                        }
                        onClick={() => setProcessingOpen(false)}
                      >
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                ) : null}
              </div>
            </nav>
          ) : null}
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
                <div ref={profileMenuRef} className="profile-menu-shell">
                  <button
                    type="button"
                    className="profile-menu-trigger"
                    onClick={() => setMenuOpen((current) => !current)}
                    aria-expanded={menuOpen}
                    aria-haspopup="menu"
                  >
                    {user?.profile_image_url ? (
                      <img
                        className="profile-avatar"
                        src={user.profile_image_url}
                        alt={displayName}
                      />
                    ) : (
                      <div className="profile-avatar">{initials}</div>
                    )}
                  </button>
                  {menuOpen ? (
                    <div className="profile-menu-dropdown" role="menu">
                      <div className="profile-menu-summary">
                        {user?.profile_image_url ? (
                          <img
                            className="profile-avatar profile-avatar-large"
                            src={user.profile_image_url}
                            alt={displayName}
                          />
                        ) : (
                          <div className="profile-avatar profile-avatar-large">
                            {initials}
                          </div>
                        )}
                        <div className="profile-menu-meta">
                          <strong>{displayName}</strong>
                          <span>{user?.email}</span>
                        </div>
                      </div>
                      <div className="profile-menu-actions">
                        <NavLink
                          to="/profile"
                          className="profile-menu-link"
                          onClick={() => setMenuOpen(false)}
                        >
                          Profile
                        </NavLink>
                        <div className="profile-menu-divider" />
                        <button
                          type="button"
                          className="profile-menu-link profile-menu-signout"
                          onClick={async () => {
                            setMenuOpen(false);
                            await logout();
                          }}
                        >
                          <span
                            className="profile-menu-icon"
                            aria-hidden="true"
                          >
                            <svg
                              viewBox="0 0 20 20"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M8 4.75H5.75A1.75 1.75 0 0 0 4 6.5v7a1.75 1.75 0 0 0 1.75 1.75H8" />
                              <path d="M11 6.5 15 10l-4 3.5" />
                              <path d="M14.75 10H8.5" />
                            </svg>
                          </span>
                          <span>Sign Out</span>
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            ) : !isLoginRoute ? (
              <NavLink to="/login" className="ghost-button">
                Sign in
              </NavLink>
            ) : null}
          </div>
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
