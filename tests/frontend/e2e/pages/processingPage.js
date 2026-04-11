import { expect } from "../support/playwright";

export class ProcessingPageModel {
  constructor(page) {
    this.page = page;
  }

  async goto(path, heading) {
    await this.page.goto(path);
    await expect(
      this.page.getByRole("heading", {
        name: heading,
        exact: true,
        level: 1,
      }),
    ).toBeVisible({ timeout: 15_000 });
  }

  pageHeader(heading) {
    return this.page.locator("section.detail-card", {
      has: this.page.getByRole("heading", {
        name: heading,
        exact: true,
        level: 1,
      }),
    });
  }

  headerSpinner(heading) {
    return this.pageHeader(heading).locator(".panel-header .loading-spinner");
  }

  card(title) {
    return this.page.locator("section.processing-card", {
      has: this.page.getByRole("heading", { name: title, exact: true }),
    });
  }

  rowInCard(title, pattern) {
    return this.card(title)
      .getByRole("row")
      .filter({ hasText: pattern })
      .first();
  }

  async searchCard(title, query) {
    const card = this.card(title);
    const input = card.locator('input[type="search"]').first();
    await expect(input).toBeVisible();
    await input.fill(query);
    await input.press("Enter");
    return card;
  }

  async saveAutomation({
    title = "Automation",
    enabled,
    time,
    frequency,
    mode,
    pages,
  }) {
    const card = this.card(title);
    const toggle = card.locator('.processing-switch input[type="checkbox"]');
    const toggleLabel = card.locator(".processing-switch");

    if (enabled !== undefined) {
      let isChecked = await toggle.isChecked();
      for (let attempt = 0; attempt < 3 && isChecked !== enabled; attempt += 1) {
        await toggleLabel.click();
        await this.page.waitForTimeout(150);
        isChecked = await toggle.isChecked();
      }
      if (isChecked !== enabled) {
        throw new Error(`Unable to set automation toggle to ${enabled}.`);
      }
    }

    if (time) {
      await card.locator('input[type="time"]').fill(time);
    }

    const selects = card.locator("select");
    if (frequency) {
      await selects.first().selectOption(frequency);
    }
    if (mode && (await selects.count()) > 1) {
      await selects.nth(1).selectOption(mode);
    }

    if (pages !== undefined) {
      await card.locator('input[type="number"]').fill(String(pages));
    }

    await card.getByRole("button", { name: "Save automation" }).click();
    await expect(this.page.getByText("Automation saved.")).toBeVisible();
  }

  async selectIncompleteBook(title) {
    await this.card("Incomplete Catalog")
      .getByLabel(`Select ${title}`)
      .check();
  }

  async reprocessSelectedIncomplete() {
    await this.card("Incomplete Catalog")
      .getByRole("button", { name: "Reprocess selected" })
      .click();
  }
}
