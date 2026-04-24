import { expect, test } from "./support/playwright";
import { loginAsSuperAdmin } from "./support/liveApp";
import { seedData } from "./support/seedData";
import { assertNoPageOverflow } from "./responsive-layout/index.js";

test.describe("responsive live reader coverage", () => {
  test("book detail and reader stay contained at landscape tablet size", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await loginAsSuperAdmin(page);

    await page.goto(`/books/${seedData.books.detail.slug}`);
    await expect(page.getByTestId("book-detail-hero")).toBeVisible();
    await assertNoPageOverflow(page);

    await page.getByTestId("book-open-reader-button").click();
    await expect(page).toHaveURL(/\/reader\?/);
    await expect(page.locator("#reader-view")).toBeVisible();
    await expect(page.locator("#viewer iframe")).toBeVisible({
      timeout: 15_000,
    });
    await assertNoPageOverflow(page);
  });
});
