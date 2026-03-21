import { NavLink } from "react-router-dom";
import { useSession } from "../hooks/useSession";

export default function AppShell({ children }) {
  const { authenticated, user, logout } = useSession();
  const navigation = authenticated
    ? [
        { to: "/", label: "Create" },
        { to: "/library", label: "Library" },
        { to: "/queue", label: "Queue" },
        ...(user?.is_superuser ? [{ to: "/access", label: "Access" }] : [])
      ]
    : [];

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
            <>
              <div className="session-meta">
                <strong>{user?.full_name || user?.email}</strong>
              </div>
              <button type="button" className="ghost-button" onClick={logout}>
                Sign out
              </button>
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
