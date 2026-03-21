import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "../api/client";
import { useSession } from "../hooks/useSession";

export default function LoginPage() {
  const navigate = useNavigate();
  const { login } = useSession();
  const [loginForm, setLoginForm] = useState({ email: "", password: "", otp_token: "" });
  const [registerForm, setRegisterForm] = useState({ email: "", full_name: "", password: "" });
  const [message, setMessage] = useState("");

  async function handleLogin(event) {
    event.preventDefault();
    try {
      await login(loginForm);
      navigate("/");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    try {
      await authApi.register(registerForm);
      setMessage("Account created. You can sign in now.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handlePasswordReset() {
    try {
      await authApi.passwordReset({ email: loginForm.email });
      setMessage("If that account exists, a reset link has been sent.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <div className="two-column-layout">
      <section className="detail-card">
        <p className="eyebrow">Sign in</p>
        <h1>Continue with a secured session.</h1>
        <form className="stack-form" onSubmit={handleLogin}>
          <label>
            <span>Email</span>
            <input
              type="email"
              value={loginForm.email}
              onChange={(event) => setLoginForm({ ...loginForm, email: event.target.value })}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={loginForm.password}
              onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })}
            />
          </label>
          <label>
            <span>TOTP code</span>
            <input
              type="text"
              value={loginForm.otp_token}
              onChange={(event) => setLoginForm({ ...loginForm, otp_token: event.target.value })}
              placeholder="Required only if 2FA is enabled"
            />
          </label>
          <button type="submit" className="primary-button">
            Sign in
          </button>
          <button type="button" className="ghost-button" onClick={handlePasswordReset}>
            Email reset link
          </button>
        </form>
      </section>
      <section className="detail-card">
        <p className="eyebrow">Registration</p>
        <h2>Create a submitter account</h2>
        <form className="stack-form" onSubmit={handleRegister}>
          <label>
            <span>Full name</span>
            <input
              type="text"
              value={registerForm.full_name}
              onChange={(event) => setRegisterForm({ ...registerForm, full_name: event.target.value })}
            />
          </label>
          <label>
            <span>Email</span>
            <input
              type="email"
              value={registerForm.email}
              onChange={(event) => setRegisterForm({ ...registerForm, email: event.target.value })}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={registerForm.password}
              onChange={(event) => setRegisterForm({ ...registerForm, password: event.target.value })}
            />
          </label>
          <button type="submit" className="ghost-button">
            Register
          </button>
        </form>
        {message ? <p className="form-feedback">{message}</p> : null}
      </section>
    </div>
  );
}
