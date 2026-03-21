import { useEffect, useState } from "react";
import { apiFetch, authApi } from "../api/client";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";

const initialGrantForm = { user: "", book: "", scope: "", expires_at: "", notes: "" };
const initialUserForm = { email: "", full_name: "", password: "", is_active: true };

export default function AccessPage() {
  const { user, refreshSession } = useSession();
  const toast = useToast();
  const [grants, setGrants] = useState([]);
  const [references, setReferences] = useState({ users: [], books: [], scopes: [] });
  const [managedUsers, setManagedUsers] = useState([]);
  const [grantForm, setGrantForm] = useState(initialGrantForm);
  const [userForm, setUserForm] = useState(initialUserForm);
  const [twoFactor, setTwoFactor] = useState({ enabled: false, pending_setup: false, provisioning_uri: "", secret: "" });
  const [twoFactorToken, setTwoFactorToken] = useState("");
  const isSuperAdmin = Boolean(user?.is_superuser);

  async function loadTwoFactor() {
    try {
      const payload = await authApi.twoFactorStatus();
      setTwoFactor((current) => ({
        ...current,
        enabled: payload.enabled,
        pending_setup: payload.pending_setup
      }));
    } catch (error) {
      toast.error(error.message);
    }
  }

  async function loadAdminData() {
    if (!isSuperAdmin) {
      setManagedUsers([]);
      setGrants([]);
      return;
    }

    try {
      const [userPayload, grantPayload, referencePayload] = await Promise.all([
        authApi.users(),
        apiFetch("/access/grants/"),
        apiFetch("/access/references/")
      ]);
      setManagedUsers(userPayload);
      setGrants(grantPayload);
      setReferences(referencePayload);
      if (!grantForm.scope && referencePayload.scopes.length) {
        setGrantForm((current) => ({ ...current, scope: referencePayload.scopes[0].value }));
      }
    } catch (error) {
      toast.error(error.message);
    }
  }

  useEffect(() => {
    loadTwoFactor();
    loadAdminData();
  }, [user?.id, isSuperAdmin]);

  async function startTwoFactorSetup() {
    try {
      const payload = await authApi.twoFactorSetup();
      setTwoFactor((current) => ({
        ...current,
        pending_setup: true,
        provisioning_uri: payload.provisioning_uri,
        secret: payload.secret
      }));
      toast.success("TOTP setup ready.");
    } catch (error) {
      toast.error(error.message);
    }
  }

  async function confirmTwoFactor(event) {
    event.preventDefault();
    try {
      await authApi.twoFactorConfirm({ token: twoFactorToken });
      setTwoFactorToken("");
      setTwoFactor({ enabled: true, pending_setup: false, provisioning_uri: "", secret: "" });
      await refreshSession();
      toast.success("Two-factor enabled.");
    } catch (error) {
      toast.error(error.message);
    }
  }

  async function createUser(event) {
    event.preventDefault();
    try {
      await authApi.createUser(userForm);
      setUserForm(initialUserForm);
      toast.success("User created.");
      await loadAdminData();
    } catch (error) {
      toast.error(error.message);
    }
  }

  async function toggleUserActive(target) {
    try {
      await authApi.updateUser(target.id, { is_active: !target.is_active });
      toast.success(target.is_active ? "User disabled." : "User enabled.");
      await loadAdminData();
    } catch (error) {
      toast.error(error.message);
    }
  }

  async function createGrant(event) {
    event.preventDefault();
    try {
      await apiFetch("/access/grants/", {
        method: "POST",
        body: {
          user: grantForm.user,
          book: grantForm.book || null,
          scope: grantForm.scope,
          expires_at: grantForm.expires_at || null,
          notes: grantForm.notes
        }
      });
      setGrantForm((current) => ({ ...initialGrantForm, scope: current.scope }));
      toast.success("Authorization granted.");
      await loadAdminData();
    } catch (error) {
      toast.error(error.message);
    }
  }

  async function deleteGrant(id) {
    try {
      await apiFetch(`/access/grants/${id}/`, { method: "DELETE" });
      toast.success("Authorization revoked.");
      await loadAdminData();
    } catch (error) {
      toast.error(error.message);
    }
  }

  return (
    <div className="two-column-layout">
      <section className="detail-card">
        <p className="eyebrow">Security</p>
        <h1>Account</h1>
        <div className="detail-facts">
          <div>
            <span className="fact-label">Current user</span>
            <strong>{user?.email}</strong>
          </div>
          <div>
            <span className="fact-label">Role</span>
            <strong>{isSuperAdmin ? "Super admin" : "Authorized user"}</strong>
          </div>
          <div>
            <span className="fact-label">2FA</span>
            <strong>{twoFactor.enabled ? "Enabled" : twoFactor.pending_setup ? "Pending confirmation" : "Not enabled"}</strong>
          </div>
        </div>
        <div className="detail-card">
          <h2>Two-factor</h2>
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
        <p className="eyebrow">Administration</p>
        <h2>Controls</h2>
        {isSuperAdmin ? (
          <>
            <div className="detail-card">
              <h3>Create user</h3>
              <form className="stack-form" onSubmit={createUser}>
                <label>
                  <span>Full name</span>
                  <input
                    value={userForm.full_name}
                    onChange={(event) => setUserForm({ ...userForm, full_name: event.target.value })}
                  />
                </label>
                <label>
                  <span>Email</span>
                  <input
                    type="email"
                    value={userForm.email}
                    onChange={(event) => setUserForm({ ...userForm, email: event.target.value })}
                  />
                </label>
                <label>
                  <span>Temporary password</span>
                  <input
                    type="password"
                    value={userForm.password}
                    onChange={(event) => setUserForm({ ...userForm, password: event.target.value })}
                  />
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={userForm.is_active}
                    onChange={(event) => setUserForm({ ...userForm, is_active: event.target.checked })}
                  />
                  <span>Create as active user</span>
                </label>
                <button type="submit" className="primary-button">
                  Create user
                </button>
              </form>
            </div>

            <div className="detail-card">
              <h3>Authorization</h3>
              <form className="stack-form" onSubmit={createGrant}>
                <label>
                  <span>User</span>
                  <select value={grantForm.user} onChange={(event) => setGrantForm({ ...grantForm, user: event.target.value })}>
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
                  <select value={grantForm.book} onChange={(event) => setGrantForm({ ...grantForm, book: event.target.value })}>
                    <option value="">Global authorization</option>
                    {references.books.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Authorization</span>
                  <select value={grantForm.scope} onChange={(event) => setGrantForm({ ...grantForm, scope: event.target.value })}>
                    {references.scopes.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Notes</span>
                  <input
                    value={grantForm.notes}
                    onChange={(event) => setGrantForm({ ...grantForm, notes: event.target.value })}
                    placeholder="Why this access is being granted"
                  />
                </label>
                <button type="submit" className="primary-button">
                  Grant authorization
                </button>
              </form>
            </div>

            <div className="detail-card">
              <h3>Users</h3>
              <div className="queue-list">
                {managedUsers.map((entry) => (
                  <article key={entry.id} className="queue-card">
                    <strong>{entry.full_name || entry.email}</strong>
                    <p>{entry.email}</p>
                    <p>Status: {entry.is_active ? "Active" : "Disabled"}</p>
                    <p>Grant count: {entry.grant_count}</p>
                    {!entry.is_superuser ? (
                      <button type="button" className="ghost-button" onClick={() => toggleUserActive(entry)}>
                        {entry.is_active ? "Disable user" : "Enable user"}
                      </button>
                    ) : (
                      <p className="muted-copy">Super admin account</p>
                    )}
                  </article>
                ))}
              </div>
            </div>

            <div className="detail-card">
              <h3>Active grants</h3>
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
            </div>
          </>
        ) : (
          <p>Super admin controls are hidden for this account.</p>
        )}
      </section>
    </div>
  );
}
