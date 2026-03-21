import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";

export default function PasswordResetPage() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");

  const resetPayload = useMemo(
    () => ({
      uid: params.get("uid") || "",
      token: params.get("token") || ""
    }),
    [params]
  );

  async function handleSubmit(event) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setMessage("The password fields must match.");
      return;
    }

    try {
      await apiFetch("/auth/password-reset/confirm/", {
        method: "POST",
        body: {
          ...resetPayload,
          new_password: password
        }
      });
      setMessage("Your password has been reset. You can sign in now.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <div className="two-column-layout">
      <section className="detail-card">
        <p className="eyebrow">Password reset</p>
        <h1>Choose a new password.</h1>
        <form className="stack-form" onSubmit={handleSubmit}>
          <label>
            <span>New password</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <label>
            <span>Confirm password</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
          <button type="submit" className="primary-button">
            Reset password
          </button>
        </form>
        {message ? <p className="form-feedback">{message}</p> : null}
      </section>
      <section className="detail-card">
        <p className="eyebrow">Secure access</p>
        <h2>What this does</h2>
        <p>
          This flow only changes your account password. Reader authorization, durable read permissions, and protected
          downloads remain controlled by backend grants.
        </p>
      </section>
    </div>
  );
}
