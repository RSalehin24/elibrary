import { NavLink } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useSession } from "../hooks/useSession";

function initialsForUser(value) {
  return (value || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "?";
}

export default function AppShell({ children }) {
  const { authenticated, user, logout } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const navigation = authenticated
    ? [
        { to: "/create", label: "Create Books" },
        { to: "/created-books", label: "My Created Books" },
        { to: "/library", label: "Library" },
        { to: "/processing", label: "Processing" },
        ...(user?.is_superuser ? [{ to: "/access", label: "Users & Access" }] : [])
      ]
    : [];

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [menuOpen]);

  const displayName = user?.full_name || user?.email || "";
  const initials = initialsForUser(displayName);

  return (
    <div className="shell">
      <div className="shell-ornament shell-ornament-left" aria-hidden="true" />
      <div className="shell-ornament shell-ornament-right" aria-hidden="true" />
      <header className={authenticated ? "topbar" : "topbar topbar-public"}>
        <div className="brand-block">
          <NavLink to="/" className="brand-mark">
            Bangla Library
          </NavLink>
        </div>
        {authenticated ? (
          <nav className="topnav" aria-label="Primary">
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
            <div ref={menuRef} className="profile-menu-shell">
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
