import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";

export default function LoginPage() {
  const navigate = useNavigate();
  const { login } = useSession();
  const toast = useToast();
  const [phase, setPhase] = useState("credentials");
  const [form, setForm] = useState({ email: "", password: "", otp_token: "" });

  async function handleLogin(event) {
    event.preventDefault();
    try {
      await login(form);
      toast.success("Signed in.");
      navigate("/");
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
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              autoComplete="username"
              readOnly={phase === "otp"}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              autoComplete="current-password"
              readOnly={phase === "otp"}
            />
          </label>
          {phase === "otp" ? (
            <label className="login-otp-field">
              <span>TOTP code</span>
              <input
                type="text"
                value={form.otp_token}
                onChange={(event) => setForm({ ...form, otp_token: event.target.value })}
                autoFocus
                inputMode="numeric"
                placeholder="123456"
              />
            </label>
          ) : null}
          <div className="inline-pills login-actions">
            <button type="submit" className="primary-button">
              {phase === "otp" ? "Verify" : "Continue"}
            </button>
            {phase === "otp" ? (
              <button type="button" className="ghost-button" onClick={resetPhase}>
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
