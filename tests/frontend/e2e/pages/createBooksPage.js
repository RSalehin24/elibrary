import { expect } from "../support/playwright";

export class CreateBooksPageModel {
  constructor(page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto("/create");
    await expect(
      this.page.getByRole("heading", { name: "Create EPUB", exact: true }),
    ).toBeVisible();
  }

  requestInput(index = 0) {
    return this.page.getByLabel(`Request ${index + 1}`);
  }

  async submitSingle(value) {
    await this.requestInput().fill(value);
    await this.page.getByRole("button", { name: "Create" }).click();
  }

  submissionCard(title) {
    return this.page.locator(".submission-card").filter({
      has: this.page.getByText(title, { exact: true }),
    });
  }

  async openActionDialog(title) {
    const dialog = this.page.getByRole("dialog");
    try {
      await dialog.waitFor({ state: "visible", timeout: 3000 });
      await expect(dialog).toBeVisible();
      return;
    } catch {}

    await this.submissionCard(title)
      .getByRole("button", { name: "Choose action" })
      .click();
    await expect(dialog).toBeVisible();
  }
}
