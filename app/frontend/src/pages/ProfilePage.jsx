import { useEffect, useMemo, useState } from "react";
import { authApi } from "../api/client";
import LoadingSpinner from "../components/LoadingSpinner";
import PageLoader from "../components/PageLoader";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";

const emptySetup = {
  provisioning_uri: "",
  secret: "",
  qr_svg: "",
};

function initialsForUser(value) {
  return (
    (value || "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "?"
  );
}

function roleLabelForProfile(profile) {
  if (profile?.is_superuser) {
    return "Super Admin";
  }
  if (profile?.is_staff) {
    return "Staff";
  }
  return "User";
}

export default function ProfilePage() {
  const { user, refreshSession } = useSession();
  const toast = useToast();
  const [profile, setProfile] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [twoFactor, setTwoFactor] = useState({
    enabled: false,
    pending_setup: false,
    required: false,
    setup_required: false,
  });
  const [fullName, setFullName] = useState("");
  const [setup, setSetup] = useState(emptySetup);
  const [setupVisible, setSetupVisible] = useState(false);
  const [token, setToken] = useState("");
  const [profileImageFile, setProfileImageFile] = useState(null);
  const [profileImagePreview, setProfileImagePreview] = useState("");
  const [removeProfileImage, setRemoveProfileImage] = useState(false);
  const [passwordSectionOpen, setPasswordSectionOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [totpAction, setTotpAction] = useState("");

  function twoFactorStatusLabel() {
    if (twoFactor.enabled) {
      return "Set up";
    }
    return "Not set up";
  }

  async function loadProfile(options = {}) {
    const { preserveEditor = false } = options;
    try {
      setLoading(true);
      const [profilePayload, statusPayload] = await Promise.all([
        authApi.profile(),
        authApi.twoFactorStatus(),
      ]);
      setProfile(profilePayload);
      if (!preserveEditor) {
        setFullName(profilePayload.full_name || "");
        setProfileImageFile(null);
        setProfileImagePreview(profilePayload.profile_image_url || "");
        setRemoveProfileImage(false);
        setPasswordSectionOpen(false);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmNewPassword("");
      }
      setTwoFactor(statusPayload);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProfile();
  }, [user?.id]);

  function resetProfileEditor(sourceProfile = profile) {
    setFullName(sourceProfile?.full_name || "");
    setProfileImageFile(null);
    setProfileImagePreview(sourceProfile?.profile_image_url || "");
    setRemoveProfileImage(false);
    setPasswordSectionOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmNewPassword("");
    setShowCurrentPassword(false);
    setShowNewPassword(false);
    setShowConfirmNewPassword(false);
    setSetupVisible(false);
    setToken("");
  }

  function startEditing() {
    resetProfileEditor(profile);
    setIsEditing(true);
  }

  function stopEditing() {
    resetProfileEditor(profile);
    setIsEditing(false);
  }

  async function saveProfile(event) {
    event.preventDefault();
    const hasPasswordChanges = Boolean(
      currentPassword || newPassword || confirmNewPassword,
    );

    if (hasPasswordChanges && !currentPassword) {
      toast.error("Enter your current password to change it.");
      return;
    }
    if (hasPasswordChanges && !newPassword) {
      toast.error("Enter a new password.");
      return;
    }
    if (hasPasswordChanges && newPassword !== confirmNewPassword) {
      toast.error("The new password fields must match.");
      return;
    }

    try {
      setSavingProfile(true);
      const body = new FormData();
      body.append("full_name", fullName.trim());
      if (profileImageFile) {
        body.append("profile_image", profileImageFile);
      }
      if (removeProfileImage) {
        body.append("remove_profile_image", "true");
      }
      if (hasPasswordChanges) {
        body.append("current_password", currentPassword);
        body.append("new_password", newPassword);
        body.append("confirm_new_password", confirmNewPassword);
      }
      const payload = await authApi.updateProfile(body);
      setProfile(payload);
      resetProfileEditor(payload);
      await refreshSession();
      setIsEditing(false);
      toast.success("Profile updated.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSavingProfile(false);
    }
  }

  function handleProfileImageChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setProfileImageFile(file);
    setProfileImagePreview(URL.createObjectURL(file));
    setRemoveProfileImage(false);
  }

  function clearProfileImage() {
    setProfileImageFile(null);
    setProfileImagePreview("");
    setRemoveProfileImage(true);
  }

  async function startSetup() {
    if (totpAction) {
      return;
    }
    try {
      setTotpAction("setup");
      const payload = await authApi.twoFactorSetup();
      setSetup(payload);
      setSetupVisible(true);
      setTwoFactor((current) => ({ ...current, pending_setup: true }));
      toast.success("Two-factor setup is ready.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setTotpAction("");
    }
  }

  async function openSetup() {
    if (setup.provisioning_uri) {
      setSetupVisible(true);
      return;
    }
    await startSetup();
  }

  async function confirmSetup(event) {
    event.preventDefault();
    if (totpAction) {
      return;
    }
    try {
      setTotpAction("verify");
      await authApi.twoFactorConfirm({ token });
      setToken("");
      setSetup(emptySetup);
      setSetupVisible(false);
      await refreshSession();
      await loadProfile({ preserveEditor: true });
      toast.success("Two-factor enabled.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setTotpAction("");
    }
  }

  async function disableTotp() {
    if (totpAction) {
      return;
    }
    try {
      setTotpAction("disable");
      await authApi.twoFactorDisable();
      setToken("");
      setSetup(emptySetup);
      setSetupVisible(false);
      await refreshSession();
      await loadProfile({ preserveEditor: true });
      toast.success("Two-factor disabled.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setTotpAction("");
    }
  }

  async function cancelSetup() {
    if (totpAction) {
      return;
    }
    try {
      setTotpAction("cancel");
      await authApi.twoFactorCancel();
      setToken("");
      setSetup(emptySetup);
      setSetupVisible(false);
      await loadProfile({ preserveEditor: true });
      toast.success("Setup canceled.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setTotpAction("");
    }
  }

  async function copyProvisioningUrl() {
    try {
      await navigator.clipboard.writeText(setup.provisioning_uri);
      toast.success("Setup URL copied.");
    } catch (error) {
      toast.error("Could not copy the setup URL.");
    }
  }

  const visibleProfileImage = removeProfileImage
    ? ""
    : profileImagePreview || profile?.profile_image_url || "";
  const visibleName =
    fullName.trim() || profile?.full_name || profile?.email || "Profile";
  const visibleInitials = initialsForUser(visibleName);
  const roleLabel = roleLabelForProfile(profile);
  const hasPasswordChanges = Boolean(
    currentPassword || newPassword || confirmNewPassword,
  );
  const hasProfileChanges = useMemo(
    () =>
      fullName.trim() !== (profile?.full_name || "") ||
      Boolean(profileImageFile) ||
      removeProfileImage ||
      hasPasswordChanges,
    [
      fullName,
      profile?.full_name,
      profileImageFile,
      removeProfileImage,
      hasPasswordChanges,
    ],
  );

  if (loading) {
    return (
      <PageLoader
        label="Loading profile"
        detail="Fetching your account settings and security status."
      />
    );
  }

  return (
    <div className="page-stack">
      <section className="detail-card profile-shell">
        <div className="panel-header profile-header-bar">
          <h1>Profile</h1>
          <button
            type="button"
            className="ghost-button"
            onClick={isEditing ? stopEditing : startEditing}
          >
            {isEditing ? "Cancel" : "Edit"}
          </button>
        </div>

        {!isEditing ? (
          <div className="profile-view-card">
            <div className="profile-summary">
              {visibleProfileImage ? (
                <img
                  className="profile-avatar profile-avatar-large profile-summary-avatar"
                  src={visibleProfileImage}
                  alt={visibleName}
                />
              ) : (
                <div className="profile-avatar profile-avatar-large profile-summary-avatar">
                  {visibleInitials}
                </div>
              )}
              <div className="profile-summary-meta">
                <h2>{visibleName}</h2>
                <p>{profile?.email}</p>
                <span className="status-pill">{roleLabel}</span>
              </div>
            </div>

            <div className="settings-list">
              <div className="settings-row">
                <span>Name</span>
                <strong>{profile?.full_name || "-"}</strong>
              </div>
              <div className="settings-row">
                <span>Email</span>
                <strong>{profile?.email}</strong>
              </div>
              <div className="settings-row">
                <span>Role</span>
                <strong>{roleLabel}</strong>
              </div>
              <div className="settings-row">
                <span>Two-Factor</span>
                <strong>{twoFactorStatusLabel()}</strong>
              </div>
            </div>
          </div>
        ) : (
          <div className="page-stack">
            <form className="stack-form" onSubmit={saveProfile}>
              <div className="profile-editor-card">
                <div className="profile-media-panel">
                  <div className="profile-photo-stack">
                    <div className="profile-photo-frame">
                      {visibleProfileImage ? (
                        <img
                          className="profile-avatar profile-avatar-large"
                          src={visibleProfileImage}
                          alt={visibleName}
                        />
                      ) : (
                        <div className="profile-avatar profile-avatar-large">
                          {visibleInitials}
                        </div>
                      )}
                      <label
                        className="profile-photo-upload"
                        aria-label="Upload profile photo"
                        title="Upload profile photo"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M12 5a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H6a1 1 0 1 1 0-2h5V6a1 1 0 0 1 1-1Z"
                            fill="currentColor"
                          />
                        </svg>
                        <span className="sr-only">Upload profile photo</span>
                        <input
                          className="profile-upload-input"
                          type="file"
                          accept="image/*"
                          onChange={handleProfileImageChange}
                        />
                      </label>
                    </div>
                    {visibleProfileImage ? (
                      <button
                        type="button"
                        className="ghost-button profile-photo-remove"
                        onClick={clearProfileImage}
                      >
                        Remove Photo
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="detail-facts profile-form-grid">
                  <label>
                    <span className="fact-label">Name</span>
                    <input
                      value={fullName}
                      onChange={(event) => setFullName(event.target.value)}
                      placeholder="Your name"
                    />
                  </label>
                  <label>
                    <span className="fact-label">Email</span>
                    <input value={profile?.email || ""} readOnly disabled />
                  </label>
                </div>
              </div>

              <section className="detail-main profile-password-card">
                <div className="panel-header">
                  <div className="profile-section-heading">
                    <h2>Change Password</h2>
                  </div>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      setPasswordSectionOpen((current) => !current)
                    }
                  >
                    {passwordSectionOpen ? "Hide" : "Expand"}
                  </button>
                </div>

                {passwordSectionOpen ? (
                  <div className="profile-password-panel">
                    <div className="profile-password-grid">
                      <label className="field-span-full">
                        <span className="fact-label">Current Password</span>
                        <div className="password-input-row">
                          <input
                            type={showCurrentPassword ? "text" : "password"}
                            value={currentPassword}
                            onChange={(event) =>
                              setCurrentPassword(event.target.value)
                            }
                            autoComplete="current-password"
                            placeholder="Current password"
                          />
                          <button
                            type="button"
                            className="password-visibility-button"
                            onClick={() =>
                              setShowCurrentPassword((current) => !current)
                            }
                            aria-label={
                              showCurrentPassword
                                ? "Hide current password"
                                : "Show current password"
                            }
                          >
                            {showCurrentPassword ? "Hide" : "Show"}
                          </button>
                        </div>
                      </label>
                      <label>
                        <span className="fact-label">New Password</span>
                        <div className="password-input-row">
                          <input
                            type={showNewPassword ? "text" : "password"}
                            value={newPassword}
                            onChange={(event) =>
                              setNewPassword(event.target.value)
                            }
                            autoComplete="new-password"
                            placeholder="New password"
                          />
                          <button
                            type="button"
                            className="password-visibility-button"
                            onClick={() =>
                              setShowNewPassword((current) => !current)
                            }
                            aria-label={
                              showNewPassword
                                ? "Hide new password"
                                : "Show new password"
                            }
                          >
                            {showNewPassword ? "Hide" : "Show"}
                          </button>
                        </div>
                      </label>
                      <label>
                        <span className="fact-label">Confirm New Password</span>
                        <div className="password-input-row">
                          <input
                            type={showConfirmNewPassword ? "text" : "password"}
                            value={confirmNewPassword}
                            onChange={(event) =>
                              setConfirmNewPassword(event.target.value)
                            }
                            autoComplete="new-password"
                            placeholder="Confirm new password"
                          />
                          <button
                            type="button"
                            className="password-visibility-button"
                            onClick={() =>
                              setShowConfirmNewPassword((current) => !current)
                            }
                            aria-label={
                              showConfirmNewPassword
                                ? "Hide confirm new password"
                                : "Show confirm new password"
                            }
                          >
                            {showConfirmNewPassword ? "Hide" : "Show"}
                          </button>
                        </div>
                      </label>
                    </div>
                  </div>
                ) : null}
              </section>

              <div className="profile-save-bar">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={savingProfile || !hasProfileChanges}
                >
                  {savingProfile ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>

            <section className="detail-main">
              <div className="panel-header">
                <div className="profile-section-heading">
                  <h2>Two-Factor Authentication</h2>
                </div>
                <span
                  className={`status-pill ${twoFactor.enabled ? "status-ready" : "status-needs_review"}`}
                >
                  {twoFactorStatusLabel()}
                </span>
              </div>

              <div className="profile-security-grid">
                <div className="settings-list">
                  <div className="settings-row">
                    <span>Status</span>
                    <strong>{twoFactorStatusLabel()}</strong>
                  </div>
                  <div className="settings-row">
                    <span>Requirement</span>
                    <strong>
                      {twoFactor.required ? "Required by admin" : "Optional"}
                    </strong>
                  </div>
                  <div className="settings-row">
                    <span>Method</span>
                    <strong>
                      {twoFactor.enabled
                        ? "Authenticator app"
                        : "Not configured"}
                    </strong>
                  </div>
                </div>
              </div>

              <div className="inline-pills">
                {!twoFactor.enabled ? (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={
                      setupVisible ? () => setSetupVisible(false) : openSetup
                    }
                    disabled={Boolean(totpAction)}
                  >
                    <span className="button-label">
                      {totpAction === "setup" ? (
                        <LoadingSpinner size={14} />
                      ) : null}
                      {totpAction === "setup"
                        ? "Preparing..."
                        : setupVisible
                          ? "Hide Setup"
                          : "Setup Authenticator"}
                    </span>
                  </button>
                ) : null}
                {twoFactor.enabled && !twoFactor.required ? (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={disableTotp}
                    disabled={Boolean(totpAction)}
                  >
                    <span className="button-label">
                      {totpAction === "disable" ? (
                        <LoadingSpinner size={14} />
                      ) : null}
                      {totpAction === "disable" ? "Turning off..." : "Turn Off"}
                    </span>
                  </button>
                ) : null}
              </div>

              {setupVisible && setup.provisioning_uri ? (
                <div className="totp-setup-panel">
                  <div className="panel-header">
                    <div className="profile-section-heading">
                      <h3>Authenticator Setup</h3>
                    </div>
                    <div className="inline-pills">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={copyProvisioningUrl}
                        disabled={Boolean(totpAction)}
                      >
                        Copy URL
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={cancelSetup}
                        disabled={Boolean(totpAction)}
                      >
                        <span className="button-label">
                          {totpAction === "cancel" ? (
                            <LoadingSpinner size={14} />
                          ) : null}
                          {totpAction === "cancel"
                            ? "Canceling..."
                            : "Cancel Setup"}
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="two-column-layout profile-setup-grid">
                    <div
                      className="totp-qr-card"
                      aria-label="Two-factor QR code"
                      dangerouslySetInnerHTML={{ __html: setup.qr_svg }}
                    />
                    <div className="stack-form">
                      <div className="settings-list">
                        <span className="fact-label">Setup URL</span>
                        <p className="mono-line">{setup.provisioning_uri}</p>
                        <span className="fact-label">Secret</span>
                        <p className="mono-line">{setup.secret}</p>
                      </div>

                      <form className="stack-form" onSubmit={confirmSetup}>
                        <label>
                          <span className="fact-label">Verification Code</span>
                          <input
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            inputMode="numeric"
                            placeholder="123456"
                          />
                        </label>
                        <div className="inline-pills">
                          <button
                            type="submit"
                            className="primary-button"
                            disabled={Boolean(totpAction)}
                          >
                            <span className="button-label">
                              {totpAction === "verify" ? (
                                <LoadingSpinner size={14} />
                              ) : null}
                              {totpAction === "verify"
                                ? "Verifying..."
                                : "Verify and Enable"}
                            </span>
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
