import { expect, test } from "playwright/test";
import { ProcessingPageModel } from "./pages/processingPage";
import {
  installApiGuard,
  mockAuthenticatedSession,
} from "./support/appMocks";
import { mockProcessingApi } from "./support/processingApi";

test.describe("Processing Pages", () => {
  test("my requests submission search refreshes only the request list", async ({
    page,
  }) => {
    await installApiGuard(page);
    await mockAuthenticatedSession(page, {
      is_staff: false,
      is_superuser: false,
      capabilities: ["metadata:edit"],
    });
    const state = await mockProcessingApi(page);
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-my-requests", "My Requests");

    const requestsCard = processingPage.card("Requests");
    await expect(
      requestsCard.getByRole("row", { name: /Alpha Book/ }),
    ).toBeVisible();
    await expect(
      requestsCard.getByRole("row", { name: /Beta Book/ }),
    ).toBeVisible();

    await processingPage.searchCard("Requests", "Alpha");

    await expect(
      requestsCard.getByRole("row", { name: /Alpha Book/ }),
    ).toBeVisible();
    await expect(
      requestsCard.getByRole("row", { name: /Beta Book/ }),
    ).toHaveCount(0);
    await expect.poll(() => state.submissionQueries.at(-1)).toBe("Alpha");
  });

  test("catalog books search refreshes the catalog table without losing the visible result", async ({
    page,
  }) => {
    await installApiGuard(page);
    await mockAuthenticatedSession(page, {
      capabilities: ["metadata:edit", "processing:manage"],
    });
    const state = await mockProcessingApi(page);
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-catalog-books", "Catalog Books");

    const catalogCard = processingPage.card("Catalog Books");
    await expect(
      catalogCard.getByRole("row", { name: /Alpha Catalog Book/ }),
    ).toBeVisible();
    await expect(
      catalogCard.getByRole("row", { name: /Beta Catalog Book/ }),
    ).toBeVisible();

    await processingPage.searchCard("Catalog Books", "Alpha");

    await expect(
      catalogCard.getByRole("row", { name: /Alpha Catalog Book/ }),
    ).toBeVisible();
    await expect(
      catalogCard.getByRole("row", { name: /Beta Catalog Book/ }),
    ).toHaveCount(0);
    await expect.poll(() => state.catalogQueries.at(-1)).toBe("Alpha");
  });

  test("automation settings save keeps the chosen schedule in the form after the refresh completes", async ({
    page,
  }) => {
    await installApiGuard(page);
    await mockAuthenticatedSession(page, {
      capabilities: ["metadata:edit", "processing:manage"],
    });
    const state = await mockProcessingApi(page);
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto("/processing-automation", "Automation");

    await processingPage.saveAutomation({
      enabled: true,
      time: "04:30",
      frequency: "weekly",
      mode: "all",
      pages: 12,
    });

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
    await expect.poll(() => state.automationUpdateCalls.length).toBe(1);
    await expect(state.automationUpdateCalls[0]).toEqual({
      enabled: true,
      daily_run_time: "04:30",
      frequency: "weekly",
      mode: "all",
      refresh_max_pages: 12,
    });
  });

  test("reprocessing selected incomplete books clears only the queued rows from the browser view", async ({
    page,
  }) => {
    await installApiGuard(page);
    await mockAuthenticatedSession(page, {
      capabilities: ["metadata:edit", "processing:manage"],
    });
    const state = await mockProcessingApi(page);
    const processingPage = new ProcessingPageModel(page);

    await processingPage.goto(
      "/processing-incomplete-check",
      "Incomplete Automation",
    );

    const incompleteCard = processingPage.card("Incomplete Catalog");
    await expect(
      incompleteCard.getByRole("row", { name: /Missing Category Book/ }),
    ).toBeVisible();
    await expect(
      incompleteCard.getByRole("row", { name: /Queued Category Book/ }),
    ).toBeVisible();

    await processingPage.selectIncompleteBook("Missing Category Book");
    await processingPage.reprocessSelectedIncomplete();

    await expect(
      incompleteCard.getByRole("row", { name: /Missing Category Book/ }),
    ).toHaveCount(0);
    await expect(
      incompleteCard.getByRole("row", { name: /Queued Category Book/ }),
    ).toBeVisible();
    await expect.poll(() => state.incompleteCreateCalls.length).toBe(1);
    await expect(state.incompleteCreateCalls[0]).toEqual(["book-1"]);
  });
});
