import { expect, test } from "./support/playwright";
import { ProcessingPageModel } from "./pages/processingPage";
import { loginAsSuperAdmin } from "./support/liveApp";
import { seedData } from "./support/seedData";

async function expectRowOnlyInCard(
  processingPage,
  rowPattern,
  visibleCard,
  hiddenCards = [],
) {
  for (const title of [visibleCard, ...hiddenCards]) {
    await processingPage.expandCard(title);
  }

  await expect(processingPage.rowInCard(visibleCard, rowPattern)).toBeVisible();

  for (const title of hiddenCards) {
    await expect(processingPage.rowInCard(title, rowPattern)).toHaveCount(0);
  }
}

async function expectRowInAnyCard(processingPage, rowPattern, cardTitles) {
  for (const title of cardTitles) {
    await processingPage.expandCard(title);
  }

  await expect
    .poll(async () => {
      for (const title of cardTitles) {
        if (await processingPage.rowInCard(title, rowPattern).count()) {
          return title;
        }
      }
      return "";
    })
    .not.toBe("");
}

function summaryValue(processingPage, cardTitle, label) {
  return processingPage
    .card(cardTitle)
    .locator(".processing-summary-stat", {
      has: processingPage.page.getByText(label, { exact: true }),
    })
    .locator("strong");
}

async function expectReadyCardControls(processingPage) {
  const readyCard = processingPage.card("Ready");
  const bulkBar = readyCard.locator(".processing-bulk-bar");
  await expect(processingPage.cardSearchInput("Ready")).toBeVisible();
  await expect(processingPage.cardResultCount("Ready")).toHaveText(/\d+/);
  await expect(bulkBar.getByRole("button", { name: "Delete" })).toBeVisible();
  await expect(bulkBar.getByRole("button", { name: "Delete all" })).toHaveCount(0);
}

test.describe("Processing Pages", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page);
  });

  test("ready cards show search controls, result counts, and delete actions across processing pages", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);
    const readyPages = [
      ["/processing-my-requests", "My Requests"],
      ["/processing-catalog-books", "Catalog"],
      ["/processing-automation", "Automation"],
      ["/processing-failed-requests", "Failed Requests"],
      ["/processing-incomplete-check", "Incomplete Requests"],
    ];

    for (const [path, heading] of readyPages) {
      await processingPage.goto(path, heading);
      await expectReadyCardControls(processingPage);
    }
  });

  test("submission card filters stay isolated and only show the supported fields", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-my-requests", "My Requests");

    await processingPage.openCardFilters("Ready");

    const readyDrawer = processingPage.cardOpenFilterDrawer("Ready");
    await expect(readyDrawer).toBeVisible();
    await expect(processingPage.cardOpenFilterDrawer("Requests")).toHaveCount(0);
    await expect(processingPage.cardOpenFilterDrawer("Processing")).toHaveCount(0);
    await expect(readyDrawer.getByText("Range", { exact: true })).toBeVisible();
    await expect(readyDrawer.getByText("Status", { exact: true })).toHaveCount(0);
    await expect(readyDrawer.getByText("Review", { exact: true })).toHaveCount(0);
    await expect(readyDrawer.getByText("Match", { exact: true })).toHaveCount(0);
    await expect(readyDrawer.getByText("Input", { exact: true })).toHaveCount(0);
    await expect(readyDrawer.locator('option[value="week"]')).toHaveText("Past Week");
    await expect(readyDrawer.locator('option[value="month"]')).toHaveText("Past Month");
    await expect(readyDrawer.locator('option[value="year"]')).toHaveText("Past Year");

    await processingPage.openCardFilters("Requests");

    const requestsDrawer = processingPage.cardOpenFilterDrawer("Requests");
    await expect(requestsDrawer).toBeVisible();
    await expect(processingPage.cardOpenFilterDrawer("Ready")).toHaveCount(0);
    await expect(processingPage.cardOpenFilterDrawer("Processing")).toHaveCount(0);
    await expect(requestsDrawer.getByText("Status", { exact: true })).toBeVisible();
    await expect(requestsDrawer.getByText("Range", { exact: true })).toBeVisible();
    await expect(requestsDrawer.getByText("Review", { exact: true })).toHaveCount(0);
    await expect(requestsDrawer.getByText("Match", { exact: true })).toHaveCount(0);
    await expect(requestsDrawer.getByText("Input", { exact: true })).toHaveCount(0);
    await expect(requestsDrawer.locator('option[value="week"]')).toHaveText("Past Week");
    await expect(requestsDrawer.locator('option[value="month"]')).toHaveText("Past Month");
    await expect(requestsDrawer.locator('option[value="year"]')).toHaveText("Past Year");

    await processingPage.openCardFilters("Requests");
    await expect(processingPage.cardOpenFilterDrawer("Requests")).toHaveCount(0);

    await processingPage.openCardFilters("Processing");

    const processingDrawer = processingPage.cardOpenFilterDrawer("Processing");
    await expect(processingDrawer).toBeVisible();
    await expect(processingDrawer.getByText("Status", { exact: true })).toBeVisible();
    await expect(processingDrawer.getByText("Range", { exact: true })).toBeVisible();
    await expect(processingDrawer.getByText("Step", { exact: true })).toHaveCount(0);
    await expect(processingDrawer.locator('option[value="week"]')).toHaveText("Past Week");
    await expect(processingDrawer.locator('option[value="month"]')).toHaveText("Past Month");
    await expect(processingDrawer.locator('option[value="year"]')).toHaveText("Past Year");
  });

  test("processing header does not show a shared-activity spinner while idle", async ({
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
      processingPage.rowInCard("Requests", seedData.submissions.userPending),
    ).toBeVisible();
    await expect(processingPage.headerSpinner("My Requests")).toHaveCount(0);
    await expect(
      processingPage.pageHeader("My Requests").locator(".panel-header > .loading-spinner"),
    ).toHaveCount(0);
  });

  test("processing header does not show a shared-activity spinner while activity is active", async ({
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
      processingPage.rowInCard("Requests", seedData.submissions.userPending),
    ).toBeVisible();
    await expect(processingPage.headerSpinner("My Requests")).toHaveCount(0);
    await expect(
      processingPage.pageHeader("My Requests").locator(".panel-header > .loading-spinner"),
    ).toHaveCount(0);
    await expect(
      processingPage.pageHeader("My Requests").locator(".processing-page-title .loading-spinner"),
    ).toHaveCount(0);

    await processingPage.goto(
      "/processing-failed-requests",
      "Failed Requests",
    );

    await expect(processingPage.headerSpinner("Failed Requests")).toHaveCount(0);
  });

  test("my requests keeps collapsible cards grouped, shows failed and duplicate counts, and requeues deleted requests with add-again actions", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-my-requests", "My Requests");

    await expect(processingPage.collapsibleStack()).toBeVisible();
    await expect(
      page.locator("section.processing-summary-card .processing-card-count"),
    ).toBeVisible();
    await expect(processingPage.cardCountPill("Deleted")).toHaveCount(0);
    await expect(processingPage.card("Ready")).toHaveClass(
      /processing-full-span-card/,
    );
    await expect(processingPage.card("Failed Requests")).toHaveCount(0);
    await expect(processingPage.card("Deplicate Requests")).toHaveCount(0);
    await expect(summaryValue(processingPage, "My Requests Overview", "Failed")).toHaveText("1");
    await expect(summaryValue(processingPage, "My Requests Overview", "Duplicate")).toHaveText("1");
    await expect
      .poll(async () => {
        const box = await processingPage.card("Ready").boundingBox();
        return box?.height || 0;
      })
      .toBeLessThan(540);

    await processingPage.toggleCard("Deleted");
    await expect(
      processingPage
        .collapsibleStack()
        .locator("section.processing-card")
        .first()
        .getByRole("heading", { name: "Deleted", exact: true }),
    ).toBeVisible();

    const deletedRow = processingPage.rowInCard(
      "Deleted",
      seedData.submissions.userDeleted,
    );

    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.userDeleted,
      "Deleted",
      ["Requests", "Processing", "Ready", "Queued", "Stopped"],
    );
    await expect(deletedRow).toBeVisible();
    await expect(
      deletedRow.getByRole("button", { name: "Add Again to Queue" }),
    ).toBeVisible();
    await expect(
      deletedRow.getByRole("button", { name: "Resume" }),
    ).toHaveCount(0);

    await deletedRow.getByRole("button", { name: "Add Again to Queue" }).click();
    await expect(page.getByText("Request queued.")).toBeVisible();
    await expect(
      processingPage.rowInCard("Deleted", seedData.submissions.userDeleted),
    ).toHaveCount(0);
    await expect(
      processingPage.rowInCard("Ready", seedData.submissions.userDeleted),
    ).toBeVisible();
  });

  test("my requests processing and stopped cards perform live stop and resume actions", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-my-requests", "My Requests");

    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.userProcessing,
      "Processing",
      ["Requests", "Ready", "Queued", "Stopped", "Deleted"],
    );
    await expect(
      processingPage.rowInCard("Processing", seedData.submissions.userProcessing),
    ).toBeVisible();
    await processingPage
      .rowActionButton("Processing", seedData.submissions.userProcessing, "Stop")
      .click();

    await expect(page.getByText("Book creation stopped.")).toBeVisible();

    await processingPage.toggleCard("Stopped");
    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.userStopped,
      "Stopped",
      ["Requests", "Processing", "Ready", "Queued", "Deleted"],
    );
    await expect(
      processingPage.rowInCard("Stopped", seedData.submissions.userProcessing),
    ).toBeVisible();
    await expect(
      processingPage
        .rowInCard("Stopped", seedData.submissions.userStopped)
        .getByText("View error"),
    ).toBeVisible();

    await processingPage
      .rowActionButton("Stopped", seedData.submissions.userStopped, "Resume")
      .click();

    await expect(page.getByText("Request queued.")).toBeVisible();
    await expect(
      processingPage.rowInCard("Stopped", seedData.submissions.userStopped),
    ).toHaveCount(0);
    await expect(
      processingPage.rowInCard("Ready", seedData.submissions.userStopped),
    ).toBeVisible();
  });

  test("catalog books sorting reorders the visible catalog rows through the live page controls", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-catalog-books", "Catalog");
    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.curationQueued,
      "Queued",
      ["Processing", "Ready", "Stopped", "Deleted"],
    );
    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.curationDeleted,
      "Deleted",
      ["Processing", "Ready", "Stopped", "Queued"],
    );
    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.curationStopped,
      "Stopped",
      ["Processing", "Ready", "Queued", "Deleted"],
    );
    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.curationProcessing,
      "Processing",
      ["Ready", "Stopped", "Queued", "Deleted"],
    );
    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.curationReady,
      "Ready",
      ["Processing", "Stopped", "Queued", "Deleted"],
    );

    await expect(
      processingPage.rowInCard("Catalog Books", seedData.catalogEntries.alpha),
    ).toBeVisible();
    await expect(
      processingPage.rowInCard("Catalog Books", seedData.catalogEntries.beta),
    ).toBeVisible();

    const catalogCard = processingPage.card("Catalog Books");
    const sortSelect = catalogCard.getByRole("combobox", { name: "Sort" });
    await sortSelect.selectOption("title_asc");

    await expect(
      sortSelect,
    ).toHaveValue("title_asc");
    await expect(
      processingPage.rowInCard("Catalog Books", seedData.catalogEntries.alpha),
    ).toBeVisible();
    await expect(
      processingPage.rowInCard("Catalog Books", seedData.catalogEntries.beta),
    ).toBeVisible();
  });

  test("automation keeps run history collapsible with the expanded card first and preserves saved settings", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-automation", "Automation");

    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.automationQueued,
      "Queued",
      ["Automation Requests", "Processing", "Ready", "Stopped", "Deleted"],
    );
    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.automationProcessing,
      "Processing",
      ["Automation Requests", "Ready", "Stopped", "Queued", "Deleted"],
    );
    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.automationReady,
      "Ready",
      ["Automation Requests", "Processing", "Stopped", "Queued", "Deleted"],
    );
    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.automationStopped,
      "Stopped",
      ["Automation Requests", "Processing", "Ready", "Queued", "Deleted"],
    );
    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.automationDeleted,
      "Deleted",
      ["Automation Requests", "Processing", "Ready", "Queued", "Stopped"],
    );
    await expect(
      processingPage.rowInCard(
        "Automation Requests",
        seedData.submissions.automationPending,
      ),
    ).toBeVisible();

    await processingPage.toggleCard("Run History");
    await expect(
      processingPage
        .collapsibleStack()
        .locator("section.processing-card")
        .first()
        .getByRole("heading", { name: "Run History", exact: true }),
    ).toBeVisible();
    await expect(
      processingPage.rowInCard(
        "Run History",
        seedData.processing.scheduledRunActiveSummary,
      ),
    ).toBeVisible();

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

  test("failed requests page omits run history and shows failed-job table", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto(
      "/processing-failed-requests",
      "Failed Requests",
    );
    await expect(processingPage.card("Failed Requests")).toBeVisible();
    await expect(processingPage.card("Deplicate Requests")).toHaveCount(0);
    await expect(summaryValue(processingPage, "Failed Requests Overview", "Failed")).toHaveText("1");
    await expect(summaryValue(processingPage, "Failed Requests Overview", "Duplicate")).toHaveText("1");
    await expect(processingPage.card("Run History")).toHaveCount(0);
    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.userFailed,
      "Failed Requests",
      ["Processing", "Ready", "Queued", "Stopped", "Deleted"],
    );
    const failedRow = processingPage.rowInCard(
      "Failed Requests",
      seedData.submissions.userFailed,
    );
    const failedBulkBar = processingPage
      .card("Failed Requests")
      .locator(".processing-bulk-bar");

    await expect(failedRow.getByText("Seeded failure for live-browser coverage.")).toBeVisible();
    await expect(failedBulkBar.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(failedBulkBar.getByRole("button", { name: "Retry all" })).toHaveCount(0);
    await expect(failedBulkBar.getByRole("button", { name: "Delete" })).toBeVisible();
    await expect(failedBulkBar.getByRole("button", { name: "Delete all" })).toHaveCount(0);
    await expect(
      processingPage
        .card("Failed Requests")
        .locator(".processing-requeue-error-panel"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Failed job logs" }),
    ).toHaveCount(0);
    await expect(processingPage.tableRows("Failed Requests")).toHaveCount(1);

    await processingPage.searchCard(
      "Failed Requests",
      "Seeded failure for live-browser coverage.",
    );
    await expect(processingPage.tableRows("Failed Requests")).toHaveCount(1);
    await expect(
      processingPage.rowInCard(
        "Failed Requests",
        seedData.books.incomplete.title,
      ),
    ).toHaveCount(0);

    await failedRow.locator('input[type="checkbox"]').check();
    await failedBulkBar.getByRole("button", { name: "Delete (1)" }).click();
    await processingPage.confirmDialog();
    await expect(summaryValue(processingPage, "Failed Requests Overview", "Failed")).toHaveText("0");
  });

  test("deplicate requests page omits run history and resolves duplicate rows through live actions", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto(
      "/processing-duplicate-requests",
      "Deplicate Requests",
    );

    await expect(processingPage.card("Deplicate Requests")).toBeVisible();
    await expect(summaryValue(processingPage, "Deplicate Requests Overview", "Duplicate")).toHaveText("1");
    await expect(processingPage.card("Failed Requests")).toHaveCount(0);
    await expect(processingPage.card("Run History")).toHaveCount(0);

    const duplicateRow = processingPage.rowInCard(
      "Deplicate Requests",
      seedData.submissions.duplicateReview,
    );

    await expectRowOnlyInCard(
      processingPage,
      seedData.submissions.duplicateReview,
      "Deplicate Requests",
      ["Processing", "Ready", "Queued", "Stopped", "Deleted"],
    );
    await expect(duplicateRow).toBeVisible();
    await duplicateRow.getByRole("button", { name: "New Book" }).click();

    await expect(page.getByText("New book queued.")).toBeVisible();
    await expect(summaryValue(processingPage, "Deplicate Requests Overview", "Duplicate")).toHaveText("0");
    await expect(
      processingPage.rowInCard(
        "Deplicate Requests",
        seedData.submissions.duplicateReview,
      ),
    ).toHaveCount(0);
    await expectRowInAnyCard(processingPage, seedData.submissions.duplicateReview, [
      "Queued",
      "Processing",
      "Ready",
    ]);
  });

  test("incomplete requests keeps run history collapsible and reprocesses the selected incomplete book", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto(
      "/processing-incomplete-check",
      "Incomplete Requests",
    );
    await processingPage.toggleCard("Run History");
    await expect(
      processingPage
        .collapsibleStack()
        .locator("section.processing-card")
        .first()
        .getByRole("heading", { name: "Run History", exact: true }),
    ).toBeVisible();
    await expect(
      processingPage.rowInCard(
        "Run History",
        seedData.processing.scheduledRunFailedSummary,
      ),
    ).toBeVisible();
    await expect(processingPage.card("Ready")).not.toHaveClass(
      /processing-full-span-card/,
    );

    const failedRunRow = processingPage.rowInCard(
      "Run History",
      seedData.processing.scheduledRunFailedSummary,
    );
    const incompleteCard = processingPage.card("Incomplete Catalog");
    const incompleteRow = incompleteCard
      .locator("tbody tr", {
        hasText: seedData.books.incomplete.title,
      })
      .first();

    await expect(failedRunRow.getByText("View error")).toBeVisible();
    await expect(incompleteRow).toBeVisible();
    await processingPage.selectIncompleteBook(seedData.books.incomplete.title);
    await processingPage.reprocessSelectedIncomplete();

    await expect(page.getByText("Reprocess queued.")).toBeVisible();
    await expect(incompleteRow).toBeVisible();
  });
});
