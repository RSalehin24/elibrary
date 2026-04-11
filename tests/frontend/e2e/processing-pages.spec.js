import { expect, test } from "./support/playwright";
import { ProcessingPageModel } from "./pages/processingPage";
import { loginAsSuperAdmin } from "./support/liveApp";
import { seedData } from "./support/seedData";

test.describe("Processing Pages", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page);
  });

  test("processing header spinner clears once the shared activity endpoint reports idle", async ({
    page,
  }) => {
    await page.route("**/api/ingestion/activity/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          can_manage_processing: true,
          has_visible_activity: false,
          active_scopes: [],
        }),
      });
    });

    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-my-requests", "My Requests");

    await expect(
      processingPage.rowInCard("Requests", seedData.submissions.alpha),
    ).toBeVisible();
    await expect(processingPage.headerSpinner("My Requests")).toHaveCount(0);
  });

  test("processing header spinner stays visible across processing pages while shared activity is active", async ({
    page,
  }) => {
    await page.route("**/api/ingestion/activity/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          can_manage_processing: true,
          has_visible_activity: true,
          active_scopes: ["jobs", "runs"],
        }),
      });
    });

    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-my-requests", "My Requests");

    await expect(
      processingPage.rowInCard("Requests", seedData.submissions.alpha),
    ).toBeVisible();
    await expect(processingPage.headerSpinner("My Requests")).toBeVisible();

    await processingPage.goto("/processing-all-activity", "All Activity");

    await expect(
      processingPage.rowInCard("All Requests", seedData.submissions.alpha),
    ).toBeVisible();
    await expect(processingPage.headerSpinner("All Activity")).toBeVisible();
  });

  test("my requests submission search refreshes only the request list", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-my-requests", "My Requests");

    await expect(
      processingPage.rowInCard("Requests", seedData.submissions.alpha),
    ).toBeVisible();
    await expect(
      processingPage.rowInCard("Requests", seedData.submissions.beta),
    ).toBeVisible();

    await processingPage.searchCard("Requests", "Alpha");

    await expect(
      processingPage.rowInCard("Requests", seedData.submissions.alpha),
    ).toBeVisible();
  });

  test("catalog books search refreshes the catalog table without losing the visible result", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-catalog-books", "Catalog Books");

    await expect(
      processingPage.rowInCard("Catalog Books", seedData.catalogEntries.alpha),
    ).toBeVisible();
    await expect(
      processingPage.rowInCard("Catalog Books", seedData.catalogEntries.beta),
    ).toBeVisible();

    await processingPage.searchCard("Catalog Books", "Alpha");

    await expect(
      processingPage.rowInCard("Catalog Books", seedData.catalogEntries.alpha),
    ).toBeVisible();
    await expect(
      processingPage.card("Catalog Books").getByRole("row").filter({
        hasText: seedData.catalogEntries.beta,
      }),
    ).toHaveCount(0);
  });

  test("automation settings save keeps the chosen schedule in the form after the refresh completes", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-automation", "Automation");
    await processingPage.saveAutomation({
      enabled: true,
      time: "04:30",
      frequency: "weekly",
      mode: "all",
      pages: 12,
    });

    await page.reload();

    const automationCard = processingPage.card("Automation");
    await expect(
      automationCard.locator('.processing-switch input[type="checkbox"]'),
    ).toBeChecked();
    await expect(automationCard.locator('input[type="time"]')).toHaveValue(
      "04:30",
    );
    await expect(automationCard.locator("select").first()).toHaveValue(
      "weekly",
    );
    await expect(automationCard.locator("select").nth(1)).toHaveValue("all");
    await expect(automationCard.locator('input[type="number"]')).toHaveValue(
      "12",
    );
  });

  test("all activity search keeps the matching submission visible in the shared queue view", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-all-activity", "All Activity");

    await processingPage.searchCard("All Requests", "Alpha");

    await expect(
      processingPage.rowInCard("All Requests", seedData.submissions.alpha),
    ).toBeVisible();
  });

  test("incomplete catalog reprocess queues the selected live incomplete book", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto(
      "/processing-incomplete-check",
      "Incomplete Automation",
    );

    const incompleteCard = processingPage.card("Incomplete Catalog");
    const incompleteRow = incompleteCard.getByRole("row", {
      name: new RegExp(seedData.books.incomplete.title),
    });

    await expect(incompleteRow).toBeVisible();
    await processingPage.selectIncompleteBook(seedData.books.incomplete.title);
    await processingPage.reprocessSelectedIncomplete();

    await expect(page.getByText("Reprocess queued.")).toBeVisible();
    await expect(incompleteRow).toBeVisible();
    await expect(
      processingPage.rowInCard(
        "Failed Jobs Create Queue",
        /e2e incomplete catalog book/i,
      ),
    ).toBeVisible();
  });
});
