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
    await expect(page.getByRole("heading", { name: "Incomplete", exact: true })).toBeVisible();
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
