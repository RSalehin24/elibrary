import { expect, test } from "./support/playwright";
import { loginAsSuperAdmin } from "./support/liveApp";
import { ProcessingPageModel } from "./pages/processingPage";
import { seedData } from "./support/seedData";

async function expectRowInAnyCard(processingPage, rowPattern, cardTitles) {
  for (const title of cardTitles) {
    await processingPage.expandCard(title);
  }

  await expect
    .poll(
      async () => {
        for (const title of cardTitles) {
          if (await processingPage.rowInCard(title, rowPattern).count()) {
            return title;
          }
        }
        return "";
      },
      { timeout: 30_000 },
    )
    .not.toBe("");
}

async function expectRowMissingOrCardAbsent(
  processingPage,
  rowPattern,
  cardTitle,
) {
  await expect
    .poll(
      async () => {
        const card = processingPage.card(cardTitle);
        if (!(await card.count())) {
          return "card-absent";
        }

        const expandButton = card
          .getByRole("button", { name: "Expand" })
          .first();
        if (await expandButton.count()) {
          try {
            await expandButton.click({ timeout: 1_000 });
          } catch {
            return "transitioning";
          }
        }

        const rowCount = await processingPage
          .rowInCard(cardTitle, rowPattern)
          .count();
        return rowCount ? "present" : "missing";
      },
      { timeout: 15_000 },
    )
    .not.toBe("present");
}

test.describe("processing live app", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page);
  });

  test("my requests resumes stopped work and requeues deleted requests", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-my-requests", "My Requests");

    await processingPage.expandCard("Stopped");
    await expect(
      processingPage.rowInCard("Stopped", seedData.submissions.userStopped),
    ).toBeVisible();
    await processingPage
      .rowActionButton("Stopped", seedData.submissions.userStopped, "Resume")
      .click();
    await expect(page.getByText("Book creation started.")).toBeVisible();
    await expect(
      processingPage.rowInCard("Stopped", seedData.submissions.userStopped),
    ).toHaveCount(0);

    await expectRowInAnyCard(processingPage, seedData.submissions.userStopped, [
      "Queued",
      "Processing",
      "Ready",
    ]);

    await processingPage.expandCard("Deleted");
    await expect(
      processingPage.rowInCard("Deleted", seedData.submissions.userDeleted),
    ).toBeVisible();
    await processingPage
      .rowActionButton(
        "Deleted",
        seedData.submissions.userDeleted,
        "Add Again to Queue",
      )
      .click();
    await expect(page.getByText("Request queued.")).toBeVisible();
    await expect(
      processingPage.rowInCard("Deleted", seedData.submissions.userDeleted),
    ).toHaveCount(0);
    await expectRowInAnyCard(processingPage, seedData.submissions.userDeleted, [
      "Queued",
      "Processing",
      "Ready",
    ]);
  });

  test("failed and duplicate pages delete failed rows and resolve duplicates through the real app", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto(
      "/processing-failed-requests",
      "Failed Requests",
    );
    const failedRow = processingPage.rowInCard(
      "Failed Requests",
      seedData.submissions.userFailed,
    );
    await expect(failedRow).toBeVisible();
    await failedRow.locator('input[type="checkbox"]').check();
    await processingPage
      .card("Failed Requests")
      .locator(".processing-bulk-bar")
      .getByRole("button", { name: "Delete (1)" })
      .click();
    await processingPage.confirmDialog();
    await expect(page.getByText("1 deleted")).toBeVisible();
    await expect(failedRow).toHaveCount(0);

    await processingPage.goto(
      "/processing-duplicate-requests",
      "Deplicate Requests",
    );
    await processingPage.searchCard(
      "Deplicate Requests",
      seedData.submissions.duplicateReview,
    );
    const duplicateRow = processingPage.rowInCard(
      "Deplicate Requests",
      seedData.submissions.duplicateReview,
    );
    await expect(duplicateRow).toBeVisible();
    await duplicateRow.getByRole("button", { name: "New Book" }).click();
    await expect(page.getByText("New book queued.")).toBeVisible();
    await expect(duplicateRow).toHaveCount(0);
    await processingPage.searchCard(
      "Ready",
      seedData.submissions.duplicateReview,
    );

    await expectRowInAnyCard(
      processingPage,
      seedData.submissions.duplicateReview,
      ["Queued", "Processing", "Ready"],
    );
  });

  test("catalog page live stop action removes the targeted processing row", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-catalog-books", "Catalog");
    await processingPage.searchCard(
      "Processing",
      seedData.submissions.curationProcessing,
    );

    await processingPage.expandCard("Processing");
    await expect(
      processingPage.rowInCard("Processing", seedData.submissions.curationProcessing),
    ).toBeVisible({ timeout: 15_000 });
    await processingPage
      .rowActionButton(
        "Processing",
        seedData.submissions.curationProcessing,
        "Stop",
      )
      .click();
    await expect(page.getByText("Book creation stopped.")).toBeVisible();
    await expect(
      processingPage.rowInCard("Processing", seedData.submissions.curationProcessing),
    ).toHaveCount(0);

    await processingPage.goto("/processing-catalog-books", "Catalog");
    await processingPage.expandCard("Stopped");
    await processingPage.searchCard(
      "Stopped",
      seedData.submissions.curationProcessing,
    );
    await expect(
      processingPage.rowInCard("Stopped", seedData.submissions.curationProcessing),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("catalog page live resume action requeues a stopped curation request", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-catalog-books", "Catalog");
    await processingPage.expandCard("Stopped");
    await processingPage.searchCard(
      "Stopped",
      seedData.submissions.curationStopped,
    );
    await expect(
      processingPage.rowInCard("Stopped", seedData.submissions.curationStopped),
    ).toBeVisible({ timeout: 15_000 });
    await processingPage
      .rowActionButton("Stopped", seedData.submissions.curationStopped, "Resume")
      .click();
    await expect(page.getByText("Book creation started.")).toBeVisible();
    await expect(
      processingPage.rowInCard("Stopped", seedData.submissions.curationStopped),
    ).toHaveCount(0);

    await processingPage.goto("/processing-catalog-books", "Catalog");
    await processingPage.expandCard("Stopped");
    await processingPage.searchCard(
      "Stopped",
      seedData.submissions.curationStopped,
    );
    await expect(
      processingPage.rowInCard("Stopped", seedData.submissions.curationStopped),
    ).toHaveCount(0);
  });

  test("catalog page live requeue action restores a deleted curation request", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-catalog-books", "Catalog");
    await processingPage.expandCard("Deleted");
    await processingPage.searchCard(
      "Deleted",
      seedData.submissions.curationDeleted,
    );
    await expect(
      processingPage.rowInCard("Deleted", seedData.submissions.curationDeleted),
    ).toBeVisible();
    await processingPage
      .rowActionButton(
        "Deleted",
        seedData.submissions.curationDeleted,
        "Add Again to Queue",
      )
      .click();
    await expect(page.getByText("Request queued.")).toBeVisible();
    await expect(
      processingPage.rowInCard("Deleted", seedData.submissions.curationDeleted),
    ).toHaveCount(0);

    await processingPage.goto("/processing-catalog-books", "Catalog");
    await expectRowMissingOrCardAbsent(
      processingPage,
      seedData.submissions.curationDeleted,
      "Deleted",
    );
  });

  test("catalog sync can be stopped and started again against the live app", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-catalog-books", "Catalog");

    await expect(processingPage.catalogSyncButton()).toHaveAttribute(
      "aria-label",
      "Sync catalog",
    );
    await expect(processingPage.catalogSyncStatus()).toContainText(
      "Catalog sync idle",
    );

    await processingPage.catalogSyncButton().click();
    await expect
      .poll(async () =>
        processingPage.catalogSyncButton().getAttribute("aria-label"),
      )
      .toBe("Stop catalog sync");
    await expect(processingPage.catalogSyncStatus()).toContainText(
      "Syncing catalog",
    );

    await processingPage.catalogSyncButton().click();
    await expect
      .poll(async () =>
        processingPage.catalogSyncButton().getAttribute("aria-label"),
      )
      .toBe("Sync catalog");
    await expect(processingPage.catalogSyncStatus()).toContainText(
      "Catalog sync idle",
    );

    await processingPage.catalogSyncButton().click();
    await expect
      .poll(async () =>
        processingPage.catalogSyncButton().getAttribute("aria-label"),
      )
      .toBe("Stop catalog sync");

    await processingPage.catalogSyncButton().click();
    await expect
      .poll(async () =>
        processingPage.catalogSyncButton().getAttribute("aria-label"),
      )
      .toBe("Sync catalog");
  });

  test("automation page saves settings against the live app", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-automation", "Automation");
    await expect(processingPage.card("Automation")).toBeVisible();

    await processingPage.saveAutomation({
      enabled: true,
      time: "03:15",
      frequency: "weekly",
      mode: "all",
      pages: 12,
    });

    const automationCard = processingPage.card("Automation");
    await expect(
      automationCard.locator('.processing-switch input[type="checkbox"]'),
    ).toBeChecked();
    await expect(automationCard.locator('input[type="time"]')).toHaveValue(
      "03:15",
    );
    await expect(automationCard.locator("select").first()).toHaveValue(
      "weekly",
    );
    await expect(automationCard.locator("select").nth(1)).toHaveValue("all");
    await expect(automationCard.locator('input[type="number"]')).toHaveValue(
      "12",
    );

    await processingPage.saveAutomation({
      enabled: false,
      time: "02:00",
      frequency: "daily",
      mode: "pending",
      pages: 80,
    });
  });

  test("incomplete page saves automation setup and reprocesses an incomplete book against the live app", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto(
      "/processing-incomplete-check",
      "Incomplete Requests",
    );
    await expect(processingPage.card("Automation Setup")).toBeVisible();
    await expect(processingPage.card("Incomplete Catalog")).toBeVisible();

    await processingPage.saveAutomation({
      title: "Automation Setup",
      enabled: true,
      time: "03:30",
      frequency: "weekly",
    });

    const automationCard = processingPage.card("Automation Setup");
    await expect(
      automationCard.locator('.processing-switch input[type="checkbox"]'),
    ).toBeChecked();
    await expect(automationCard.locator('input[type="time"]')).toHaveValue(
      "03:30",
    );
    await expect(automationCard.locator("select").first()).toHaveValue(
      "weekly",
    );

    await processingPage.saveAutomation({
      title: "Automation Setup",
      enabled: false,
      time: "02:00",
      frequency: "daily",
    });
    await expect(page.locator(".toast.toast-success")).toHaveCount(0, {
      timeout: 10_000,
    });

    await expect(
      processingPage.rowInCard("Incomplete Catalog", seedData.books.incomplete.title),
    ).toBeVisible();
    await processingPage.selectIncompleteBook(seedData.books.incomplete.title);
    await processingPage.reprocessSelectedIncomplete();
    await expect(page.locator(".toast.toast-success").first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
