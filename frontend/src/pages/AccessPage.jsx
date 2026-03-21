import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import { useSession } from "../hooks/useSession";
import { authApi } from "../api/client";
import { hasCapability } from "../utils/capabilities";

export default function AccessPage() {
  const { user, refreshSession } = useSession();
  const [grants, setGrants] = useState([]);
  const [references, setReferences] = useState({ users: [], books: [], scopes: [] });
  const [form, setForm] = useState({ user: "", book: "", scope: "", expires_at: "", notes: "" });
  const [twoFactor, setTwoFactor] = useState({ enabled: false, pending_setup: false, provisioning_uri: "", secret: "" });
  const [twoFactorToken, setTwoFactorToken] = useState("");
  const [message, setMessage] = useState("");
  const canManageAccess = hasCapability(user, "access:manage");

  async function loadGrants() {
    if (!canManageAccess) {
      return;
    }
    try {
      const [grantPayload, referencePayload] = await Promise.all([
        apiFetch("/access/grants/"),
        apiFetch("/access/references/")
      ]);
      setGrants(grantPayload);
      setReferences(referencePayload);
      if (!form.scope && referencePayload.scopes.length) {
        setForm((current) => ({ ...current, scope: referencePayload.scopes[0].value }));
      }
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function loadTwoFactor() {
    try {
      const payload = await authApi.twoFactorStatus();
      setTwoFactor((current) => ({
        ...current,
        enabled: payload.enabled,
        pending_setup: payload.pending_setup
      }));
    } catch (error) {
      setMessage(error.message);
    }
  }

  useEffect(() => {
    loadGrants();
    loadTwoFactor();
  }, [user?.id, canManageAccess]);

  async function startTwoFactorSetup() {
    try {
      const payload = await authApi.twoFactorSetup();
      setTwoFactor((current) => ({
        ...current,
        pending_setup: true,
        provisioning_uri: payload.provisioning_uri,
        secret: payload.secret
      }));
      setMessage("A fresh TOTP secret is ready. Confirm it with a code from your authenticator app.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function confirmTwoFactor(event) {
    event.preventDefault();
    try {
      await authApi.twoFactorConfirm({ token: twoFactorToken });
      setTwoFactorToken("");
      setTwoFactor({ enabled: true, pending_setup: false, provisioning_uri: "", secret: "" });
      await refreshSession();
      setMessage("Two-factor authentication is now enabled for your account.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function createGrant(event) {
    event.preventDefault();
    try {
      await apiFetch("/access/grants/", {
        method: "POST",
        body: {
          user: form.user,
          book: form.book || null,
          scope: form.scope,
          expires_at: form.expires_at || null,
          notes: form.notes
        }
      });
      setMessage("Permission grant created.");
      setForm((current) => ({ ...current, notes: "", expires_at: "" }));
      await loadGrants();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function deleteGrant(id) {
    try {
      await apiFetch(`/access/grants/${id}/`, { method: "DELETE" });
      setMessage("Permission grant revoked.");
      await loadGrants();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <div className="two-column-layout">
      <section className="detail-card">
        <p className="eyebrow">Capability Model</p>
        <h1>Access and security posture</h1>
        <p>
          Durable read and download access stay policy-driven. A successful submission can create a short-lived preview
          session, but it does not automatically grant permanent reading rights.
        </p>
        <div className="detail-facts">
          <div>
            <span className="fact-label">Current user</span>
            <strong>{user?.email}</strong>
          </div>
          <div>
            <span className="fact-label">2FA</span>
            <strong>{twoFactor.enabled ? "Enabled" : twoFactor.pending_setup ? "Pending confirmation" : "Not enabled"}</strong>
          </div>
          <div>
            <span className="fact-label">Capabilities</span>
            <strong>{(user?.capabilities || []).join(", ")}</strong>
          </div>
        </div>
        <div className="detail-card">
          <h2>Two-factor authentication</h2>
          {twoFactor.enabled ? <p>TOTP is active for this account.</p> : null}
          {!twoFactor.enabled ? (
            <>
              <button type="button" className="primary-button" onClick={startTwoFactorSetup}>
                {twoFactor.pending_setup ? "Rotate setup secret" : "Start TOTP setup"}
              </button>
              {twoFactor.secret ? <p className="mono-line">Secret: {twoFactor.secret}</p> : null}
              {twoFactor.provisioning_uri ? <p className="mono-line">{twoFactor.provisioning_uri}</p> : null}
              {twoFactor.pending_setup ? (
                <form className="stack-form" onSubmit={confirmTwoFactor}>
                  <label>
                    <span>Authenticator code</span>
                    <input
                      value={twoFactorToken}
                      onChange={(event) => setTwoFactorToken(event.target.value)}
                      placeholder="123456"
                    />
                  </label>
                  <button type="submit" className="ghost-button">
                    Confirm TOTP
                  </button>
                </form>
              ) : null}
            </>
          ) : null}
        </div>
      </section>
      <section className="detail-card">
        <p className="eyebrow">Grants</p>
        <h2>Permission assignments</h2>
        {message ? <p className="form-feedback">{message}</p> : null}
        {canManageAccess ? (
          <>
            <form className="stack-form" onSubmit={createGrant}>
              <label>
                <span>User</span>
                <select value={form.user} onChange={(event) => setForm({ ...form, user: event.target.value })}>
                  <option value="">Select a user</option>
                  {references.users.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.email}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Book scope</span>
                <select value={form.book} onChange={(event) => setForm({ ...form, book: event.target.value })}>
                  <option value="">Global grant</option>
                  {references.books.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Capability</span>
                <select value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })}>
                  {references.scopes.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Notes</span>
                <input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
              </label>
              <button type="submit" className="primary-button">
                Create grant
              </button>
            </form>
            <div className="queue-list">
              {grants.map((grant) => (
                <article key={grant.id} className="queue-card">
                  <strong>{grant.scope}</strong>
                  <p>User: {grant.user_email}</p>
                  <p>Book: {grant.book_title || "Global"}</p>
                  <p>Granted by: {grant.granted_by_email || "Unknown"}</p>
                  <button type="button" className="ghost-button" onClick={() => deleteGrant(grant.id)}>
                    Revoke
                  </button>
                </article>
              ))}
            </div>
            <div className="detail-card">
              <h2>User directory</h2>
              <div className="queue-list">
                {references.users.map((entry) => (
                  <article key={entry.id} className="queue-card">
                    <strong>{entry.name}</strong>
                    <p>{entry.email}</p>
                    <p>Capabilities: {(entry.capabilities || []).join(", ") || "submit:create"}</p>
                    <p>Grant count: {entry.grant_count}</p>
                  </article>
                ))}
              </div>
            </div>
          </>
        ) : (
          <p>This account can view its own security posture here, but grant management requires the access-manage capability.</p>
        )}
      </section>
    </div>
  );
}
