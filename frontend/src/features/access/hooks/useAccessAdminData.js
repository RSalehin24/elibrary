import { useEffect, useMemo, useState } from "react";
import { apiFetch, authApi } from "../../../api/client";
import { initialReferences } from "../constants";

export function useAccessAdminData({ isSuperAdmin, userId, toast }) {
  const [grantRecords, setGrantRecords] = useState([]);
  const [references, setReferences] = useState(initialReferences);
  const [managedUsers, setManagedUsers] = useState([]);
  const [loadingAdminData, setLoadingAdminData] = useState(true);

  async function loadAdminData() {
    if (!isSuperAdmin) {
      setManagedUsers([]);
      setGrantRecords([]);
      setReferences(initialReferences);
      setLoadingAdminData(false);
      return;
    }

    try {
      setLoadingAdminData(true);
      const [userPayload, nextGrantRecords, referencePayload] =
        await Promise.all([
          authApi.users(),
          apiFetch("/access/grants/"),
          apiFetch("/access/references/"),
        ]);
      setManagedUsers(userPayload);
      setGrantRecords(nextGrantRecords);
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
    void loadAdminData();
  }, [isSuperAdmin, userId]);

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
      grantRecords.filter(
        (grant) => grant.book || grant.category || grant.contributor,
      ),
    [grantRecords],
  );

  return {
    accountScopes,
    allAccountScopeValues,
    grantRecords,
    loadAdminData,
    loadingAdminData,
    managedUsers,
    references,
    scopedGrants,
    scopedScopes,
    scopeLabelMap,
  };
}
