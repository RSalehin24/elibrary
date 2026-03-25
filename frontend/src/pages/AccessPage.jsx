import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, authApi } from "../api/client";
import ConfirmationDialog from "../components/ConfirmationDialog";
import LoadingSpinner from "../components/LoadingSpinner";
import PageLoader from "../components/PageLoader";
import {
  PROPERTY_TABLE_ROW_OPTIONS,
  useClientPagination,
} from "../components/PropertyTableControls";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";

const initialReferences = {
  books: [],
  categories: [],
  writers: [],
  account_scopes: [],
  scoped_scopes: [],
};

const initialGrantForm = {
  user: "",
  scopes: [],
  targetType: "book",
  targetIds: [],
};

function generateSuggestedPassword(length = 18) {
  const characters =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const randomValues = new Uint32Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(randomValues);
  } else {
    for (let index = 0; index < length; index += 1) {
      randomValues[index] = Math.floor(Math.random() * characters.length);
    }
  }
  return Array.from(
    randomValues,
    (value) => characters[value % characters.length],
  ).join("");
}

function createInitialUserForm() {
  return {
    email: "",
    full_name: "",
    password: "",
    is_active: true,
    totp_required: false,
    send_invite_email: true,
    global_scopes: [],
  };
}

function sortValues(values) {
  return [...values].sort((left, right) => `${left}`.localeCompare(`${right}`));
}

function formatApiError(error, labelMap = {}) {
  if (
    error?.payload &&
    typeof error.payload === "object" &&
    !Array.isArray(error.payload)
  ) {
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

function normalizeAccessTab(tab) {
  return tab === "access" ? "access" : "users";
}

export default function AccessPage() {
  const { user } = useSession();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(() =>
    normalizeAccessTab(searchParams.get("tab")),
  );
  const [grants, setGrants] = useState([]);
  const [references, setReferences] = useState(initialReferences);
  const [managedUsers, setManagedUsers] = useState([]);
  const [loadingAdminData, setLoadingAdminData] = useState(true);
  const [userForm, setUserForm] = useState(() => createInitialUserForm());
  const [editingUserId, setEditingUserId] = useState(null);
  const [pendingDeleteUser, setPendingDeleteUser] = useState(null);
  const [deletingUserId, setDeletingUserId] = useState(null);
  const [submittingUser, setSubmittingUser] = useState(false);
  const [submittingGrant, setSubmittingGrant] = useState(false);
  const [deletingGrantId, setDeletingGrantId] = useState(null);
  const [showCreateUserPassword, setShowCreateUserPassword] = useState(false);
  const [grantForm, setGrantForm] = useState(initialGrantForm);
  const [targetSearch, setTargetSearch] = useState("");
  const [userListFilters, setUserListFilters] = useState({
    q: "",
    status: "all",
    sort: "name_asc",
  });
  const isSuperAdmin = Boolean(user?.is_superuser);
  const isEditingUser = Boolean(editingUserId);
  const userEditorRef = useRef(null);

  function applyActiveTab(nextTab, options = {}) {
    const { replace = false } = options;
    const normalizedTab = normalizeAccessTab(nextTab);
    setActiveTab(normalizedTab);

    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", normalizedTab);
    setSearchParams(nextParams, { replace });
  }

  useEffect(() => {
    const normalizedTab = normalizeAccessTab(searchParams.get("tab"));
    if (activeTab !== normalizedTab) {
      setActiveTab(normalizedTab);
      return;
    }

    if (searchParams.get("tab") !== normalizedTab) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("tab", normalizedTab);
      setSearchParams(nextParams, { replace: true });
    }
  }, [activeTab, searchParams, setSearchParams]);

  const accountScopes = references.account_scopes || [];
  const scopedScopes = references.scoped_scopes || [];

  const scopeLabelMap = useMemo(
    () =>
      new Map(
        [...accountScopes, ...scopedScopes].map((scope) => [
          scope.value,
          scope.label,
        ]),
      ),
    [accountScopes, scopedScopes],
  );
  const allAccountScopeValues = useMemo(
    () => accountScopes.map((scope) => scope.value),
    [accountScopes],
  );

  const scopedGrants = useMemo(
    () =>
      grants.filter(
        (grant) => grant.book || grant.category || grant.contributor,
      ),
    [grants],
  );

  const targetOptions = useMemo(() => {
    if (grantForm.targetType === "category") {
      return references.categories.map((entry) => ({
        id: entry.id,
        label: entry.name,
      }));
    }
    if (grantForm.targetType === "writer") {
      return references.writers.map((entry) => ({
        id: entry.id,
        label: entry.name,
      }));
    }
    return references.books.map((entry) => ({
      id: entry.id,
      label: entry.title,
    }));
  }, [
    grantForm.targetType,
    references.books,
    references.categories,
    references.writers,
  ]);

  const filteredTargetOptions = useMemo(() => {
    const query = targetSearch.trim().toLowerCase();
    if (!query) {
      return targetOptions;
    }
    return targetOptions.filter((entry) =>
      entry.label.toLowerCase().includes(query),
    );
  }, [targetOptions, targetSearch]);

  const filteredManagedUsers = useMemo(() => {
    const query = userListFilters.q.trim().toLowerCase();
    const filtered = managedUsers.filter((entry) => {
      if (userListFilters.status === "active" && !entry.is_active) {
        return false;
      }
      if (userListFilters.status === "disabled" && entry.is_active) {
        return false;
      }
      if (userListFilters.status === "totp_required" && !entry.totp_required) {
        return false;
      }
      if (!query) {
        return true;
      }
      const access = formatAccountAccess(entry).toLowerCase();
      return [
        entry.full_name || "",
        entry.email || "",
        entry.is_active ? "active" : "disabled",
        entry.totp_required
          ? "required"
          : entry.totp_enabled
            ? "enabled"
            : "optional",
        access,
      ].some((value) => value.toLowerCase().includes(query));
    });

    const sorted = [...filtered];
    sorted.sort((left, right) => {
      if (userListFilters.sort === "name_desc") {
        return `${right.full_name || ""}`.localeCompare(
          `${left.full_name || ""}`,
        );
      }
      if (userListFilters.sort === "email_asc") {
        return `${left.email || ""}`.localeCompare(`${right.email || ""}`);
      }
      if (userListFilters.sort === "email_desc") {
        return `${right.email || ""}`.localeCompare(`${left.email || ""}`);
      }
      if (userListFilters.sort === "status") {
        return `${left.is_active ? "active" : "disabled"}`.localeCompare(
          `${right.is_active ? "active" : "disabled"}`,
        );
      }
      return `${left.full_name || ""}`.localeCompare(
        `${right.full_name || ""}`,
      );
    });
    return sorted;
  }, [managedUsers, userListFilters]);

  const {
    items: pagedManagedUsers,
    page: usersPage,
    pageCount: usersPageCount,
    rowsPerPage: usersRowsPerPage,
    hasPrevious: usersHasPrevious,
    hasNext: usersHasNext,
    setPage: setUsersPage,
    setRowsPerPage: setUsersRowsPerPage,
  } = useClientPagination(filteredManagedUsers, 20);

  async function loadAdminData() {
    if (!isSuperAdmin) {
      setManagedUsers([]);
      setGrants([]);
      setReferences(initialReferences);
      setLoadingAdminData(false);
      return;
    }

    try {
      setLoadingAdminData(true);
      const [userPayload, grantPayload, referencePayload] = await Promise.all([
        authApi.users(),
        apiFetch("/access/grants/"),
        apiFetch("/access/references/"),
      ]);
      setManagedUsers(userPayload);
      setGrants(grantPayload);
      setReferences({
        books: referencePayload.books || [],
        categories: referencePayload.categories || [],
        writers: referencePayload.writers || [],
        account_scopes: referencePayload.account_scopes || [],
        scoped_scopes: referencePayload.scoped_scopes || [],
      });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoadingAdminData(false);
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

  async function copyPasswordValue(
    password,
    successMessage = "Password copied.",
    showError = true,
  ) {
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
    setShowCreateUserPassword(false);
  }

  function resetGrantForm() {
    setGrantForm(initialGrantForm);
    setTargetSearch("");
  }

  function formatAccountAccess(entry) {
    const labels = sortValues(
      (entry.global_scopes || []).map(
        (scope) => scopeLabelMap.get(scope) || scope,
      ),
    );
    return labels.length ? labels.join(", ") : "-";
  }

  function toggleUserScope(scopeValue) {
    setUserForm((current) => {
      const nextScopes = current.global_scopes.includes(scopeValue)
        ? current.global_scopes.filter((value) => value !== scopeValue)
        : [...current.global_scopes, scopeValue];
      return {
        ...current,
        global_scopes: sortValues(nextScopes),
      };
    });
  }

  function selectAllAccountPermissions() {
    setUserForm((current) => ({
      ...current,
      global_scopes: sortValues(allAccountScopeValues),
    }));
  }

  function clearAccountPermissions() {
    setUserForm((current) => ({
      ...current,
      global_scopes: [],
    }));
  }

  async function suggestPassword() {
    const password = generateSuggestedPassword();
    setUserForm((current) => ({
      ...current,
      password,
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
        scopes: sortValues(nextScopes),
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
        targetIds: sortValues(nextTargets),
      };
    });
  }

  function switchTargetType(targetType) {
    setGrantForm((current) => ({
      ...current,
      targetType,
      targetIds: [],
    }));
    setTargetSearch("");
  }

  function updateUsersSearch(nextQuery) {
    setUserListFilters((current) => ({
      ...current,
      q: nextQuery,
    }));
    setUsersPage(1);
  }

  function clearUsersSearch() {
    setUserListFilters((current) => ({
      ...current,
      q: "",
    }));
    setUsersPage(1);
  }

  function updateUsersStatus(nextStatus) {
    setUserListFilters((current) => ({
      ...current,
      status: nextStatus,
    }));
    setUsersPage(1);
  }

  function updateUsersSort(nextSort) {
    setUserListFilters((current) => ({
      ...current,
      sort: nextSort,
    }));
    setUsersPage(1);
  }

  function startEditing(entry) {
    setEditingUserId(entry.id);
    setShowCreateUserPassword(false);
    setUserForm({
      email: entry.email,
      full_name: entry.full_name || "",
      password: "",
      is_active: entry.is_active,
      totp_required: entry.totp_required,
      send_invite_email: true,
      global_scopes: sortValues(entry.global_scopes || []),
    });
    applyActiveTab("users");
    window.requestAnimationFrame(() => {
      userEditorRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  async function submitUser(event) {
    event.preventDefault();

    if (submittingUser) {
      return;
    }

    if (
      !editingUserId &&
      !userForm.send_invite_email &&
      !userForm.password.trim()
    ) {
      toast.error("Enter a password or send an invite email.");
      return;
    }
    if (!userForm.global_scopes.length) {
      toast.error("Select at least one account permission.");
      return;
    }

    const payload = {
      is_active: userForm.is_active,
      totp_required: userForm.totp_required,
      global_scopes: userForm.global_scopes,
    };
    if (!isEditingUser) {
      payload.email = userForm.email.trim();
      payload.full_name = userForm.full_name.trim();
      payload.send_invite_email = userForm.send_invite_email;
    }
    if (
      !isEditingUser &&
      !userForm.send_invite_email &&
      userForm.password.trim()
    ) {
      payload.password = userForm.password;
    }

    try {
      setSubmittingUser(true);
      if (editingUserId) {
        await authApi.updateUser(editingUserId, payload);
        toast.success("User updated.");
      } else {
        await authApi.createUser(payload);
        toast.success(
          userForm.send_invite_email
            ? "User created and invite email sent."
            : "User created.",
        );
      }
      resetUserForm();
      await loadAdminData();
    } catch (error) {
      toast.error(
        formatApiError(error, {
          global_scopes: "Account permissions",
          email: "Email",
          password: "Password",
          is_active: "Active account",
        }),
      );
    } finally {
      setSubmittingUser(false);
    }
  }

  function requestDeleteUser(entry) {
    setPendingDeleteUser(entry);
  }

  async function confirmDeleteUser() {
    if (!pendingDeleteUser || deletingUserId) {
      return;
    }

    try {
      setDeletingUserId(pendingDeleteUser.id);
      await authApi.deleteUser(pendingDeleteUser.id);
      if (editingUserId === pendingDeleteUser.id) {
        resetUserForm();
      }
      setPendingDeleteUser(null);
      toast.success("User deleted.");
      await loadAdminData();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDeletingUserId(null);
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
    if (submittingGrant) {
      return;
    }

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
        .map((grant) => `${grant.scope}:${grant[targetField]}`),
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
              notes: "",
            },
          }),
        );
      }
    }

    if (!requests.length) {
      toast.error("These access rules already exist.");
      return;
    }

    try {
      setSubmittingGrant(true);
      await Promise.all(requests);
      resetGrantForm();
      toast.success(
        skippedCount
          ? `Access updated. Skipped ${skippedCount} existing rule${skippedCount === 1 ? "" : "s"}.`
          : "Access updated.",
      );
      await loadAdminData();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSubmittingGrant(false);
    }
  }

  async function deleteGrant(grant) {
    if (deletingGrantId) {
      return;
    }
    if (
      !window.confirm(
        `Remove ${scopeLabelMap.get(grant.scope) || grant.scope} from ${grant.user_email}?`,
      )
    ) {
      return;
    }

    try {
      setDeletingGrantId(grant.id);
      await apiFetch(`/access/grants/${grant.id}/`, { method: "DELETE" });
      toast.success("Access removed.");
      await loadAdminData();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDeletingGrantId(null);
    }
  }

  if (!isSuperAdmin) {
    return (
      <div className="page-state">
        Users & access settings are available only to the super admin account.
      </div>
    );
  }

  if (loadingAdminData) {
    return (
      <PageLoader
        label="Loading users and access"
        detail="Fetching accounts, permissions, and reference data."
      />
    );
  }

  return (
    <div className="page-stack access-page">
      <section className="detail-card admin-hero-card">
        <div className="admin-hero-copy">
          <h1>Users &amp; Access</h1>
        </div>
        <div
          className="admin-tab-grid"
          role="tablist"
          aria-label="Users and access sections"
        >
          <button
            type="button"
            className={
              activeTab === "users"
                ? "admin-tab-card is-active"
                : "admin-tab-card"
            }
            onClick={() => applyActiveTab("users")}
            aria-pressed={activeTab === "users"}
          >
            <span className="admin-tab-label">Users</span>
          </button>
          <button
            type="button"
            className={
              activeTab === "access"
                ? "admin-tab-card is-active"
                : "admin-tab-card"
            }
            onClick={() => applyActiveTab("access")}
            aria-pressed={activeTab === "access"}
          >
            <span className="admin-tab-label">Access Rules</span>
          </button>
        </div>
      </section>

      {activeTab === "users" ? (
        <>
          <section className="detail-card">
            <div ref={userEditorRef} className="access-user-editor-anchor" />
            <div className="panel-header">
              <h2>{editingUserId ? "Edit User" : "Create User"}</h2>
              {editingUserId ? (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void resetUserForm()}
                  disabled={submittingUser}
                >
                  Cancel
                </button>
              ) : null}
            </div>

            <form className="stack-form" onSubmit={submitUser}>
              <fieldset
                className="form-fieldset-reset"
                disabled={submittingUser}
              >
                <div className="detail-facts">
                  <label>
                    <span className="fact-label">Name</span>
                    <input
                      value={userForm.full_name}
                      onChange={(event) =>
                        setUserForm({
                          ...userForm,
                          full_name: event.target.value,
                        })
                      }
                      placeholder="Full name"
                      disabled={isEditingUser}
                      readOnly={isEditingUser}
                    />
                  </label>
                  <label>
                    <span className="fact-label">Email</span>
                    <input
                      type="email"
                      value={userForm.email}
                      onChange={(event) =>
                        setUserForm({ ...userForm, email: event.target.value })
                      }
                      placeholder="Email address"
                      disabled={isEditingUser}
                      readOnly={isEditingUser}
                    />
                  </label>
                  <label>
                    <div className="field-header access-password-header">
                      <span className="fact-label">Password Setup</span>
                      {!isEditingUser && !userForm.send_invite_email ? (
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
                            onClick={() =>
                              void copyPasswordValue(userForm.password)
                            }
                            aria-label="Copy password"
                            title="Copy password"
                          >
                            ⧉
                          </button>
                        </div>
                      ) : null}
                    </div>
                    {isEditingUser ? (
                      <input
                        type="password"
                        value=""
                        placeholder="Password changes are disabled here"
                        disabled
                        readOnly
                      />
                    ) : userForm.send_invite_email ? (
                      <p className="muted-copy access-invite-note">
                        A setup email with a password-reset link will be sent
                        after the account is created.
                      </p>
                    ) : (
                      <div className="password-input-row">
                        <input
                          type={showCreateUserPassword ? "text" : "password"}
                          value={userForm.password}
                          onChange={(event) =>
                            setUserForm({
                              ...userForm,
                              password: event.target.value,
                            })
                          }
                          placeholder="Create password"
                          autoComplete="new-password"
                        />
                        <button
                          type="button"
                          className="password-visibility-button"
                          onClick={() =>
                            setShowCreateUserPassword((current) => !current)
                          }
                          aria-label={
                            showCreateUserPassword
                              ? "Hide create password"
                              : "Show create password"
                          }
                        >
                          {showCreateUserPassword ? "Hide" : "Show"}
                        </button>
                      </div>
                    )}
                  </label>
                </div>

                <div className="settings-list">
                  <span className="fact-label">Account Settings</span>
                  <div className="settings-options-grid">
                    {!isEditingUser ? (
                      <label className="setting-option-card">
                        <div className="setting-option-copy">
                          <strong>Send Setup Email</strong>
                          <span>
                            Send a reset link so the user can choose their own
                            password.
                          </span>
                        </div>
                        <input
                          type="checkbox"
                          checked={userForm.send_invite_email}
                          onChange={(event) =>
                            setUserForm({
                              ...userForm,
                              send_invite_email: event.target.checked,
                              password: event.target.checked
                                ? ""
                                : userForm.password,
                            })
                          }
                        />
                      </label>
                    ) : null}
                    <label className="setting-option-card">
                      <div className="setting-option-copy">
                        <strong>Active Account</strong>
                        <span>
                          Allow this user to sign in and use the workspace.
                        </span>
                      </div>
                      <input
                        type="checkbox"
                        checked={userForm.is_active}
                        onChange={(event) =>
                          setUserForm({
                            ...userForm,
                            is_active: event.target.checked,
                          })
                        }
                      />
                    </label>
                    <label className="setting-option-card">
                      <div className="setting-option-copy">
                        <strong>Require Two-Factor</strong>
                        <span>
                          Require authenticator setup before the user can
                          continue.
                        </span>
                      </div>
                      <input
                        type="checkbox"
                        checked={userForm.totp_required}
                        onChange={(event) =>
                          setUserForm({
                            ...userForm,
                            totp_required: event.target.checked,
                          })
                        }
                      />
                    </label>
                  </div>
                </div>

                <div className="settings-list">
                  <span className="fact-label">Account Permissions</span>
                  <div className="inline-pills">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={selectAllAccountPermissions}
                    >
                      All Permissions
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={clearAccountPermissions}
                    >
                      Clear
                    </button>
                  </div>
                  {accountScopes.length ? (
                    <div className="scope-grid">
                      {accountScopes.map((scope) => (
                        <label key={scope.value} className="scope-card">
                          <input
                            type="checkbox"
                            checked={userForm.global_scopes.includes(
                              scope.value,
                            )}
                            onChange={() => toggleUserScope(scope.value)}
                          />
                          <span>{scope.label}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="muted-copy">
                      No account permissions are available.
                    </p>
                  )}
                </div>

                <div className="inline-pills access-user-submit-actions">
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={submittingUser}
                  >
                    {submittingUser ? (
                      <span className="button-label">
                        <LoadingSpinner size={14} />
                        {editingUserId ? "Saving..." : "Creating..."}
                      </span>
                    ) : editingUserId ? (
                      "Save User"
                    ) : (
                      "Create User"
                    )}
                  </button>
                </div>
              </fieldset>
            </form>
          </section>

          <section className="detail-card">
            <div className="access-users-header">
              <h2>Users</h2>
              <div className="access-users-header-row">
                <label
                  className="access-users-search-field"
                  aria-label="Search users"
                >
                  <span className="catalog-search-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path
                        d="M10.75 4.5a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5Zm0 1.5a4.75 4.75 0 1 1 0 9.5 4.75 4.75 0 0 1 0-9.5Zm6.86 10.55 2.95 2.95a.75.75 0 1 1-1.06 1.06l-2.95-2.95a.75.75 0 1 1 1.06-1.06Z"
                        fill="currentColor"
                      />
                    </svg>
                  </span>
                  <input
                    type="search"
                    value={userListFilters.q}
                    onChange={(event) => updateUsersSearch(event.target.value)}
                    onInput={(event) => {
                      if (!String(event.target?.value || "").trim()) {
                        clearUsersSearch();
                      }
                    }}
                    placeholder="Search users by name, email, status, or permission..."
                    autoComplete="off"
                  />
                </label>
                <label className="catalog-toolbar-field catalog-toolbar-field-sort">
                  <span className="fact-label catalog-toolbar-inline-label">
                    Filter
                  </span>
                  <select
                    className="catalog-toolbar-select"
                    value={userListFilters.status}
                    onChange={(event) => updateUsersStatus(event.target.value)}
                  >
                    <option value="all">All users</option>
                    <option value="active">Active</option>
                    <option value="disabled">Disabled</option>
                    <option value="totp_required">Two-factor required</option>
                  </select>
                </label>
                <span
                  className="access-users-result-count"
                  aria-label={`${filteredManagedUsers.length} users`}
                >
                  {filteredManagedUsers.length}
                </span>
              </div>
              <div className="catalog-toolbar-secondary property-table-controls access-users-table-controls">
                <label className="catalog-toolbar-field catalog-toolbar-field-sort">
                  <span className="fact-label catalog-toolbar-inline-label">
                    Sort
                  </span>
                  <select
                    className="catalog-toolbar-select"
                    value={userListFilters.sort}
                    onChange={(event) => updateUsersSort(event.target.value)}
                  >
                    <option value="name_asc">Name A-Z</option>
                    <option value="name_desc">Name Z-A</option>
                    <option value="email_asc">Email A-Z</option>
                    <option value="email_desc">Email Z-A</option>
                    <option value="status">Status</option>
                  </select>
                </label>
                <label className="catalog-toolbar-field catalog-toolbar-field-rows">
                  <span className="fact-label catalog-toolbar-inline-label">
                    Rows
                  </span>
                  <select
                    className="catalog-toolbar-select"
                    value={String(usersRowsPerPage)}
                    onChange={(event) =>
                      setUsersRowsPerPage(
                        Number(event.target.value) || usersRowsPerPage,
                      )
                    }
                  >
                    {PROPERTY_TABLE_ROW_OPTIONS.map((option) => (
                      <option key={`users-rows-${option}`} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="catalog-pagination">
                  <span className="catalog-page-indicator">
                    Page {usersPage} / {usersPageCount}
                  </span>
                  <div className="catalog-pagination-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setUsersPage(1)}
                      disabled={!usersHasPrevious}
                    >
                      First
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setUsersPage(Math.max(1, usersPage - 1))}
                      disabled={!usersHasPrevious}
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setUsersPage(usersPage + 1)}
                      disabled={!usersHasNext}
                    >
                      Next
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setUsersPage(usersPageCount)}
                      disabled={!usersHasNext}
                    >
                      Last
                    </button>
                  </div>
                </div>
              </div>
            </div>
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
                  {pagedManagedUsers.length ? (
                    pagedManagedUsers.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.full_name || "-"}</td>
                        <td>{entry.email}</td>
                        <td>{entry.is_active ? "Active" : "Disabled"}</td>
                        <td>
                          {entry.totp_required
                            ? "Required"
                            : entry.totp_enabled
                              ? "Enabled"
                              : "Optional"}
                        </td>
                        <td>{formatAccountAccess(entry)}</td>
                        <td>
                          <div className="table-actions">
                            {`${entry.id}` === `${user?.id}` ||
                            entry.is_superuser ? (
                              <span className="table-note">Locked</span>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="primary-button"
                                  onClick={() => startEditing(entry)}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="ghost-button danger-button"
                                  onClick={() => requestDeleteUser(entry)}
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6}>
                        No users found for the current search and filter.
                      </td>
                    </tr>
                  )}
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
              <fieldset
                className="form-fieldset-reset"
                disabled={submittingGrant}
              >
                <div className="detail-facts">
                  <label>
                    <span className="fact-label">User</span>
                    <select
                      value={grantForm.user}
                      onChange={(event) =>
                        setGrantForm({ ...grantForm, user: event.target.value })
                      }
                    >
                      <option value="">Select user</option>
                      {managedUsers
                        .filter((entry) => `${entry.id}` !== `${user?.id}`)
                        .map((entry) => (
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
                    <p className="muted-copy">
                      No scoped permissions are available.
                    </p>
                  )}
                </div>

                <div className="settings-list">
                  <span className="fact-label">Applies To</span>
                  <div className="inline-pills">
                    <button
                      type="button"
                      className={
                        grantForm.targetType === "book"
                          ? "primary-button"
                          : "ghost-button"
                      }
                      onClick={() => switchTargetType("book")}
                    >
                      Books
                    </button>
                    <button
                      type="button"
                      className={
                        grantForm.targetType === "category"
                          ? "primary-button"
                          : "ghost-button"
                      }
                      onClick={() => switchTargetType("category")}
                    >
                      Categories
                    </button>
                    <button
                      type="button"
                      className={
                        grantForm.targetType === "writer"
                          ? "primary-button"
                          : "ghost-button"
                      }
                      onClick={() => switchTargetType("writer")}
                    >
                      Writers
                    </button>
                  </div>
                  <input
                    type="search"
                    value={targetSearch}
                    onChange={(event) => setTargetSearch(event.target.value)}
                    onInput={(event) => {
                      if (!String(event.target?.value || "").trim()) {
                        setTargetSearch("");
                      }
                    }}
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
                    <span className="button-label">
                      {submittingGrant ? <LoadingSpinner size={14} /> : null}
                      {submittingGrant ? "Saving..." : "Save Access"}
                    </span>
                  </button>
                </div>
              </fieldset>
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
                            {`${grant.user}` === `${user?.id}` ? (
                              <span className="table-note">Locked</span>
                            ) : (
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() => deleteGrant(grant)}
                                disabled={Boolean(deletingGrantId)}
                              >
                                {deletingGrantId === grant.id
                                  ? "Deleting..."
                                  : "Delete"}
                              </button>
                            )}
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

      <ConfirmationDialog
        open={Boolean(pendingDeleteUser)}
        title="Delete User?"
        body={
          pendingDeleteUser
            ? `Delete ${pendingDeleteUser.email}? This will permanently remove the account.`
            : ""
        }
        confirmLabel="Delete User"
        loading={Boolean(deletingUserId)}
        onCancel={() => {
          if (!deletingUserId) {
            setPendingDeleteUser(null);
          }
        }}
        onConfirm={confirmDeleteUser}
      />
    </div>
  );
}
