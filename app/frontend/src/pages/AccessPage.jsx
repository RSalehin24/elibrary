import ConfirmationDialog from "../components/ConfirmationDialog";
import PageLoader from "../components/PageLoader";
import AccessGrantEditorCard from "../features/access/components/AccessGrantEditorCard";
import AccessGrantRulesCard from "../features/access/components/AccessGrantRulesCard";
import AccessHero from "../features/access/components/AccessHero";
import AccessUserEditorCard from "../features/access/components/AccessUserEditorCard";
import AccessUsersTableCard from "../features/access/components/AccessUsersTableCard";
import { useAccessAdminData } from "../features/access/hooks/useAccessAdminData";
import { useAccessGrants } from "../features/access/hooks/useAccessGrants";
import { useAccessTabs } from "../features/access/hooks/useAccessTabs";
import { useAccessUsers } from "../features/access/hooks/useAccessUsers";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";

export default function AccessPage() {
  const { user } = useSession();
  const toast = useToast();
  const isSuperAdmin = Boolean(user?.is_superuser);
  const { activeTab, applyActiveTab } = useAccessTabs();
  const {
    accountScopes,
    loadAdminData,
    loadingAdminData,
    managedUsers,
    references,
    scopedGrants,
    scopedScopes,
    scopeLabelMap,
  } = useAccessAdminData({
    isSuperAdmin,
    userId: user?.id,
    toast,
  });
  const accessUsers = useAccessUsers({
    allAccountScopeValues: accountScopes.map((scope) => scope.value),
    applyActiveTab,
    currentUserId: user?.id,
    loadAdminData,
    managedUsers,
    scopeLabelMap,
    toast,
  });
  const accessGrants = useAccessGrants({
    loadAdminData,
    references,
    scopedGrants,
    scopeLabelMap,
    toast,
    userId: user?.id,
  });

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
      <AccessHero activeTab={activeTab} onSelectTab={applyActiveTab} />

      {activeTab === "users" ? (
        <>
          <AccessUserEditorCard
            accountScopes={accountScopes}
            editingUserId={accessUsers.editingUserId}
            isEditingUser={accessUsers.isEditingUser}
            onCancel={accessUsers.resetUserForm}
            onClearPermissions={accessUsers.clearAccountPermissions}
            onCopyPasswordValue={accessUsers.copyPasswordValue}
            onSelectAllPermissions={accessUsers.selectAllAccountPermissions}
            onSetShowCreateUserPassword={accessUsers.setShowCreateUserPassword}
            onSetUserForm={accessUsers.setUserForm}
            onSubmit={accessUsers.submitUser}
            onSuggestPassword={accessUsers.suggestPassword}
            onToggleUserScope={accessUsers.toggleUserScope}
            showCreateUserPassword={accessUsers.showCreateUserPassword}
            submittingUser={accessUsers.submittingUser}
            userEditorRef={accessUsers.userEditorRef}
            userForm={accessUsers.userForm}
          />

          <AccessUsersTableCard
            currentUserId={user?.id}
            filteredManagedUsers={accessUsers.filteredManagedUsers}
            formatAccountAccess={accessUsers.formatAccountAccess}
            onClearSearch={accessUsers.clearUsersSearch}
            onDeleteUser={accessUsers.requestDeleteUser}
            onEditUser={accessUsers.startEditing}
            onResendSetupEmail={accessUsers.resendSetupEmail}
            onSetUsersPage={accessUsers.setUsersPage}
            onSetUsersRowsPerPage={accessUsers.setUsersRowsPerPage}
            onUpdateUsersSearch={accessUsers.updateUsersSearch}
            onUpdateUsersSort={accessUsers.updateUsersSort}
            onUpdateUsersStatus={accessUsers.updateUsersStatus}
            pagedManagedUsers={accessUsers.pagedManagedUsers}
            propertyTableRowOptions={accessUsers.PROPERTY_TABLE_ROW_OPTIONS}
            resendingSetupUserId={accessUsers.resendingSetupUserId}
            userListFilters={accessUsers.userListFilters}
            usersHasNext={accessUsers.usersHasNext}
            usersHasPrevious={accessUsers.usersHasPrevious}
            usersPage={accessUsers.usersPage}
            usersPageCount={accessUsers.usersPageCount}
            usersRowsPerPage={accessUsers.usersRowsPerPage}
          />
        </>
      ) : (
        <>
          <AccessGrantEditorCard
            currentUserId={accessGrants.userId}
            filteredTargetOptions={accessGrants.filteredTargetOptions}
            grantForm={accessGrants.grantForm}
            managedUsers={managedUsers}
            onSetGrantForm={accessGrants.setGrantForm}
            onSetTargetSearch={accessGrants.setTargetSearch}
            onSubmit={accessGrants.submitGrant}
            onSwitchTargetType={accessGrants.switchTargetType}
            onToggleGrantScope={accessGrants.toggleGrantScope}
            onToggleGrantTarget={accessGrants.toggleGrantTarget}
            scopedScopes={scopedScopes}
            submittingGrant={accessGrants.submittingGrant}
            targetSearch={accessGrants.targetSearch}
          />

          <AccessGrantRulesCard
            currentUserId={user?.id}
            deletingGrantId={accessGrants.deletingGrantId}
            onDeleteGrant={accessGrants.deleteGrant}
            scopedGrants={scopedGrants}
            scopeLabelMap={scopeLabelMap}
          />
        </>
      )}

      <ConfirmationDialog
        open={Boolean(accessUsers.pendingDeleteUser)}
        title="Delete User?"
        body={
          accessUsers.pendingDeleteUser
            ? `Delete ${accessUsers.pendingDeleteUser.email}? This will permanently remove the account.`
            : ""
        }
        confirmLabel="Delete User"
        loading={Boolean(accessUsers.deletingUserId)}
        onCancel={() => {
          if (!accessUsers.deletingUserId) {
            accessUsers.setPendingDeleteUser(null);
          }
        }}
        onConfirm={accessUsers.confirmDeleteUser}
      />
    </div>
  );
}
