import { useRef, useState } from "react";
import { authApi } from "../../../api/client";
import {
  PROPERTY_TABLE_ROW_OPTIONS,
} from "../../../components/PropertyTableControls";
import { createInitialUserForm } from "../constants";
import { useManagedUserList } from "./useManagedUserList";
import {
  formatAccountAccess,
  formatApiError,
  generateSuggestedPassword,
  sortValues,
} from "../utils";

export function useAccessUsers({
  allAccountScopeValues,
  applyActiveTab,
  currentUserId,
  loadAdminData,
  managedUsers,
  scopeLabelMap,
  toast,
}) {
  const [userForm, setUserForm] = useState(() => createInitialUserForm());
  const [editingUserId, setEditingUserId] = useState(null);
  const [pendingDeleteUser, setPendingDeleteUser] = useState(null);
  const [deletingUserId, setDeletingUserId] = useState(null);
  const [submittingUser, setSubmittingUser] = useState(false);
  const [showCreateUserPassword, setShowCreateUserPassword] = useState(false);
  const userEditorRef = useRef(null);
  const isEditingUser = Boolean(editingUserId);
  const {
    filteredManagedUsers,
    pagedManagedUsers,
    setUsersPage,
    setUsersRowsPerPage,
    updateUsersSearch,
    clearUsersSearch,
    updateUsersSort,
    updateUsersStatus,
    userListFilters,
    usersHasNext,
    usersHasPrevious,
    usersPage,
    usersPageCount,
    usersRowsPerPage,
  } = useManagedUserList({
    managedUsers,
    scopeLabelMap,
  });

  function resetUserForm() {
    setEditingUserId(null);
    setUserForm(createInitialUserForm());
    setShowCreateUserPassword(false);
  }

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
    } catch {
      if (showError) {
        toast.error("Could not copy the password.");
      }
    }
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

  return {
    clearAccountPermissions,
    clearUsersSearch,
    confirmDeleteUser,
    copyPasswordValue,
    deletingUserId,
    editingUserId,
    filteredManagedUsers,
    formatAccountAccess: (entry) => formatAccountAccess(entry, scopeLabelMap),
    isEditingUser,
    pagedManagedUsers,
    pendingDeleteUser,
    PROPERTY_TABLE_ROW_OPTIONS,
    requestDeleteUser,
    resetUserForm,
    selectAllAccountPermissions,
    setPendingDeleteUser,
    setShowCreateUserPassword,
    setUserForm,
    setUsersPage,
    setUsersRowsPerPage,
    showCreateUserPassword,
    startEditing,
    submitUser,
    submittingUser,
    suggestPassword,
    toggleUserScope,
    updateUsersSearch,
    updateUsersSort,
    updateUsersStatus,
    userEditorRef,
    userForm,
    userListFilters,
    usersHasNext,
    usersHasPrevious,
    usersPage,
    usersPageCount,
    usersRowsPerPage,
  };
}
