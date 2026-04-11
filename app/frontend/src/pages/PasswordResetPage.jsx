import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import LoadingSpinner from "../components/LoadingSpinner";
import PageLoader from "../components/PageLoader";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";

export default function PasswordResetPage() {
  const navigate = useNavigate();
  const { authenticated, loading, logout } = useSession();
  const [params] = useSearchParams();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const resetPayload = useMemo(
    () => ({
      uid: params.get("uid") || "",
      token: params.get("token") || "",
    }),
    [params],
  );

  const hasResetLink = Boolean(resetPayload.uid && resetPayload.token);

  async function handleLogout() {
    if (loggingOut) {
      return;
    }
    try {
      setLoggingOut(true);
      await logout();
      toast.info("Signed out. You can now reset the password.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoggingOut(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    if (!hasResetLink) {
      toast.error("Invalid reset link.");
      return;
    }

    if (password !== confirmPassword) {
      toast.error("The password fields must match.");
      return;
    }

    try {
      setSubmitting(true);
      await apiFetch("/auth/password-reset/confirm/", {
        method: "POST",
        body: {
          ...resetPayload,
          new_password: password,
        },
      });
      toast.success("Password reset complete. Please sign in.");
      navigate("/login", { replace: true });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <PageLoader label="Loading session" detail="Checking account status." />
    );
  }

  if (authenticated) {
    return (
      <div className="login-shell">
        <section className="detail-card login-card">
          <p className="eyebrow">Password reset</p>
          <h1>Log out first</h1>
          <p className="muted-copy">
            You are currently signed in. Log out before using a password reset
            link.
          </p>
          <div className="inline-pills">
            <button
              type="button"
              className="primary-button"
              onClick={handleLogout}
              disabled={loggingOut}
            >
              <span className="button-label">
                {loggingOut ? <LoadingSpinner size={16} /> : null}
                {loggingOut ? "Logging out..." : "Log out"}
              </span>
            </button>
            <Link to="/home" className="ghost-button">
              Back
            </Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="login-shell">
      <section className="detail-card login-card">
        <p className="eyebrow">Password reset</p>
        <h1>New password</h1>
        {!hasResetLink ? (
          <p className="form-feedback">
            Invalid reset link. Request a new password reset email.
          </p>
        ) : null}
        <form className="stack-form" onSubmit={handleSubmit}>
          <label>
            <span>New password</span>
            <div className="password-input-row">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="password-visibility-button"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </label>
          <label>
            <span>Confirm password</span>
            <div className="password-input-row">
              <input
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="password-visibility-button"
                onClick={() => setShowConfirmPassword((current) => !current)}
                aria-label={
                  showConfirmPassword
                    ? "Hide confirmed password"
                    : "Show confirmed password"
                }
              >
                {showConfirmPassword ? "Hide" : "Show"}
              </button>
            </div>
          </label>
          <div className="inline-pills">
            <button
              type="submit"
              className="primary-button"
              disabled={!hasResetLink || submitting}
            >
              <span className="button-label">
                {submitting ? <LoadingSpinner size={16} /> : null}
                {submitting ? "Resetting..." : "Reset password"}
              </span>
            </button>
            <Link to="/login" className="ghost-button">
              Back
            </Link>
          </div>
        </form>
      </section>
    </div>
  );
}
