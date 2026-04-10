export default function AccessUsersTableCard({
  currentUserId,
  filteredManagedUsers,
  onClearSearch,
  onDeleteUser,
  onEditUser,
  onSetUsersPage,
  onSetUsersRowsPerPage,
  onUpdateUsersSearch,
  onUpdateUsersSort,
  onUpdateUsersStatus,
  pagedManagedUsers,
  propertyTableRowOptions,
  userListFilters,
  usersHasNext,
  usersHasPrevious,
  usersPage,
  usersPageCount,
  usersRowsPerPage,
  formatAccountAccess,
}) {
  return (
    <section className="detail-card" data-testid="access-users-section">
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
              onChange={(event) => onUpdateUsersSearch(event.target.value)}
              onInput={(event) => {
                if (!String(event.target?.value || "").trim()) {
                  onClearSearch();
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
              onChange={(event) => onUpdateUsersStatus(event.target.value)}
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
            <span className="fact-label catalog-toolbar-inline-label">Sort</span>
            <select
              className="catalog-toolbar-select"
              value={userListFilters.sort}
              onChange={(event) => onUpdateUsersSort(event.target.value)}
            >
              <option value="name_asc">Name A-Z</option>
              <option value="name_desc">Name Z-A</option>
              <option value="email_asc">Email A-Z</option>
              <option value="email_desc">Email Z-A</option>
              <option value="status">Status</option>
            </select>
          </label>
          <label className="catalog-toolbar-field catalog-toolbar-field-rows">
            <span className="fact-label catalog-toolbar-inline-label">Rows</span>
            <select
              className="catalog-toolbar-select"
              value={String(usersRowsPerPage)}
              onChange={(event) =>
                onSetUsersRowsPerPage(
                  Number(event.target.value) || usersRowsPerPage,
                )
              }
            >
              {propertyTableRowOptions.map((option) => (
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
                onClick={() => onSetUsersPage(1)}
                disabled={!usersHasPrevious}
              >
                First
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => onSetUsersPage(Math.max(1, usersPage - 1))}
                disabled={!usersHasPrevious}
              >
                Prev
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => onSetUsersPage(usersPage + 1)}
                disabled={!usersHasNext}
              >
                Next
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => onSetUsersPage(usersPageCount)}
                disabled={!usersHasNext}
              >
                Last
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="table-shell">
        <table className="simple-table" data-testid="access-users-table">
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
                      {`${entry.id}` === `${currentUserId}` ||
                      entry.is_superuser ? (
                        <span className="table-note">Locked</span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => onEditUser(entry)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="ghost-button danger-button"
                            onClick={() => onDeleteUser(entry)}
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
  );
}
