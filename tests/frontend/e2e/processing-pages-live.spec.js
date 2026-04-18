import { expect, test } from "./support/playwright";
import { getSuperAdminCredentials } from "./support/liveEnv";

function liveSmokeData() {
  const suffix = `${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
  const now = new Date().toISOString();
  return {
    catalog: {
      id: `live-catalog-record-${suffix}`,
      name: `Live Smoke Catalog Book ${suffix}`,
      url: `https://example.test/live-smoke-${suffix}`,
      category: "Smoke",
      writer: "Live Writer",
      translator: null,
      composer: null,
      publisher: "Live Press",
      updatedAt: now,
      bookCreationState: "not_created",
    },
    paused: {
      id: `live-paused-record-${suffix}`,
      name: `Live Smoke Paused Book ${suffix}`,
      url: `https://example.test/live-paused-${suffix}`,
      category: "Smoke",
      writer: "Live Writer",
      translator: null,
      composer: null,
      publisher: "Live Press",
      updatedAt: now,
      bookCreationState: "not_created",
    },
    manualA: {
      id: `live-manual-a-${suffix}`,
      name: `Live Manual Sync A ${suffix}`,
      url: `https://example.test/live-manual-a-${suffix}`,
      category: "Smoke",
      writer: "Manual Writer",
      translator: null,
      composer: null,
      publisher: "Live Press",
      updatedAt: now,
      bookCreationState: "not_created",
    },
    manualB: {
      id: `live-manual-b-${suffix}`,
      name: `Live Manual Sync B ${suffix}`,
      url: `https://example.test/live-manual-b-${suffix}`,
      category: "Smoke",
      writer: "Manual Writer",
      translator: null,
      composer: null,
      publisher: "Live Press",
      updatedAt: now,
      bookCreationState: "not_created",
    },
    automationA: {
      id: `live-automation-a-${suffix}`,
      name: `Live Automation Sync A ${suffix}`,
      url: `https://example.test/live-automation-a-${suffix}`,
      category: "Smoke",
      writer: "Automation Writer",
      translator: null,
      composer: null,
      publisher: "Live Press",
      updatedAt: now,
      bookCreationState: "not_created",
    },
    automationB: {
      id: `live-automation-b-${suffix}`,
      name: `Live Automation Sync B ${suffix}`,
      url: `https://example.test/live-automation-b-${suffix}`,
      category: "Smoke",
      writer: "Automation Writer",
      translator: null,
      composer: null,
      publisher: "Live Press",
      updatedAt: now,
      bookCreationState: "not_created",
    },
    incomplete: {
      id: `live-incomplete-${suffix}`,
      name: `Live Incomplete Catalog Book ${suffix}`,
      url: `https://example.test/live-incomplete-${suffix}`,
      category: "অসম্পূর্ণ বই",
      writer: "Incomplete Writer",
      translator: null,
      composer: null,
      publisher: "Live Press",
      updatedAt: now,
      bookCreationState: "not_created",
      wasIncomplete: true,
      willResolveToCategory: "Novel",
    },
  };
}

async function processingPost(page, path, body = {}) {
  const result = await page.evaluate(
    async ({ requestPath, requestBody }) => {
      await fetch("/api/csrf/", { credentials: "include" });
      const csrfMatch = document.cookie.match(/(?:^|; )csrftoken=([^;]+)/);
      const response = await fetch(`/api${requestPath}`, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(csrfMatch ? { "X-CSRFToken": decodeURIComponent(csrfMatch[1]) } : {}),
        },
        body: JSON.stringify(requestBody),
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        text,
      };
    },
    { requestPath: path, requestBody: body },
  );

  if (!result.ok) {
    throw new Error(`Processing API ${path} failed with ${result.status}: ${result.text}`);
  }
  return result.text ? JSON.parse(result.text) : null;
}

async function loginSuperAdminThroughApi(page) {
  const credentials = getSuperAdminCredentials();
  await page.goto("/");
  const result = await page.evaluate(async ({ email, password }) => {
    await fetch("/api/csrf/", { credentials: "include" });
    const csrfMatch = document.cookie.match(/(?:^|; )csrftoken=([^;]+)/);
    const response = await fetch("/api/auth/login/", {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(csrfMatch ? { "X-CSRFToken": decodeURIComponent(csrfMatch[1]) } : {}),
      },
      body: JSON.stringify({ email, password }),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
    };
  }, credentials);

  if (!result.ok) {
    throw new Error(`API login failed with ${result.status}: ${result.text}`);
  }
}

async function seedLiveProcessingState(page, smoke) {
  await processingPost(page, "/processing/sync/start/", {
    remotePages: [[smoke.catalog, smoke.paused], []],
  });
  await processingPost(page, "/processing/sync/advance/");
  await processingPost(page, "/processing/records/create-requests/", {
    ids: [smoke.paused.id],
  });
  await processingPost(page, "/processing/requests/action/", {
    ids: [`request-${smoke.paused.id}`],
    action: "pause",
  });
}

async function seedIdleRemotePages(page, remotePages) {
  await processingPost(page, "/processing/sync/start/", { remotePages });
  await processingPost(page, "/processing/sync/stop/");
}

function repeatedAutomationPages(smoke, count = 12) {
  return [
    ...Array.from({ length: count }, (_, index) => [
      index % 2 === 0 ? smoke.automationA : smoke.automationB,
    ]),
    [],
  ];
}

test.describe("processing replacement live smoke", () => {
  test.beforeEach(async ({ page }) => {
    await loginSuperAdminThroughApi(page);
  });

  test("new processing routes render and share backend state", async ({ page }) => {
    const smoke = liveSmokeData();
    await seedLiveProcessingState(page, smoke);

    await page.goto("/catalog");
    await expect(page.getByRole("heading", { name: "Catalog", exact: true })).toBeVisible();
    await expect(page.getByTestId(`catalog-records-row-${smoke.catalog.id}`)).toBeVisible();

    await page.getByTestId(`catalog-records-select-${smoke.catalog.id}`).check();
    await page.getByTestId("catalog-records-create-btn").click();
    await expect(page.getByTestId("catalog-records-loader")).toBeVisible();
    await expect(page.getByTestId("catalog-records-loader")).toHaveCount(0);

    await page.goto("/create");
    await expect(page.getByRole("heading", { name: "Create", exact: true })).toBeVisible();
    const createdRequestRow = page
      .getByTestId(`create-requests-row-request-${smoke.catalog.id}`)
      .or(page.getByTestId(`create-queue-row-request-${smoke.catalog.id}`))
      .or(page.getByTestId(`create-processing-row-request-${smoke.catalog.id}`))
      .or(page.getByTestId(`create-created-row-request-${smoke.catalog.id}`));
    await expect(createdRequestRow.first()).toBeVisible();

    await page.goto("/on-hold");
    await expect(page.getByRole("heading", { name: "On Hold", exact: true })).toBeVisible();
    await expect(
      page.getByTestId(`on-hold-paused-row-request-${smoke.paused.id}`),
    ).toBeVisible();

    await page.goto("/incomplete");
    await expect(
      page.getByRole("heading", { name: "Incomplete", exact: true, level: 1 }),
    ).toBeVisible();
  });

  test("manual and automated catalog sync use real backend state and gate the controls", async ({
    page,
  }) => {
    const smoke = liveSmokeData();

    await seedIdleRemotePages(page, [[smoke.manualA], [smoke.manualB], []]);
    await page.goto("/catalog");

    await page.getByTestId("catalog-sync-start-btn").click();
    await expect(page.getByTestId("catalog-sync-pause-btn")).toHaveAttribute(
      "data-state",
      "syncing",
    );
    await expect(page.getByTestId(`catalog-records-row-${smoke.manualA.id}`)).toBeVisible();
    await expect(page.getByTestId(`catalog-records-row-${smoke.manualB.id}`)).toBeVisible();
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeVisible();

    await seedIdleRemotePages(page, repeatedAutomationPages(smoke));
    await page.reload();

    await page.getByTestId("catalog-automation-run-btn").click();
    await expect(page.getByTestId("catalog-automation-run-btn")).toHaveAttribute(
      "data-state",
      "syncing",
    );
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeDisabled();

    await page.getByTestId("catalog-automation-run-btn").click();
    await expect(page.getByTestId("catalog-automation-run-btn")).toHaveAttribute(
      "data-state",
      /pausing|paused/,
    );
    await expect(page.getByTestId("catalog-automation-run-btn")).toHaveAttribute(
      "data-state",
      "paused",
    );

    await page.getByTestId("catalog-automation-run-btn").click();
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeEnabled();
    await expect(page.getByTestId("catalog-automation-status")).toContainText(
      "stopped",
    );

    await seedIdleRemotePages(page, repeatedAutomationPages(smoke));
    await page.reload();
    await page.getByTestId("catalog-automation-run-btn").click();
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeDisabled();
    await expect(page.getByTestId(`catalog-records-row-${smoke.automationA.id}`)).toBeVisible();
    await expect(page.getByTestId(`catalog-records-row-${smoke.automationB.id}`)).toBeVisible();
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeEnabled();

    await page.goto("/create");
    await expect(
      page
        .getByTestId(`create-requests-row-request-${smoke.automationA.id}`)
        .or(page.getByTestId(`create-queue-row-request-${smoke.automationA.id}`))
        .or(page.getByTestId(`create-processing-row-request-${smoke.automationA.id}`))
        .or(page.getByTestId(`create-created-row-request-${smoke.automationA.id}`))
        .first(),
    ).toBeVisible();
  });

  test("incomplete automation resolves real incomplete-category records", async ({
    page,
  }) => {
    const smoke = liveSmokeData();

    await processingPost(page, "/processing/sync/start/", {
      remotePages: [[smoke.incomplete], []],
    });
    await processingPost(page, "/processing/sync/advance/");

    await page.goto("/incomplete");
    await expect(
      page.getByRole("heading", { name: "Incomplete", exact: true, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByTestId(`incomplete-records-row-${smoke.incomplete.id}`),
    ).toBeVisible();

    await page.getByTestId("incomplete-automation-run-btn").click();
    await expect(page.getByTestId("incomplete-automation-run-btn")).toHaveAttribute(
      "data-state",
      "syncing",
    );
    await expect(
      page.getByTestId(`incomplete-completed-row-request-${smoke.incomplete.id}`),
    ).toBeVisible();
  });

  test("legacy processing URLs redirect to replacement pages", async ({ page }) => {
    await page.goto("/processing-catalog-books");
    await expect(page).toHaveURL(/\/catalog$/);

    await page.goto("/processing-my-requests");
    await expect(page).toHaveURL(/\/create$/);

    await page.goto("/processing-failed-requests");
    await expect(page).toHaveURL(/\/on-hold$/);

    await page.goto("/processing-incomplete-check");
    await expect(page).toHaveURL(/\/incomplete$/);
  });
});
