import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import { useToast } from "../hooks/useToast";

export default function PasswordResetPage() {
  const [params] = useSearchParams();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

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
      toast.error("The password fields must match.");
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
      toast.success("Password reset complete.");
    } catch (error) {
      toast.error(error.message);
    }
  }

  return (
    <div className="login-shell">
      <section className="detail-card login-card">
        <p className="eyebrow">Password reset</p>
        <h1>New password</h1>
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
          <div className="inline-pills">
            <button type="submit" className="primary-button">
              Reset password
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
