import { useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { authApi } from "../api/client";
import LoadingSpinner from "../components/LoadingSpinner";
import { useToast } from "../hooks/useToast";

export default function PasswordResetPage() {
  const [params] = useSearchParams();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const uid = params.get("uid") || "";
  const token = params.get("token") || "";
  if (uid && token) {
    return (
      <Navigate
        to={`/reset-password/confirm?uid=${encodeURIComponent(uid)}&token=${encodeURIComponent(token)}`}
        replace
      />
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    try {
      setSubmitting(true);
      const response = await authApi.passwordReset({ email });
      toast.success(response?.detail || "Reset email has been sent.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <section className="detail-card login-card auth-request-card">
        <p className="eyebrow">Password reset</p>
        <h1>Reset your password</h1>
        <form className="stack-form" onSubmit={handleSubmit}>
          <label>
            <input
              type="email"
              aria-label="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
            />
          </label>
          <div className="inline-pills login-actions">
            <button
              type="submit"
              className="primary-button"
              disabled={!email.trim() || submitting}
            >
              <span className="button-label">
                {submitting ? <LoadingSpinner size={16} /> : null}
                {submitting ? "Sending..." : "Reset Password"}
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
