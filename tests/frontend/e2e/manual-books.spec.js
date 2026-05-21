import { expect, test } from "./support/playwright";
import { ManualBooksPageModel } from "./pages/manualBooksPage";
import { loginAsSuperAdmin } from "./support/liveApp";

test.describe("Manual Books Page", () => {
  test("creating a manual book through the live form keeps it searchable in the browser", async ({
    page,
  }, testInfo) => {
    const manualBooksPage = new ManualBooksPageModel(page);
    const uniqueTitle = `E2E Manual Book ${testInfo.parallelIndex + 1} ${Date.now()}`;

    await loginAsSuperAdmin(page);
    await manualBooksPage.goto();
    await manualBooksPage.openComposer();
    await manualBooksPage.fillTitle(uniqueTitle);
    await manualBooksPage.addTag("Writer", "E2E Writer");
    await manualBooksPage.addTag("Category", "E2E Fiction");
    await manualBooksPage.submit();

    await manualBooksPage.search(uniqueTitle);
    await expect(page.getByText(uniqueTitle, { exact: true })).toBeVisible();
  });
});
