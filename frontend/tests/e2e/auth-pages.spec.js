import { expect, test } from "playwright/test";
import { AuthPageModel } from "./pages/authPage";
import { installApiGuard } from "./support/appMocks";
import { mockAuthApi } from "./support/authApi";

test.describe("Auth Pages", () => {
  test("login keeps the entered account during OTP verification and lands on the home page", async ({
    page,
  }) => {
    await installApiGuard(page);
    const state = await mockAuthApi(page);
    const authPage = new AuthPageModel(page);

    await authPage.gotoLogin();
    await authPage.fillCredentials({
      email: "admin@example.com",
      password: "top-secret",
    });
    await authPage.submitLogin();

    await expect(authPage.otpInput()).toBeVisible();
    await expect(authPage.emailInput()).toHaveValue("admin@example.com");
    await expect(authPage.passwordInput()).toHaveValue("top-secret");

    await authPage.otpInput().fill("123456");
    await authPage.submitLogin();

    await expect(page.getByRole("heading", { name: "All Books" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "OTP Safe Book" }),
    ).toBeVisible();
    await expect.poll(() => state.loginCalls.length).toBe(2);
    await expect(state.loginCalls[0]).toEqual({
      email: "admin@example.com",
      password: "top-secret",
      otp_token: "",
    });
    await expect(state.loginCalls[1]).toEqual({
      email: "admin@example.com",
      password: "top-secret",
      otp_token: "123456",
    });
  });

  test("password reset confirmation returns the user to sign in after success", async ({
    page,
  }) => {
    await installApiGuard(page);
    const state = await mockAuthApi(page);
    const authPage = new AuthPageModel(page);

    await authPage.gotoPasswordResetLink();
    await authPage.fillResetPasswords("new-password-123");
    await authPage.submitPasswordReset();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect.poll(() => state.passwordResetConfirmCalls.length).toBe(1);
    await expect(state.passwordResetConfirmCalls[0]).toEqual({
      uid: "reset-user",
      token: "reset-token",
      new_password: "new-password-123",
    });
  });
});
