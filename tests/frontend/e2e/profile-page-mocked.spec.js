import { expect, test } from "./support/playwright";

const profilePayload = {
  id: 1,
  email: "profile-user@example.com",
  full_name: "Profile User",
  profile_image_url: "",
  is_active: true,
  is_staff: false,
  is_superuser: false,
};

function sessionPayload({ totpEnabled = false } = {}) {
  return {
    authenticated: true,
    user: {
      ...profilePayload,
      totp_enabled: totpEnabled,
      totp_required: false,
      totp_setup_required: false,
      capabilities: [],
    },
  };
}

function twoFactorStatus({ enabled = false, pendingSetup = false } = {}) {
  return {
    enabled,
    pending_setup: pendingSetup,
    required: false,
    setup_required: false,
  };
}

async function installProfileRoutes(page) {
  let totpEnabled = false;
  let pendingSetup = false;

  await page.route("**/api/csrf/", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/auth/session/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sessionPayload({ totpEnabled })),
    });
  });
  await page.route("**/api/auth/profile/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(profilePayload),
    });
  });
  await page.route("**/api/auth/2fa/status/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        twoFactorStatus({ enabled: totpEnabled, pendingSetup }),
      ),
    });
  });
  await page.route("**/api/auth/2fa/setup/", async (route) => {
    pendingSetup = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provisioning_uri:
          "otpauth://totp/RSalehin24%20Library:profile-user@example.com",
        secret: "ABCDEF123456",
        qr_svg: "<svg viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\" /></svg>",
      }),
    });
  });
  await page.route("**/api/auth/2fa/cancel/", async (route) => {
    pendingSetup = false;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Pending TOTP setup canceled." }),
    });
  });
  await page.route("**/api/auth/2fa/confirm/", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.token === "000000") {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Invalid TOTP token." }),
      });
      return;
    }

    totpEnabled = true;
    pendingSetup = false;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ detail: "TOTP is now enabled." }),
    });
  });
}

async function openProfileEditor(page) {
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "Profile", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(
    page.getByRole("heading", { name: "Two-Factor Authentication" }),
  ).toBeVisible();
}

test.describe("Profile Page TOTP Notifications", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("setup and cancel do not create toast notifications", async ({ page }) => {
    await installProfileRoutes(page);
    await openProfileEditor(page);

    await page.getByRole("button", { name: "Setup Authenticator" }).click();
    await expect(
      page.getByRole("heading", { name: "Authenticator Setup" }),
    ).toBeVisible();
    await expect(page.locator(".toast")).toHaveCount(0);

    await page.getByRole("button", { name: "Cancel Setup" }).click();
    await expect(
      page.getByRole("heading", { name: "Authenticator Setup" }),
    ).toHaveCount(0);
    await expect(page.locator(".toast")).toHaveCount(0);
  });

  test("verify still reports success and token errors", async ({ page }) => {
    await installProfileRoutes(page);
    await openProfileEditor(page);

    await page.getByRole("button", { name: "Setup Authenticator" }).click();
    await page.getByLabel("Verification Code").fill("000000");
    await page.getByRole("button", { name: "Verify and Enable" }).click();
    await expect(page.getByRole("alert")).toContainText("Invalid TOTP token.");

    await page.getByLabel("Dismiss notification").click();
    await page.getByLabel("Verification Code").fill("123456");
    await page.getByRole("button", { name: "Verify and Enable" }).click();
    await expect(page.getByRole("status")).toContainText("Two-factor enabled.");
  });
});
