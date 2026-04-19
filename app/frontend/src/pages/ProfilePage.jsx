import { useEffect, useMemo, useState } from "react";
import { authApi } from "../api/client";
import EmailInputFeedback from "../components/EmailInputFeedback";
import LoadingSpinner from "../components/LoadingSpinner";
import PageLoader from "../components/PageLoader";
import TwoFactorSetupPanel from "../components/TwoFactorSetupPanel";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import {
  KINDLE_EMAIL_INVALID_MESSAGE,
  getKindleEmailValidationState,
} from "../utils/email";

const emptySetup = {
  provisioning_uri: "",
  secret: "",
  qr_svg: "",
};

function kindleEmailFieldsFromProfile(emails) {
  if (!Array.isArray(emails) || !emails.length) {
    return [""];
  }
  return emails.map((email) => String(email || ""));
}

function serializeKindleEmails(emails) {
  if (!Array.isArray(emails)) {
    return "";
  }
  return emails
    .map((email) => String(email || "").trim())
    .filter(Boolean)
    .join("\n");
}

function kindleEmailInvalidMessage(validationState) {
  if (validationState?.baseEmailLooksValid) {
    return KINDLE_EMAIL_INVALID_MESSAGE;
  }
  return "Enter a valid email address.";
}

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
  const [kindleEmails, setKindleEmails] = useState([""]);
  const [kindleSectionOpen, setKindleSectionOpen] = useState(false);
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
  const [totpFeedback, setTotpFeedback] = useState("");

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
        setKindleEmails(
          kindleEmailFieldsFromProfile(profilePayload.kindle_emails || []),
        );
        setKindleSectionOpen(false);
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
    setKindleEmails(
      kindleEmailFieldsFromProfile(sourceProfile?.kindle_emails || []),
    );
    setKindleSectionOpen(false);
    setPasswordSectionOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmNewPassword("");
    setShowCurrentPassword(false);
    setShowNewPassword(false);
    setShowConfirmNewPassword(false);
    setSetupVisible(false);
    setTotpFeedback("");
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

  function updateKindleEmail(index, value) {
    setKindleEmails((current) =>
      current.map((email, currentIndex) =>
        currentIndex === index ? value : email,
      ),
    );
  }

  function addKindleEmailField() {
    setKindleEmails((current) => [...current, ""]);
  }

  function removeKindleEmailField(index) {
    setKindleEmails((current) => {
      const next = current.filter((_, currentIndex) => currentIndex !== index);
      return next.length ? next : [""];
    });
  }

  async function saveProfile(event) {
    event.preventDefault();
    const hasPasswordChanges = Boolean(
      currentPassword || newPassword || confirmNewPassword,
    );
    const firstInvalidKindleEmail = kindleEmails
      .map((email) => getKindleEmailValidationState(email))
      .find((validationState) =>
        validationState.hasEmailInput && !validationState.emailLooksValid,
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
    if (firstInvalidKindleEmail) {
      toast.error(kindleEmailInvalidMessage(firstInvalidKindleEmail));
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
      body.append("kindle_emails_text", serializeKindleEmails(kindleEmails));
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
      setTotpFeedback("");
      const payload = await authApi.twoFactorSetup();
      setSetup(payload);
      setSetupVisible(true);
      setTwoFactor((current) => ({ ...current, pending_setup: true }));
    } catch (error) {
      setTotpFeedback(error.message || "Could not prepare two-factor setup.");
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
      setTotpFeedback("");
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
      setTotpFeedback("");
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
      setTotpFeedback("");
      await authApi.twoFactorCancel();
      setToken("");
      setSetup(emptySetup);
      setSetupVisible(false);
      await loadProfile({ preserveEditor: true });
    } catch (error) {
      setTotpFeedback(error.message || "Could not cancel two-factor setup.");
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
  const kindleSenderEmail = profile?.kindle_sender_email || "the app sender email";
  const configuredKindleEmails = profile?.kindle_emails || [];
  const serializedKindleEmails = serializeKindleEmails(kindleEmails);
  const kindleEmailValidationStates = useMemo(
    () => kindleEmails.map((email) => getKindleEmailValidationState(email)),
    [kindleEmails],
  );
  const hasInvalidKindleEmail = kindleEmailValidationStates.some(
    (validationState) =>
      validationState.hasEmailInput && !validationState.emailLooksValid,
  );
  const canAddKindleEmail =
    kindleEmailValidationStates.length > 0 &&
    kindleEmailValidationStates.every(
      (validationState) => validationState.emailLooksValid,
    );
  const hasPasswordChanges = Boolean(
    currentPassword || newPassword || confirmNewPassword,
  );
  const hasProfileChanges = useMemo(
    () =>
      fullName.trim() !== (profile?.full_name || "") ||
      Boolean(profileImageFile) ||
      removeProfileImage ||
      serializedKindleEmails !== (profile?.kindle_emails || []).join("\n") ||
      hasPasswordChanges,
    [
      fullName,
      profile?.full_name,
      profile?.kindle_emails,
      profileImageFile,
      removeProfileImage,
      serializedKindleEmails,
      hasPasswordChanges,
    ],
  );

  if (loading) {
    return (
      <PageLoader
        label="Loading profile"
        detail="Fetching your account settings and security status."
        variant="profile"
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
              <div className="settings-row">
                <span>Kindle Mails</span>
                {configuredKindleEmails.length ? (
                  <strong className="profile-multi-line-value">
                    {configuredKindleEmails.map((email) => (
                      <span key={email}>{email}</span>
                    ))}
                  </strong>
                ) : (
                  <strong>Not set</strong>
                )}
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

              <section className="detail-main profile-password-card">
                <div className="panel-header">
                  <div className="profile-section-heading">
                    <h2>Kindle Mails</h2>
                  </div>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      setKindleSectionOpen((current) => !current)
                    }
                  >
                    {kindleSectionOpen ? "Hide" : "Expand"}
                  </button>
                </div>

                {kindleSectionOpen ? (
                  <div className="profile-password-panel">
                    <p className="form-helper-text">
                      In Amazon Personal Document Settings, allow{" "}
                      <strong>{kindleSenderEmail}</strong> in the Approved
                      Personal Document E-mail List. Enter one Kindle email in
                      each field below.
                    </p>
                    <div className="profile-kindle-email-list">
                      {kindleEmails.map((email, index) => {
                        const validationState =
                          kindleEmailValidationStates[index];

                        return (
                          <div
                            key={`kindle-email-${index}`}
                            className="profile-kindle-email-row"
                          >
                            <div className="profile-kindle-email-field">
                              <input
                                type="email"
                                value={email}
                                onChange={(event) =>
                                  updateKindleEmail(index, event.target.value)
                                }
                                inputMode="email"
                                autoCapitalize="none"
                                spellCheck={false}
                                placeholder="yourname@kindle.com"
                                aria-label={`Kindle Email ${index + 1}`}
                                aria-describedby={
                                  validationState?.hasEmailInput
                                    ? `profile-kindle-email-feedback-${index}`
                                    : undefined
                                }
                                aria-invalid={
                                  validationState?.hasEmailInput &&
                                  !validationState.emailLooksValid
                                    ? "true"
                                    : undefined
                                }
                              />
                              {validationState?.hasEmailInput ? (
                                <EmailInputFeedback
                                  id={`profile-kindle-email-feedback-${index}`}
                                  validationState={validationState}
                                  invalidMessage={kindleEmailInvalidMessage(
                                    validationState,
                                  )}
                                  validMessage="Kindle email looks good."
                                />
                              ) : null}
                            </div>
                            {kindleEmails.length > 1 ? (
                              <button
                                type="button"
                                className="icon-button danger-button profile-kindle-email-delete"
                                onClick={() => removeKindleEmailField(index)}
                                aria-label={`Delete email ${index + 1}`}
                                title={`Delete email ${index + 1}`}
                              >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                  <path
                                    d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 7h2v7h-2v-7Zm4 0h2v7h-2v-7ZM7 10h2v7H7v-7Zm-1 10h12l1-13H5l1 13Z"
                                    fill="currentColor"
                                  />
                                </svg>
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    <div className="profile-kindle-email-actions">
                      <button
                        type="button"
                        className="icon-button profile-kindle-email-add"
                        onClick={addKindleEmailField}
                        disabled={!canAddKindleEmail}
                        aria-label="Add Kindle Email"
                        title="Add Kindle Email"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M12 5v14M5 12h14"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>

              <div className="profile-save-bar">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={
                    savingProfile || !hasProfileChanges || hasInvalidKindleEmail
                  }
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

              {totpFeedback ? (
                <p className="form-feedback">{totpFeedback}</p>
              ) : null}

              {setupVisible && setup.provisioning_uri ? (
                <TwoFactorSetupPanel
                  onCancel={cancelSetup}
                  onCopy={copyProvisioningUrl}
                  onSubmit={confirmSetup}
                  onTokenChange={setToken}
                  setup={setup}
                  token={token}
                  totpAction={totpAction}
                />
              ) : null}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
