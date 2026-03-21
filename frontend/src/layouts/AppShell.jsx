import { NavLink } from "react-router-dom";
import { useSession } from "../hooks/useSession";

const navigation = [
  { to: "/", label: "Library" },
  { to: "/submit", label: "Submit" },
  { to: "/queue", label: "Queue" },
  { to: "/access", label: "Access" }
];

export default function AppShell({ children }) {
  const { authenticated, user, logout } = useSession();

  return (
    <div className="shell">
      <div className="shell-ornament shell-ornament-left" aria-hidden="true" />
      <div className="shell-ornament shell-ornament-right" aria-hidden="true" />
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-kicker">Controlled Digital Library</span>
          <NavLink to="/" className="brand-mark">
            Bangla Library
          </NavLink>
        </div>
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
        <div className="session-box">
          {authenticated ? (
            <>
              <div className="session-meta">
                <span className="session-label">Signed in</span>
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
