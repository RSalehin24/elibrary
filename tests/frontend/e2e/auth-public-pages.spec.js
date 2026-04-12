import { expect, test } from "./support/playwright";
import { AuthPageModel } from "./pages/authPage";

test.describe("Public Auth Pages", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign in requires complete credentials and shows live email feedback", async ({
    page,
  }) => {
    const authPage = new AuthPageModel(page);

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: false, user: null }),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });

    await authPage.gotoLogin();

    const continueButton = page.getByRole("button", { name: "Continue" });
    await expect(page.locator(".login-email-feedback")).toHaveCount(0);
    await expect(continueButton).toBeDisabled();

    await authPage.emailInput().fill("reader");
    await expect(page.locator(".login-email-feedback-invalid")).toBeVisible();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(continueButton).toBeDisabled();

    await authPage.passwordInput().fill("strong-password-123");
    await expect(continueButton).toBeDisabled();

    await authPage.emailInput().fill("reader@example.com");
    await expect(page.locator(".login-email-feedback-valid")).toBeVisible();
    await expect(page.getByText("Email looks good.")).toBeVisible();
    await expect(continueButton).toBeEnabled();
  });

  test("reset password page requests a reset email with the entered address", async ({
    page,
  }) => {
    const authPage = new AuthPageModel(page);
    let resolveResetRequest;
    const resetRequestPromise = new Promise((resolve) => {
      resolveResetRequest = resolve;
    });

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: false, user: null }),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/password-reset/", async (route) => {
      resolveResetRequest(JSON.parse(route.request().postData() || "{}"));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Reset email has been sent.",
        }),
      });
    });

    await authPage.gotoPasswordResetRequest();
    await expect(
      page.getByText(
        "Enter your email address and we'll send you a secure password reset link.",
      ),
    ).toHaveCount(0);
    await authPage.fillPasswordResetRequestEmail("reader@example.com");
    await authPage.submitPasswordResetRequest();

    expect(await resetRequestPromise).toEqual({ email: "reader@example.com" });
    await expect(page.getByText("Reset email has been sent.")).toBeVisible();
  });

  test("reset password page shows the missing-user message without extra copy", async ({
    page,
  }) => {
    const authPage = new AuthPageModel(page);

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: false, user: null }),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/password-reset/", async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "No user exist with this email.",
        }),
      });
    });

    await authPage.gotoPasswordResetRequest();
    await authPage.fillPasswordResetRequestEmail("missing@example.com");
    await authPage.submitPasswordResetRequest();

    await expect(page.getByText("No user exist with this email.")).toBeVisible();
  });

  test("expired reset password links render the expired state instead of the form", async ({
    page,
  }) => {
    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: false, user: null }),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/password-reset/validate/", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Reset token is invalid or expired.",
        }),
      });
    });

    await page.goto("/reset-password/confirm?uid=expired-uid&token=expired-token");

    await expect(
      page.getByRole("heading", { name: "The link has expired" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Reset password" }),
    ).toHaveCount(0);
  });

  test("create password page shows a clean validation toast for short passwords", async ({
    page,
  }) => {
    const authPage = new AuthPageModel(page);

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: false, user: null }),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/password-reset/validate/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Password link is valid.",
        }),
      });
    });
    await page.route("**/api/auth/password-reset/confirm/", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Ensure this field has at least 12 characters.",
        }),
      });
    });

    await authPage.gotoCreatePasswordLink("invite-uid", "invite-token");
    await authPage.fillResetPasswords("short");
    await authPage.submitPasswordReset();

    const errorToast = page.getByRole("alert");
    await expect(errorToast.getByText("Something went wrong")).toBeVisible();
    await expect(
      errorToast.getByText("Ensure this field has at least 12 characters."),
    ).toBeVisible();
  });

  test("create password confirmation sends required users into the forced two-factor setup flow", async ({
    page,
  }) => {
    const authPage = new AuthPageModel(page);
    let resolveConfirmRequest;
    const confirmRequestPromise = new Promise((resolve) => {
      resolveConfirmRequest = resolve;
    });
    let sessionPayload = {
      authenticated: false,
      user: null,
    };

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(sessionPayload),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/password-reset/validate/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Password link is valid.",
        }),
      });
    });
    await page.route("**/api/auth/password-reset/confirm/", async (route) => {
      resolveConfirmRequest(JSON.parse(route.request().postData() || "{}"));
      sessionPayload = {
        authenticated: true,
        user: {
          id: 77,
          email: "invitee@example.com",
          full_name: "Invitee User",
          profile_image_url: "",
          is_active: true,
          is_staff: false,
          is_superuser: false,
          totp_enabled: false,
          totp_required: true,
          totp_setup_required: true,
          capabilities: [],
        },
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Password saved. Continue with two-factor setup.",
          next_step: "totp_setup",
          user: sessionPayload.user,
        }),
      });
    });
    await page.route("**/api/auth/2fa/setup/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          provisioning_uri: "otpauth://totp/Bangla%20Library:invitee@example.com",
          secret: "ABC123XYZ789",
          qr_svg:
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='#ffffff'/><rect x='20' y='20' width='60' height='60' fill='#123f33'/></svg>",
        }),
      });
    });

    await authPage.gotoCreatePasswordLink("invite-uid", "invite-token");
    await expect(page.locator("header.topbar")).toHaveCount(1);
    await expect(page.locator("header.topbar.topbar-public")).toHaveCount(1);
    await expect(page.locator("header.topbar .session-box")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
    await authPage.fillResetPasswords("strong-password-456");
    await authPage.submitPasswordReset();

    expect(await confirmRequestPromise).toEqual({
      uid: "invite-uid",
      token: "invite-token",
      new_password: "strong-password-456",
    });
    await expect(
      page.getByText(
        "Password created. Set up two-factor authentication to continue.",
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/two-factor-setup/);
    await expect(
      page.getByRole("heading", { name: "Set up two-factor authentication" }),
    ).toBeVisible();
    await expect(page.locator("header.topbar")).toHaveCount(1);
    await expect(page.locator("header.topbar.topbar-public")).toHaveCount(1);
    await expect(page.locator("header.topbar .topnav")).toHaveCount(0);
    await expect(page.locator("header.topbar .session-box")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "My Books" })).toHaveCount(0);
    await expect(page.locator("header.topbar .profile-menu-trigger")).toHaveCount(0);
    await expect(page.locator("section.auth-setup-card.login-card")).toBeVisible();
    await expect(
      page.getByText(
        "Your administrator requires an authenticator app before you can use the rest of Bangla Library.",
      ),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Verify and Continue" }),
    ).toBeVisible();
  });

  test("expired create password links render the expired state instead of the form", async ({
    page,
  }) => {
    const authPage = new AuthPageModel(page);
    let validateCount = 0;
    let confirmCount = 0;

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: false, user: null }),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/password-reset/validate/", async (route) => {
      validateCount += 1;
      if (validateCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "Password link is valid.",
          }),
        });
        return;
      }

      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Reset token is invalid or expired.",
        }),
      });
    });
    await page.route("**/api/auth/password-reset/confirm/", async (route) => {
      confirmCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Password reset complete.",
          next_step: "login",
        }),
      });
    });

    await authPage.gotoCreatePasswordLink("single-use-uid", "single-use-token");
    await expect(page.locator("header.topbar .session-box")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
    await authPage.fillResetPasswords("strong-password-456");
    await authPage.submitPasswordReset();

    await expect(page).toHaveURL(/\/login/);

    await page.goto("/create-password?uid=single-use-uid&token=single-use-token");

    expect(confirmCount).toBe(1);
    await expect(
      page.getByRole("heading", { name: "The link has been expired" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create password" }),
    ).toHaveCount(0);
  });

  test("required users are redirected away from protected pages into the setup gate", async ({
    page,
  }) => {
    const sessionPayload = {
      authenticated: true,
      user: {
        id: 88,
        email: "forced-setup@example.com",
        full_name: "Forced Setup",
        profile_image_url: "",
        is_active: true,
        is_staff: false,
        is_superuser: false,
        totp_enabled: false,
        totp_required: true,
        totp_setup_required: true,
        capabilities: [],
      },
    };

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(sessionPayload),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/2fa/setup/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          provisioning_uri:
            "otpauth://totp/Bangla%20Library:forced-setup@example.com",
          secret: "FORCED123456",
          qr_svg:
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='#ffffff'/><circle cx='50' cy='50' r='24' fill='#123f33'/></svg>",
        }),
      });
    });

    await page.goto("/home");

    await expect(page).toHaveURL(/\/two-factor-setup/);
    await expect(page.locator("header.topbar")).toHaveCount(1);
    await expect(page.locator("header.topbar.topbar-public")).toHaveCount(1);
    await expect(page.locator("header.topbar .topnav")).toHaveCount(0);
    await expect(page.locator("header.topbar .session-box")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "My Books" })).toHaveCount(0);
    await expect(page.locator("header.topbar .profile-menu-trigger")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Set up two-factor authentication" }),
    ).toBeVisible();
    await expect(page.locator("section.auth-setup-card.login-card")).toBeVisible();
  });
});
