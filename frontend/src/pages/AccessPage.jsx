import { useEffect, useMemo, useState } from "react";
import { apiFetch, authApi } from "../api/client";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";

const initialReferences = {
  books: [],
  categories: [],
  writers: [],
  account_scopes: [],
  scoped_scopes: []
};

const initialGrantForm = {
  user: "",
  scopes: [],
  targetType: "book",
  targetIds: []
};

function generateSuggestedPassword(length = 18) {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const randomValues = new Uint32Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(randomValues);
  } else {
    for (let index = 0; index < length; index += 1) {
      randomValues[index] = Math.floor(Math.random() * characters.length);
    }
  }
  return Array.from(randomValues, (value) => characters[value % characters.length]).join("");
}

function createInitialUserForm() {
  return {
    email: "",
    full_name: "",
    password: "",
    is_active: true,
    totp_required: false,
    global_scopes: []
  };
}

function sortValues(values) {
  return [...values].sort((left, right) => `${left}`.localeCompare(`${right}`));
}

function formatApiError(error, labelMap = {}) {
  if (error?.payload && typeof error.payload === "object" && !Array.isArray(error.payload)) {
    for (const [field, value] of Object.entries(error.payload)) {
      const label = labelMap[field] || field;
      if (Array.isArray(value) && value.length) {
        return `${label}: ${value[0]}`;
      }
      if (typeof value === "string") {
        return `${label}: ${value}`;
      }
    }
  }
  return error.message;
}

export default function AccessPage() {
  const { user } = useSession();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState("users");
  const [grants, setGrants] = useState([]);
  const [references, setReferences] = useState(initialReferences);
  const [managedUsers, setManagedUsers] = useState([]);
  const [userForm, setUserForm] = useState(() => createInitialUserForm());
  const [editingUserId, setEditingUserId] = useState(null);
  const [grantForm, setGrantForm] = useState(initialGrantForm);
  const [targetSearch, setTargetSearch] = useState("");
  const isSuperAdmin = Boolean(user?.is_superuser);

  const accountScopes = references.account_scopes || [];
  const scopedScopes = references.scoped_scopes || [];

  const scopeLabelMap = useMemo(
    () => new Map([...accountScopes, ...scopedScopes].map((scope) => [scope.value, scope.label])),
    [accountScopes, scopedScopes]
  );
  const allAccountScopeValues = useMemo(
    () => accountScopes.map((scope) => scope.value),
    [accountScopes]
  );

  const scopedGrants = useMemo(
    () => grants.filter((grant) => grant.book || grant.category || grant.contributor),
    [grants]
  );

  const targetOptions = useMemo(() => {
    if (grantForm.targetType === "category") {
      return references.categories.map((entry) => ({
        id: entry.id,
        label: entry.name
      }));
    }
    if (grantForm.targetType === "writer") {
      return references.writers.map((entry) => ({
        id: entry.id,
        label: entry.name
      }));
    }
    return references.books.map((entry) => ({
      id: entry.id,
      label: entry.title
    }));
  }, [grantForm.targetType, references.books, references.categories, references.writers]);

  const filteredTargetOptions = useMemo(() => {
    const query = targetSearch.trim().toLowerCase();
    if (!query) {
      return targetOptions;
    }
    return targetOptions.filter((entry) => entry.label.toLowerCase().includes(query));
  }, [targetOptions, targetSearch]);

  async function loadAdminData() {
    if (!isSuperAdmin) {
      setManagedUsers([]);
      setGrants([]);
      setReferences(initialReferences);
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
      setReferences({
        books: referencePayload.books || [],
        categories: referencePayload.categories || [],
        writers: referencePayload.writers || [],
        account_scopes: referencePayload.account_scopes || [],
        scoped_scopes: referencePayload.scoped_scopes || []
      });
    } catch (error) {
      toast.error(error.message);
    }
  }

  useEffect(() => {
    loadAdminData();
  }, [isSuperAdmin, user?.id]);

  useEffect(() => {
    if (isSuperAdmin) {
      resetUserForm();
    }
  }, [isSuperAdmin]);

  async function copyPasswordValue(password, successMessage = "Password copied.", showError = true) {
    if (!password) {
      if (showError) {
        toast.error("Generate or enter a password first.");
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(password);
      toast.success(successMessage);
    } catch (error) {
      if (showError) {
        toast.error("Could not copy the password.");
      }
    }
  }

  function resetUserForm() {
    setEditingUserId(null);
    setUserForm(createInitialUserForm());
  }

  function resetGrantForm() {
    setGrantForm(initialGrantForm);
    setTargetSearch("");
  }

  function formatAccountAccess(entry) {
    const labels = sortValues((entry.global_scopes || []).map((scope) => scopeLabelMap.get(scope) || scope));
    return labels.length ? labels.join(", ") : "-";
  }

  function toggleUserScope(scopeValue) {
    setUserForm((current) => {
      const nextScopes = current.global_scopes.includes(scopeValue)
        ? current.global_scopes.filter((value) => value !== scopeValue)
        : [...current.global_scopes, scopeValue];
      return {
        ...current,
        global_scopes: sortValues(nextScopes)
      };
    });
  }

  function selectAllAccountPermissions() {
    setUserForm((current) => ({
      ...current,
      global_scopes: sortValues(allAccountScopeValues)
    }));
  }

  function clearAccountPermissions() {
    setUserForm((current) => ({
      ...current,
      global_scopes: []
    }));
  }

  async function suggestPassword() {
    const password = generateSuggestedPassword();
    setUserForm((current) => ({
      ...current,
      password
    }));
    await copyPasswordValue(password, "Suggested password copied.");
  }

  function toggleGrantScope(scopeValue) {
    setGrantForm((current) => {
      const nextScopes = current.scopes.includes(scopeValue)
        ? current.scopes.filter((value) => value !== scopeValue)
        : [...current.scopes, scopeValue];
      return {
        ...current,
        scopes: sortValues(nextScopes)
      };
    });
  }

  function toggleGrantTarget(targetId) {
    setGrantForm((current) => {
      const nextTargets = current.targetIds.includes(targetId)
        ? current.targetIds.filter((value) => value !== targetId)
        : [...current.targetIds, targetId];
      return {
        ...current,
        targetIds: sortValues(nextTargets)
      };
    });
  }

  function switchTargetType(targetType) {
    setGrantForm((current) => ({
      ...current,
      targetType,
      targetIds: []
    }));
    setTargetSearch("");
  }

  function startEditing(entry) {
    setEditingUserId(entry.id);
    setUserForm({
      email: entry.email,
      full_name: entry.full_name || "",
      password: "",
      is_active: entry.is_active,
      totp_required: entry.totp_required,
      global_scopes: sortValues(entry.global_scopes || [])
    });
    setActiveTab("users");
  }

  async function submitUser(event) {
    event.preventDefault();

    if (!editingUserId && !userForm.password.trim()) {
      toast.error("Password is required when creating a user.");
      return;
    }
    if (!userForm.global_scopes.length) {
      toast.error("Select at least one account permission.");
      return;
    }

    const payload = {
      email: userForm.email.trim(),
      full_name: userForm.full_name.trim(),
      is_active: userForm.is_active,
      totp_required: userForm.totp_required,
      global_scopes: userForm.global_scopes
    };
    if (userForm.password.trim()) {
      payload.password = userForm.password;
    }

    try {
      if (editingUserId) {
        await authApi.updateUser(editingUserId, payload);
        toast.success("User updated.");
      } else {
        await authApi.createUser(payload);
        toast.success("User created.");
      }
      resetUserForm();
      await loadAdminData();
    } catch (error) {
      toast.error(
        formatApiError(error, {
          global_scopes: "Account permissions",
          email: "Email",
          password: "Password"
        })
      );
    }
  }

  async function deleteUser(entry) {
    if (!window.confirm(`Delete ${entry.email}?`)) {
      return;
    }

    try {
      await authApi.deleteUser(entry.id);
      if (editingUserId === entry.id) {
        resetUserForm();
      }
      toast.success("User deleted.");
      await loadAdminData();
    } catch (error) {
      toast.error(error.message);
    }
  }

  function grantTargetField(targetType) {
    if (targetType === "category") {
      return "category";
    }
    if (targetType === "writer") {
      return "contributor";
    }
    return "book";
  }

  async function submitGrant(event) {
    event.preventDefault();

    if (!grantForm.user) {
      toast.error("Select a user first.");
      return;
    }
    if (!grantForm.scopes.length) {
      toast.error("Select at least one permission.");
      return;
    }
    if (!grantForm.targetIds.length) {
      toast.error("Select at least one target.");
      return;
    }

    const targetField = grantTargetField(grantForm.targetType);
    const existingGrantKeys = new Set(
      scopedGrants
        .filter((grant) => `${grant.user}` === `${grantForm.user}`)
        .map((grant) => `${grant.scope}:${grant[targetField]}`)
    );

    const requests = [];
    let skippedCount = 0;
    for (const scope of grantForm.scopes) {
      for (const targetId of grantForm.targetIds) {
        const key = `${scope}:${targetId}`;
        if (existingGrantKeys.has(key)) {
          skippedCount += 1;
          continue;
        }
        requests.push(
          apiFetch("/access/grants/", {
            method: "POST",
            body: {
              user: grantForm.user,
              scope,
              [targetField]: targetId,
              expires_at: null,
              notes: ""
            }
          })
        );
      }
    }

    if (!requests.length) {
      toast.error("These access rules already exist.");
      return;
    }

    try {
      await Promise.all(requests);
      resetGrantForm();
      toast.success(
        skippedCount
          ? `Access updated. Skipped ${skippedCount} existing rule${skippedCount === 1 ? "" : "s"}.`
          : "Access updated."
      );
      await loadAdminData();
    } catch (error) {
      toast.error(error.message);
    }
  }

  async function deleteGrant(grant) {
    if (!window.confirm(`Remove ${scopeLabelMap.get(grant.scope) || grant.scope} from ${grant.user_email}?`)) {
      return;
    }

    try {
      await apiFetch(`/access/grants/${grant.id}/`, { method: "DELETE" });
      toast.success("Access removed.");
      await loadAdminData();
    } catch (error) {
      toast.error(error.message);
    }
  }

  if (!isSuperAdmin) {
    return <div className="page-state">Users & access settings are available only to the super admin account.</div>;
  }

  return (
    <div className="page-stack access-page">
      <section className="detail-card admin-hero-card">
        <div className="admin-hero-copy">
          <h1>Users &amp; Access</h1>
        </div>
        <div className="admin-tab-grid" role="tablist" aria-label="Users and access sections">
          <button
            type="button"
            className={activeTab === "users" ? "admin-tab-card is-active" : "admin-tab-card"}
            onClick={() => setActiveTab("users")}
            aria-pressed={activeTab === "users"}
          >
            <span className="admin-tab-label">Create User</span>
          </button>
          <button
            type="button"
            className={activeTab === "access" ? "admin-tab-card is-active" : "admin-tab-card"}
            onClick={() => setActiveTab("access")}
            aria-pressed={activeTab === "access"}
          >
            <span className="admin-tab-label">Access Rules</span>
          </button>
        </div>
      </section>

      {activeTab === "users" ? (
        <>
          <section className="detail-card">
            <div className="panel-header">
              <h2>{editingUserId ? "Edit User" : "Create User"}</h2>
              {editingUserId ? (
                <button type="button" className="ghost-button" onClick={() => void resetUserForm()}>
                  Cancel
                </button>
              ) : null}
            </div>

            <form className="stack-form" onSubmit={submitUser}>
              <div className="detail-facts">
                <label>
                  <span className="fact-label">Name</span>
                  <input
                    value={userForm.full_name}
                    onChange={(event) => setUserForm({ ...userForm, full_name: event.target.value })}
                    placeholder="Full name"
                  />
                </label>
                <label>
                  <span className="fact-label">Email</span>
                  <input
                    type="email"
                    value={userForm.email}
                    onChange={(event) => setUserForm({ ...userForm, email: event.target.value })}
                    placeholder="Email address"
                  />
                </label>
                <label>
                  <div className="field-header">
                    <span className="fact-label">Password</span>
                    {!editingUserId ? (
                      <div className="field-header-actions">
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => void suggestPassword()}
                          aria-label="Generate new password"
                          title="Generate new password"
                        >
                          ↻
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => void copyPasswordValue(userForm.password)}
                          aria-label="Copy password"
                          title="Copy password"
                        >
                          ⧉
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <input
                    type="password"
                    value={userForm.password}
                    onChange={(event) => setUserForm({ ...userForm, password: event.target.value })}
                    placeholder={editingUserId ? "Leave blank to keep current password" : "Create password"}
                  />
                </label>
              </div>

              <div className="settings-list">
                <span className="fact-label">Account Settings</span>
                <div className="settings-options-grid">
                  <label className="setting-option-card">
                    <div className="setting-option-copy">
                      <strong>Active Account</strong>
                      <span>Allow this user to sign in and use the workspace.</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={userForm.is_active}
                      onChange={(event) => setUserForm({ ...userForm, is_active: event.target.checked })}
                    />
                  </label>
                  <label className="setting-option-card">
                    <div className="setting-option-copy">
                      <strong>Require Two-Factor</strong>
                      <span>Require authenticator setup before the user can continue.</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={userForm.totp_required}
                      onChange={(event) => setUserForm({ ...userForm, totp_required: event.target.checked })}
                    />
                  </label>
                </div>
              </div>

              <div className="settings-list">
                <span className="fact-label">Account Permissions</span>
                <div className="inline-pills">
                  <button type="button" className="ghost-button" onClick={selectAllAccountPermissions}>
                    All Permissions
                  </button>
                  <button type="button" className="ghost-button" onClick={clearAccountPermissions}>
                    Clear
                  </button>
                </div>
                {accountScopes.length ? (
                  <div className="scope-grid">
                    {accountScopes.map((scope) => (
                      <label key={scope.value} className="scope-card">
                        <input
                          type="checkbox"
                          checked={userForm.global_scopes.includes(scope.value)}
                          onChange={() => toggleUserScope(scope.value)}
                        />
                        <span>{scope.label}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="muted-copy">No account permissions are available.</p>
                )}
              </div>

              <div className="inline-pills">
                <button type="submit" className="primary-button">
                  {editingUserId ? "Save User" : "Create User"}
                </button>
              </div>
            </form>
          </section>

          <section className="detail-card">
            <h2>Users</h2>
            <div className="table-shell">
              <table className="simple-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Two-Factor</th>
                    <th>Account Permissions</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {managedUsers.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.full_name || "-"}</td>
                      <td>{entry.email}</td>
                      <td>{entry.is_active ? "Active" : "Disabled"}</td>
                      <td>{entry.totp_required ? "Required" : entry.totp_enabled ? "Enabled" : "Optional"}</td>
                      <td>{formatAccountAccess(entry)}</td>
                      <td>
                        <div className="table-actions">
                          <button type="button" className="ghost-button" onClick={() => startEditing(entry)}>
                            Edit
                          </button>
                          {!entry.is_superuser ? (
                            <button type="button" className="ghost-button" onClick={() => deleteUser(entry)}>
                              Delete
                            </button>
                          ) : (
                            <span className="table-note">Locked</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <>
          <section className="detail-card">
            <h2>Access Control</h2>
            <form className="stack-form" onSubmit={submitGrant}>
              <div className="detail-facts">
                <label>
                  <span className="fact-label">User</span>
                  <select
                    value={grantForm.user}
                    onChange={(event) => setGrantForm({ ...grantForm, user: event.target.value })}
                  >
                    <option value="">Select user</option>
                    {managedUsers.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.full_name || entry.email}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="settings-list">
                <span className="fact-label">Permission</span>
                {scopedScopes.length ? (
                  <div className="scope-grid">
                    {scopedScopes.map((scope) => (
                      <label key={scope.value} className="scope-card">
                        <input
                          type="checkbox"
                          checked={grantForm.scopes.includes(scope.value)}
                          onChange={() => toggleGrantScope(scope.value)}
                        />
                        <span>{scope.label}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="muted-copy">No scoped permissions are available.</p>
                )}
              </div>

              <div className="settings-list">
                <span className="fact-label">Applies To</span>
                <div className="inline-pills">
                  <button
                    type="button"
                    className={grantForm.targetType === "book" ? "primary-button" : "ghost-button"}
                    onClick={() => switchTargetType("book")}
                  >
                    Books
                  </button>
                  <button
                    type="button"
                    className={grantForm.targetType === "category" ? "primary-button" : "ghost-button"}
                    onClick={() => switchTargetType("category")}
                  >
                    Categories
                  </button>
                  <button
                    type="button"
                    className={grantForm.targetType === "writer" ? "primary-button" : "ghost-button"}
                    onClick={() => switchTargetType("writer")}
                  >
                    Writers
                  </button>
                </div>
                <input
                  value={targetSearch}
                  onChange={(event) => setTargetSearch(event.target.value)}
                  placeholder={`Search ${grantForm.targetType}s`}
                />
                {filteredTargetOptions.length ? (
                  <div className="selection-list">
                    {filteredTargetOptions.map((entry) => (
                      <label key={entry.id} className="scope-card">
                        <input
                          type="checkbox"
                          checked={grantForm.targetIds.includes(entry.id)}
                          onChange={() => toggleGrantTarget(entry.id)}
                        />
                        <span>{entry.label}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="muted-copy">No matches found.</p>
                )}
              </div>

              <div className="inline-pills">
                <button type="submit" className="primary-button">
                  Save Access
                </button>
              </div>
            </form>
          </section>

          <section className="detail-card">
            <h2>Current Rules</h2>
            {scopedGrants.length ? (
              <div className="table-shell">
                <table className="simple-table">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Permission</th>
                      <th>Scope</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scopedGrants.map((grant) => (
                      <tr key={grant.id}>
                        <td>{grant.user_email}</td>
                        <td>{scopeLabelMap.get(grant.scope) || grant.scope}</td>
                        <td>{grant.target_label}</td>
                        <td>
                          <div className="table-actions">
                            <button type="button" className="ghost-button" onClick={() => deleteGrant(grant)}>
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted-copy">No scoped access rules yet.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
