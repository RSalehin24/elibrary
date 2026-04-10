import { expect } from "playwright/test";

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
    ).toBeVisible();
  }

  card(title) {
    return this.page.locator("section.processing-card", {
      has: this.page.getByRole("heading", { name: title, exact: true }),
    });
  }

  async searchCard(title, query) {
    const card = this.card(title);
    const input = card.locator('input[type="search"]').first();
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

    if (enabled !== undefined) {
      if (enabled) {
        await toggle.check();
      } else {
        await toggle.uncheck();
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
