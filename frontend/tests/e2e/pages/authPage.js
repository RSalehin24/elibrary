import { expect } from "playwright/test";

export class AuthPageModel {
  constructor(page) {
    this.page = page;
  }

  async gotoLogin() {
    await this.page.goto("/login");
    await expect(
      this.page.getByRole("heading", { name: "Sign in" }),
    ).toBeVisible();
  }

  async gotoPasswordResetLink(uid = "reset-user", token = "reset-token") {
    await this.page.goto(`/reset-password?uid=${uid}&token=${token}`);
    await expect(
      this.page.getByRole("heading", { name: "New password" }),
    ).toBeVisible();
  }

  emailInput() {
    return this.page.getByLabel("Email");
  }

  passwordInput() {
    return this.page
      .locator("label", { hasText: "Password" })
      .locator("input")
      .first();
  }

  otpInput() {
    return this.page.getByLabel("TOTP code");
  }

  async fillCredentials({ email, password }) {
    await this.emailInput().fill(email);
    await this.passwordInput().fill(password);
  }

  async submitLogin() {
    await this.page.getByRole("button", { name: /Continue|Verify/ }).click();
  }

  async fillResetPasswords(password) {
    await this.page
      .locator("label", { hasText: "New password" })
      .locator("input")
      .first()
      .fill(password);
    await this.page
      .locator("label", { hasText: "Confirm password" })
      .locator("input")
      .first()
      .fill(password);
  }

  async submitPasswordReset() {
    await this.page.getByRole("button", { name: "Reset password" }).click();
  }
}
