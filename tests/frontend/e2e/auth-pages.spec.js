import { expect, test } from "./support/playwright";
import { loginAsSuperAdmin } from "./support/liveApp";
import { seedData } from "./support/seedData";

test.describe("Auth Pages", () => {
  test("sign in reaches the live catalog and search narrows the visible books", async ({
    page,
  }) => {
    await loginAsSuperAdmin(page);

    await expect(
      page.getByRole("heading", { name: seedData.books.homePrimary.title }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: seedData.books.homeSecondary.title }),
    ).toBeVisible();

    const search = page.getByPlaceholder(
      "Search all books by title, book ID, or writer...",
    );
    await search.fill("Companion");
    await search.press("Enter");

    await expect(
      page.getByRole("heading", { name: seedData.books.homeSecondary.title }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: seedData.books.homePrimary.title }),
    ).toHaveCount(0);
  });

  test("home pagination limits the visible cover grid", async ({ page }) => {
    await loginAsSuperAdmin(page);

    await page.getByLabel("Rows").selectOption("5");

    await expect(
      page.getByRole("heading", { name: seedData.books.homePrimary.title }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.getByRole("heading", { name: seedData.books.homePrimary.title }),
    ).toBeVisible();
  });
});
