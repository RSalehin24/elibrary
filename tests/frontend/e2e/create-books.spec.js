import { expect, test } from "./support/playwright";
import { CreateBooksPageModel } from "./pages/createBooksPage";
import {
  installWindowOpenRecorder,
  loginAsSuperAdmin,
  readOpenedUrls,
} from "./support/liveApp";
import { seedData } from "./support/seedData";

test.describe("Create Books Page", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page);
  });

  test("reusing a seeded title can launch the live reader from the action dialog", async ({
    page,
  }) => {
    const createBooksPage = new CreateBooksPageModel(page);

    await createBooksPage.goto();
    await createBooksPage.submitSingle(seedData.books.detail.sourceUrl);

    await expect(
      createBooksPage.submissionCard(seedData.books.detail.sourceUrl),
    ).toContainText("Reused existing record.");

    await createBooksPage.openActionDialog(seedData.books.detail.sourceUrl);
    await page.getByRole("button", { name: "Read" }).click();

    await expect(page).toHaveURL(/\/reader\?/);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("manifest"), {
        timeout: 15_000,
      })
      .toBeTruthy();
  });

  test("reusing a seeded title can start a protected download from the browser", async ({
    page,
  }) => {
    const createBooksPage = new CreateBooksPageModel(page);

    await installWindowOpenRecorder(page);
    await createBooksPage.goto();
    await createBooksPage.submitSingle(seedData.books.detail.sourceUrl);
    await createBooksPage.openActionDialog(seedData.books.detail.sourceUrl);
    await page.getByRole("button", { name: "Download" }).click();

    await expect
      .poll(async () => (await readOpenedUrls(page)).join("\n"))
      .toMatch(/\/api\/access\/reader\/.+\/epub\//);
  });
});
