import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import LoadingSpinner from "../components/LoadingSpinner";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function LoginEmailFeedbackIcon({ valid }) {
  if (valid) {
    return (
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4.5 10.5 8 14l7.5-8.5" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 6 8 8" />
      <path d="m14 6-8 8" />
    </svg>
  );
}

export default function LoginPage() {
  const navigate = useNavigate();
  const { login } = useSession();
  const toast = useToast();
  const [phase, setPhase] = useState("credentials");
  const [form, setForm] = useState({ email: "", password: "", otp_token: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const normalizedEmail = form.email.trim();
  const hasEmailInput = normalizedEmail.length > 0;
  const emailLooksValid = EMAIL_PATTERN.test(normalizedEmail);
  const showEmailFeedback = phase === "credentials" && hasEmailInput;
  const credentialsReady =
    hasEmailInput && emailLooksValid && form.password.trim().length > 0;

  async function handleLogin(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    if (!event.currentTarget.reportValidity()) {
      return;
    }
    if (phase === "credentials" && !credentialsReady) {
      return;
    }
    try {
      setSubmitting(true);
      const user = await login({
        ...form,
        email: normalizedEmail,
        otp_token: form.otp_token.trim(),
      });
      const requiresTotpSetup = Boolean(user?.totp_setup_required);
      toast.success(
        requiresTotpSetup
          ? "Signed in. Finish two-factor setup to continue."
          : "Signed in.",
      );
      navigate(requiresTotpSetup ? "/two-factor-setup" : "/home", {
        replace: true,
      });
    } catch (error) {
      const code = error?.payload?.code;
      if (code === "otp_required") {
        setPhase("otp");
        toast.info("Enter your authenticator code to continue.");
        return;
      }

      if (code === "otp_invalid") {
        setPhase("otp");
      }

      toast.error(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  function resetPhase() {
    setPhase("credentials");
    setForm((current) => ({ ...current, otp_token: "" }));
  }

  return (
    <div className="login-shell">
      <section className={`detail-card login-card login-card-${phase}`}>
        <div className="login-header">
          <h1>{phase === "otp" ? "Verification" : "Sign in"}</h1>
        </div>
        <form className="stack-form" onSubmit={handleLogin}>
          <label>
            <span>Email</span>
            <input
              type="email"
              value={form.email}
              onChange={(event) =>
                setForm({ ...form, email: event.target.value })
              }
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              readOnly={phase === "otp"}
              required={phase === "credentials"}
              aria-describedby={
                showEmailFeedback ? "login-email-feedback" : undefined
              }
              aria-invalid={
                showEmailFeedback && !emailLooksValid ? "true" : undefined
              }
            />
            {showEmailFeedback ? (
              <span
                id="login-email-feedback"
                className={`login-email-feedback login-email-feedback-${emailLooksValid ? "valid" : "invalid"}`}
                role="status"
                aria-live="polite"
              >
                <span className="login-email-feedback-icon" aria-hidden="true">
                  <LoginEmailFeedbackIcon valid={emailLooksValid} />
                </span>
                <span>
                  {emailLooksValid
                    ? "Email looks good."
                    : "Enter a valid email address."}
                </span>
              </span>
            ) : null}
          </label>
          <label>
            <span>Password</span>
            <div className="password-input-row">
              <input
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={(event) =>
                  setForm({ ...form, password: event.target.value })
                }
                autoComplete="current-password"
                readOnly={phase === "otp"}
                required={phase === "credentials"}
              />
              <button
                type="button"
                className="password-visibility-button"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                disabled={phase === "otp"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </label>
          {phase === "otp" ? (
            <label className="login-otp-field">
              <span>TOTP code</span>
              <input
                type="text"
                value={form.otp_token}
                onChange={(event) =>
                  setForm({ ...form, otp_token: event.target.value })
                }
                autoFocus
                inputMode="numeric"
                placeholder="123456"
                required={phase === "otp"}
              />
            </label>
          ) : null}
          <div className="inline-pills login-actions">
            <button
              type="submit"
              className="primary-button"
              disabled={submitting || (phase === "credentials" && !credentialsReady)}
            >
              <span className="button-label">
                {submitting ? <LoadingSpinner size={16} /> : null}
                {submitting
                  ? phase === "otp"
                    ? "Verifying..."
                    : "Signing in..."
                  : phase === "otp"
                    ? "Verify"
                    : "Continue"}
              </span>
            </button>
            {phase === "otp" ? (
              <button
                type="button"
                className="ghost-button"
                onClick={resetPhase}
                disabled={submitting}
              >
                Change account
              </button>
            ) : (
              <Link to="/reset-password" className="ghost-button">
                Reset password
              </Link>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
