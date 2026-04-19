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
      const separator = requestPath.includes("?") ? "&" : "?";
      const response = await fetch(
        `/api${requestPath}${separator}includeLists=0`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(csrfMatch
              ? { "X-CSRFToken": decodeURIComponent(csrfMatch[1]) }
              : {}),
          },
          body: JSON.stringify(requestBody),
        },
      );
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
    throw new Error(
      `Processing API ${path} failed with ${result.status}: ${result.text}`,
    );
  }
  return result.text ? JSON.parse(result.text) : null;
}

async function processingGet(page, path) {
  const result = await page.evaluate(
    async ({ requestPath }) => {
      const response = await fetch(`/api${requestPath}`, {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json",
        },
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        text,
      };
    },
    { requestPath: path },
  );

  if (!result.ok) {
    throw new Error(
      `Processing API ${path} failed with ${result.status}: ${result.text}`,
    );
  }
  return result.text ? JSON.parse(result.text) : null;
}

async function processingSummary(page) {
  return processingGet(page, "/processing/state/?includeLists=0");
}

async function processingTable(page, card, params = {}) {
  const search = new URLSearchParams({ card });
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  });
  return processingGet(page, `/processing/table/?${search.toString()}`);
}

async function waitForProcessingSummary(
  page,
  predicate,
  {
    attempts = 40,
    delayMs = 250,
    description = "processing summary condition",
  } = {},
) {
  let lastPayload = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastPayload = await processingSummary(page);
    if (predicate(lastPayload)) {
      return lastPayload;
    }
    await page.waitForTimeout(delayMs);
  }

  throw new Error(
    `Timed out waiting for ${description}. Last sync state: ${JSON.stringify(
      lastPayload?.sync || null,
    )}`,
  );
}

async function findTableRowLocation(page, cards, query, rowPredicate) {
  for (const card of cards) {
    const payload = await processingTable(page, card, { q: query, limit: 60 });
    const row = payload.rows.find(rowPredicate);
    if (row) {
      return { card, row };
    }
  }
  return null;
}

async function waitForTableRowLocation(
  page,
  cards,
  query,
  rowPredicate,
  { attempts = 30, delayMs = 250 } = {},
) {
  let location = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    location = await findTableRowLocation(page, cards, query, rowPredicate);
    if (location) {
      return location;
    }
    await page.waitForTimeout(delayMs);
  }

  throw new Error(
    `Timed out waiting for a table row matching "${query}" in ${cards.join(", ")}.`,
  );
}

async function waitForCreateRequestLocation(
  page,
  query,
  recordId,
  options = {},
) {
  return waitForTableRowLocation(
    page,
    [
      "create-requests",
      "create-queue",
      "create-processing",
      "create-created",
      "on-hold-paused",
      "on-hold-failed",
      "on-hold-duplicate",
      "on-hold-deleted",
    ],
    query,
    (item) => item.recordId === recordId,
    options,
  );
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
        ...(csrfMatch
          ? { "X-CSRFToken": decodeURIComponent(csrfMatch[1]) }
          : {}),
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

  test("new processing routes render and share backend state", async ({
    page,
  }) => {
    const smoke = liveSmokeData();
    await seedLiveProcessingState(page, smoke);

    await page.goto("/catalog");
    await expect(
      page.getByRole("heading", { name: "Catalog", exact: true }),
    ).toBeVisible();
    await page.getByTestId("catalog-records-search").fill(smoke.catalog.name);
    await expect(
      page.getByTestId(`catalog-records-row-${smoke.catalog.id}`),
    ).toBeVisible();

    await processingPost(page, "/processing/records/create-requests/", {
      ids: [smoke.catalog.id],
    });

    const location = await waitForCreateRequestLocation(
      page,
      smoke.catalog.name,
      smoke.catalog.id,
    );

    await page.goto("/create");
    await expect(
      page.getByRole("heading", { name: "Create", exact: true }),
    ).toBeVisible();
    if (location.card.startsWith("create-")) {
      await page
        .getByTestId(`${location.card}-search`)
        .fill(smoke.catalog.name);
      await expect(
        page.getByTestId(`${location.card}-row-${location.row.id}`),
      ).toBeVisible();
    } else {
      await page.goto("/on-hold");
      await expect(
        page.getByRole("heading", { name: "On Hold", exact: true }),
      ).toBeVisible();
      await page
        .getByTestId(`${location.card}-search`)
        .fill(smoke.catalog.name);
      await expect(
        page.getByTestId(`${location.card}-row-${location.row.id}`),
      ).toBeVisible();
    }

    await page.goto("/on-hold");
    await expect(
      page.getByRole("heading", { name: "On Hold", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId(`on-hold-paused-row-request-${smoke.paused.id}`),
    ).toBeVisible();

    await page.goto("/incomplete");
    await expect(
      page.getByRole("heading", { name: "Incomplete", exact: true, level: 1 }),
    ).toBeVisible();
  });

  test("real catalog request creation is discoverable through processing tables", async ({
    page,
  }) => {
    const smoke = liveSmokeData();

    await processingPost(page, "/processing/sync/start/", {
      remotePages: [[smoke.catalog], []],
    });
    await processingPost(page, "/processing/sync/advance/");

    await page.goto("/catalog");
    await page.getByTestId("catalog-records-search").fill(smoke.catalog.name);
    await processingPost(page, "/processing/records/create-requests/", {
      ids: [smoke.catalog.id],
    });
    const location = await waitForCreateRequestLocation(
      page,
      smoke.catalog.name,
      smoke.catalog.id,
    );

    if (location.card.startsWith("create-")) {
      await page.goto("/create");
      await page
        .getByTestId(`${location.card}-search`)
        .fill(smoke.catalog.name);
      await expect(
        page.getByTestId(`${location.card}-row-${location.row.id}`),
      ).toBeVisible();
    } else {
      await page.goto("/on-hold");
      await page
        .getByTestId(`${location.card}-search`)
        .fill(smoke.catalog.name);
      await expect(
        page.getByTestId(`${location.card}-row-${location.row.id}`),
      ).toBeVisible();
    }
  });

  test("queued create requests leave the queue on the real processing worker", async ({
    page,
  }) => {
    const smoke = liveSmokeData();

    await processingPost(page, "/processing/sync/start/", {
      remotePages: [[smoke.catalog], []],
    });
    await processingPost(page, "/processing/sync/advance/");
    await processingPost(page, "/processing/records/create-requests/", {
      ids: [smoke.catalog.id],
    });

    const location = await waitForTableRowLocation(
      page,
      [
        "create-processing",
        "create-created",
        "on-hold-failed",
        "on-hold-duplicate",
        "on-hold-deleted",
      ],
      smoke.catalog.name,
      (item) => item.recordId === smoke.catalog.id,
      { attempts: 60, delayMs: 500 },
    );

    expect(location.row.recordId).toBe(smoke.catalog.id);
  });

  test("manual catalog sync uses real backend state", async ({ page }) => {
    const smoke = liveSmokeData();

    await seedIdleRemotePages(page, [[smoke.manualA], [smoke.manualB], []]);
    await page.goto("/catalog");
    await page.getByTestId("catalog-records-search").fill("Live Manual Sync");

    await processingPost(page, "/processing/sync/start/", {
      remotePages: [[smoke.manualA], [smoke.manualB], []],
    });
    await processingPost(page, "/processing/sync/advance/");
    await processingPost(page, "/processing/sync/advance/");
    await page.reload();
    await page.getByTestId("catalog-records-search").fill("Live Manual Sync");
    await expect(
      page.getByTestId(`catalog-records-row-${smoke.manualA.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`catalog-records-row-${smoke.manualB.id}`),
    ).toBeVisible();
  });

  test("manual sync pause survives non-processing navigation with the real backend", async ({
    page,
  }) => {
    const smoke = liveSmokeData();
    const remotePages = [
      ...Array.from({ length: 12 }, (_, index) => [
        {
          ...smoke.manualA,
          id: `${smoke.manualA.id}-${index + 1}`,
          name: `${smoke.manualA.name} ${index + 1}`,
          url: `${smoke.manualA.url}-${index + 1}`,
        },
      ]),
      [],
    ];

    await seedIdleRemotePages(page, remotePages);

    await page.goto("/catalog");
    await page.getByTestId("catalog-sync-start-btn").click();
    await expect(page.getByTestId("catalog-sync-pause-btn")).toHaveAttribute(
      "data-state",
      "syncing",
    );

    await page.getByTestId("catalog-sync-pause-btn").click();
    await expect(page.getByTestId("catalog-sync-pause-btn")).toHaveAttribute(
      "data-state",
      "pausing",
    );

    await page.getByRole("link", { name: "Home", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "All Books", exact: true }),
    ).toBeVisible();

    const pausedSummary = await waitForProcessingSummary(
      page,
      (payload) => payload.sync?.status === "paused",
      {
        description: "manual sync to pause while away from processing pages",
      },
    );
    expect(pausedSummary.sync.message).toContain("before pausing");

    await page.getByRole("button", { name: "Processing" }).click();
    await page.getByRole("link", { name: "Catalog", exact: true }).click();

    await expect(page.getByTestId("catalog-sync-resume-btn")).toBeVisible();
    await expect(page.getByTestId("catalog-sync-progress")).toContainText(
      "Saved",
    );
  });

  test("catalog automation uses real backend state", async ({ page }) => {
    const smoke = liveSmokeData();

    await seedIdleRemotePages(page, [
      [smoke.automationA],
      [smoke.automationB],
      [],
    ]);
    await processingPost(page, "/processing/automation/catalog/run/");
    for (let step = 0; step < 2; step += 1) {
      await processingPost(page, "/processing/sync/advance/");
    }

    await page.goto("/catalog");
    await page
      .getByTestId("catalog-records-search")
      .fill("Live Automation Sync");
    const automationA = await waitForTableRowLocation(
      page,
      ["catalog-records"],
      smoke.automationA.name,
      (item) => item.recordId === smoke.automationA.id,
      { attempts: 20, delayMs: 250 },
    );
    const automationB = await waitForTableRowLocation(
      page,
      ["catalog-records"],
      smoke.automationB.name,
      (item) => item.recordId === smoke.automationB.id,
      { attempts: 20, delayMs: 250 },
    );
    expect(automationA.row.recordId).toBe(smoke.automationA.id);
    expect(automationB.row.recordId).toBe(smoke.automationB.id);
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
    await waitForProcessingSummary(
      page,
      (payload) =>
        payload.sync.runMode === "incomplete_automation" ||
        payload.sync.status === "idle",
      { description: "incomplete automation to start" },
    );
    const location = await waitForTableRowLocation(
      page,
      ["incomplete-completed"],
      smoke.incomplete.name,
      (item) => item.recordId === smoke.incomplete.id,
      { attempts: 20, delayMs: 250 },
    );

    await page.goto("/incomplete");
    await page
      .getByTestId(`${location.card}-search`)
      .fill(smoke.incomplete.name);
    await expect(
      page.getByTestId(`${location.card}-row-${location.row.id}`),
    ).toBeVisible();
  });

  test("legacy processing URLs redirect to replacement pages", async ({
    page,
  }) => {
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
