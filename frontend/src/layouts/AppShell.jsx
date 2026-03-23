import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useSession } from "../hooks/useSession";

function initialsForUser(value) {
  return (value || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "?";
}

const bookPropertiesItems = [
  { to: "/library", label: "Book Page" },
  { to: "/categories", label: "Category Page" },
  { to: "/writers", label: "Writer Page" },
  { to: "/manual-books", label: "Manual Books Page" }
];

export default function AppShell({ children }) {
  const location = useLocation();
  const { authenticated, user, logout } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const profileMenuRef = useRef(null);
  const propertiesMenuRef = useRef(null);
  const navigation = authenticated
    ? [
        { to: "/create", label: "Create Books" },
        { to: "/processing", label: "Processing" },
        ...(user?.is_superuser ? [{ to: "/access", label: "Users & Access" }] : [])
      ]
    : [];
  const isBookPropertiesActive =
    location.pathname === "/library" ||
    location.pathname === "/categories" ||
    location.pathname === "/writers" ||
    location.pathname === "/manual-books" ||
    location.pathname.startsWith("/books/");

  useEffect(() => {
    setMenuOpen(false);
    setPropertiesOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen && !propertiesOpen) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }

      if (propertiesMenuRef.current && !propertiesMenuRef.current.contains(event.target)) {
        setPropertiesOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [menuOpen, propertiesOpen]);

  const displayName = user?.full_name || user?.email || "";
  const initials = initialsForUser(displayName);

  return (
    <div className="shell">
      <div className="shell-ornament shell-ornament-left" aria-hidden="true" />
      <div className="shell-ornament shell-ornament-right" aria-hidden="true" />
      <header className={authenticated ? "topbar" : "topbar topbar-public"}>
        <div className="brand-block">
          <NavLink to="/library" className="brand-mark">
            <span className="brand-mark-name">RSalehin24</span>
            <span className="brand-mark-suffix">Library</span>
          </NavLink>
        </div>
        {authenticated ? (
          <nav className="topnav" aria-label="Primary">
            <div ref={propertiesMenuRef} className="nav-dropdown-shell">
              <button
                type="button"
                className={isBookPropertiesActive ? "nav-link is-active nav-dropdown-trigger" : "nav-link nav-dropdown-trigger"}
                onClick={() => setPropertiesOpen((current) => !current)}
                aria-expanded={propertiesOpen}
                aria-haspopup="menu"
              >
                <span>Book Properties</span>
                <span className={propertiesOpen ? "nav-dropdown-caret is-open" : "nav-dropdown-caret"} aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
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
                      className={({ isActive }) => (isActive ? "nav-dropdown-link is-active" : "nav-dropdown-link")}
                      onClick={() => setPropertiesOpen(false)}
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              ) : null}
            </div>
            {navigation.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => (isActive ? "nav-link is-active" : "nav-link")}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        ) : null}
        <div className="session-box">
          {authenticated ? (
            <>
              <NavLink
                to="/created-books"
                className={({ isActive }) => (isActive ? "nav-link is-active" : "nav-link")}
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
                    <img className="profile-avatar" src={user.profile_image_url} alt={displayName} />
                  ) : (
                    <div className="profile-avatar">{initials}</div>
                  )}
                </button>
                {menuOpen ? (
                  <div className="profile-menu-dropdown" role="menu">
                    <div className="profile-menu-summary">
                      {user?.profile_image_url ? (
                        <img className="profile-avatar profile-avatar-large" src={user.profile_image_url} alt={displayName} />
                      ) : (
                        <div className="profile-avatar profile-avatar-large">{initials}</div>
                      )}
                      <div className="profile-menu-meta">
                        <strong>{displayName}</strong>
                        <span>{user?.email}</span>
                      </div>
                    </div>
                    <div className="profile-menu-actions">
                      <NavLink to="/profile" className="profile-menu-link" onClick={() => setMenuOpen(false)}>
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
                        <span className="profile-menu-icon" aria-hidden="true">
                          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
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
          ) : (
            <NavLink to="/login" className="ghost-button">
              Sign in
            </NavLink>
          )}
        </div>
      </header>
      <main className="page-shell">{children}</main>
    </div>
  );
}
