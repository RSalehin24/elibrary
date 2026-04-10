import { useMemo, useState } from "react";
import { useClientPagination } from "../../../components/PropertyTableControls";
import { formatAccountAccess } from "../utils";


export function useManagedUserList({ managedUsers, scopeLabelMap }) {
  const [userListFilters, setUserListFilters] = useState({
    q: "",
    status: "all",
    sort: "name_asc",
  });

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
      const access = formatAccountAccess(entry, scopeLabelMap).toLowerCase();
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
        return `${right.full_name || ""}`.localeCompare(`${left.full_name || ""}`);
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
      return `${left.full_name || ""}`.localeCompare(`${right.full_name || ""}`);
    });
    return sorted;
  }, [managedUsers, scopeLabelMap, userListFilters]);

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

  function updateUsersFilter(key, value) {
    setUserListFilters((current) => ({
      ...current,
      [key]: value,
    }));
    setUsersPage(1);
  }

  return {
    filteredManagedUsers,
    pagedManagedUsers,
    setUsersPage,
    setUsersRowsPerPage,
    updateUsersSearch(nextQuery) {
      updateUsersFilter("q", nextQuery);
    },
    clearUsersSearch() {
      updateUsersFilter("q", "");
    },
    updateUsersSort(nextSort) {
      updateUsersFilter("sort", nextSort);
    },
    updateUsersStatus(nextStatus) {
      updateUsersFilter("status", nextStatus);
    },
    userListFilters,
    usersHasNext,
    usersHasPrevious,
    usersPage,
    usersPageCount,
    usersRowsPerPage,
  };
}

