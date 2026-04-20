import { expect, test } from "./support/playwright";
import { getSuperAdminCredentials } from "./support/liveEnv";

async function processingRequest(page, path, { method = "GET", body } = {}) {
  const result = await page.evaluate(
    async ({ requestPath, requestMethod, requestBody }) => {
      const response = await fetch(`/api${requestPath}`, {
        method: requestMethod,
        cache: "no-store",
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...(requestMethod === "GET"
            ? {}
            : {
                "Content-Type": "application/json",
                "X-CSRFToken":
                  decodeURIComponent(
                    document.cookie.match(/(?:^|; )csrftoken=([^;]+)/)?.[1] || "",
                  ) || "",
              }),
        },
        body:
          requestMethod === "GET" || requestBody === undefined
            ? undefined
            : JSON.stringify(requestBody),
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        text,
      };
    },
    {
      requestPath: path,
      requestMethod: method,
      requestBody: body,
    },
  );

  if (!result.ok) {
    throw new Error(
      `Processing API ${path} failed with ${result.status}: ${result.text}`,
    );
  }

  return result.text ? JSON.parse(result.text) : null;
}

async function processingGet(page, path) {
  return processingRequest(page, path);
}

async function processingPost(page, path, body = {}) {
  await page.evaluate(async () => {
    await fetch("/api/csrf/", { credentials: "include" });
  });
  return processingRequest(page, path, {
    method: "POST",
    body,
  });
}

async function processingCard(page, card) {
  return processingGet(
    page,
    `/processing/card/?${new URLSearchParams({ card }).toString()}`,
  );
}

async function processingTable(page, card, params = {}) {
  const search = new URLSearchParams({ card, limit: "60" });
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  });
  return processingGet(page, `/processing/table/?${search.toString()}`);
}

async function waitForCard(page, card, predicate, options = {}) {
  const {
    attempts = 90,
    delayMs = 1000,
    description = `${card} condition`,
  } = options;
  let payload = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    payload = await processingCard(page, card);
    if (predicate(payload)) {
      return payload;
    }
    await page.waitForTimeout(delayMs);
  }
  throw new Error(
    `Timed out waiting for ${description}. Last payload: ${JSON.stringify(payload)}`,
  );
}

async function waitForTable(page, card, predicate, options = {}) {
  const {
    params = {},
    attempts = 90,
    delayMs = 1000,
    description = `${card} condition`,
  } = options;
  let payload = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    payload = await processingTable(page, card, params);
    if (predicate(payload)) {
      return payload;
    }
    await page.waitForTimeout(delayMs);
  }
  throw new Error(
    `Timed out waiting for ${description}. Last payload: ${JSON.stringify(payload)}`,
  );
}

async function waitForRequestInCards(
  page,
  cards,
  requestId,
  query,
  options = {},
) {
  const {
    attempts = 120,
    delayMs = 1000,
    description = `request ${requestId} in cards`,
  } = options;
  let snapshot = {};
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    snapshot = {};
    for (const card of cards) {
      const payload = await processingTable(page, card, { q: query });
      snapshot[card] = payload.rows.map((row) => ({
        id: row.id,
        requestId: row.requestId,
        status: row.status,
      }));
      const matchingRow = payload.rows.find(
        (row) => (row.requestId || row.id) === requestId,
      );
      if (matchingRow) {
        return { card, row: matchingRow };
      }
    }
    await page.waitForTimeout(delayMs);
  }
  throw new Error(
    `Timed out waiting for ${description}. Last snapshot: ${JSON.stringify(snapshot)}`,
  );
}

async function waitForRecordFinalCard(page, recordId, query, options = {}) {
  const {
    attempts = 180,
    delayMs = 1000,
    description = `record ${recordId} to reach a terminal processing card`,
  } = options;
  const cards = [
    "create-requests",
    "create-queue",
    "create-processing",
    "create-created",
    "on-hold-failed",
    "on-hold-duplicate",
  ];
  let snapshot = {};
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    snapshot = {};
    for (const card of cards) {
      const payload = await processingTable(page, card, { q: query });
      snapshot[card] = payload.rows.map((row) => ({
        id: row.id,
        recordId: row.recordId,
        requestId: row.requestId,
        status: row.status,
      }));
      const matchingRow = payload.rows.find((row) => row.recordId === recordId);
      if (!matchingRow) {
        continue;
      }
      if (["create-created", "on-hold-failed", "on-hold-duplicate"].includes(card)) {
        return { card, row: matchingRow };
      }
    }
    await page.waitForTimeout(delayMs);
  }
  throw new Error(
    `Timed out waiting for ${description}. Last snapshot: ${JSON.stringify(snapshot)}`,
  );
}

async function ensureCreatedRequest(
  page,
  { requireDuplicateEligible = false } = {},
) {
  const existingCreated = await processingTable(page, "create-created");
  const existingCreatedRow = existingCreated.rows.find(
    (row) => !requireDuplicateEligible || !row.isConfirmedNotDuplicate,
  );
  if (existingCreatedRow) {
    return existingCreatedRow;
  }

  const catalogTable = await processingTable(page, "catalog-records");
  const candidates = catalogTable.rows.filter((row) => row.selectable).slice(0, 5);
  if (candidates.length === 0) {
    throw new Error("No selectable catalog records are available to create a real request.");
  }

  let lastTerminalLocation = null;
  for (const candidate of candidates) {
    const response = await processingPost(
      page,
      "/processing/records/create-requests/?includeLists=0",
      { ids: [candidate.recordId || candidate.id] },
    );
    if (!response?.createdCount) {
      continue;
    }

    lastTerminalLocation = await waitForRecordFinalCard(
      page,
      candidate.recordId || candidate.id,
      candidate.title,
      {
        description: `record ${candidate.title} to finish real processing`,
      },
    );
    if (lastTerminalLocation.card === "create-created") {
      return lastTerminalLocation.row;
    }
  }

  throw new Error(
    `Unable to provision a live created request. Last terminal location: ${JSON.stringify(lastTerminalLocation)}`,
  );
}

async function ensureDuplicateRequest(page) {
  const existingDuplicate = await processingTable(page, "on-hold-duplicate");
  if (existingDuplicate.rows.length > 0) {
    return existingDuplicate.rows[0];
  }
  throw new Error("No natural live duplicate request is currently available.");
}

async function ensureProcessingQuiescent(page) {
  await processingPost(page, "/processing/sync/catalog/stop/?includeLists=0");
  await processingPost(page, "/processing/sync/incomplete/stop/?includeLists=0");
  await processingPost(page, "/processing/automation/catalog/?includeLists=0", {
    enabled: false,
    interval: "weekly",
    time: "03:00",
  });
  await processingPost(page, "/processing/automation/incomplete/?includeLists=0", {
    enabled: false,
    interval: "weekly",
    time: "03:00",
  });
  await waitForCard(
    page,
    "catalog-sync",
    (payload) => payload?.sync?.status === "idle",
    { description: "catalog sync to become idle" },
  );
  await waitForCard(
    page,
    "incomplete-automation",
    (payload) => payload?.sync?.status === "idle",
    { description: "incomplete sync to become idle" },
  );
  await waitForCard(
    page,
    "create-overview",
    (payload) => {
      const summary = payload?.summary || {};
      return (
        Number(summary.requests || 0) +
          Number(summary.queue || 0) +
          Number(summary.processing || 0) ===
        0
      );
    },
    { description: "processing request pipeline to become idle" },
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

function nextMinuteTimeString() {
  const nextMinute = new Date();
  nextMinute.setMinutes(nextMinute.getMinutes() + 1, 0, 0);
  const hours = String(nextMinute.getHours()).padStart(2, "0");
  const minutes = String(nextMinute.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

test.describe("processing live real-flow coverage", () => {
  test.beforeEach(async ({ page }) => {
    await loginSuperAdminThroughApi(page);
    await ensureProcessingQuiescent(page);
  });

  test("catalog manual runtime disables automation and catalog count stays server-backed", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto("/catalog", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("catalog-page")).toBeVisible({
      timeout: 30_000,
    });

    const initialTable = await processingTable(page, "catalog-records");
    await expect.poll(
      async () =>
        (await page.getByTestId("catalog-records-count").textContent())?.trim(),
    ).toBe(String(initialTable.pagination.totalCount));

    if (initialTable.rows.length > 0) {
      const query = initialTable.rows[0].title;
      await page.getByTestId("catalog-records-search").fill(query);
      const filtered = await processingTable(page, "catalog-records", { q: query });
      await expect.poll(
        async () =>
          (await page.getByTestId("catalog-records-count").textContent())?.trim(),
      ).toBe(String(filtered.pagination.totalCount));
    }

    await page.getByTestId("catalog-sync-start-btn").click();
    await expect(page.getByTestId("catalog-sync-pause-btn")).toBeVisible();
    await expect(page.getByTestId("catalog-automation-run-btn")).toBeDisabled();

    await page.getByTestId("catalog-sync-pause-btn").click();
    await waitForCard(
      page,
      "catalog-sync",
      (payload) => payload?.sync?.status === "paused",
      { description: "manual catalog pause" },
    );

    await expect(page.getByTestId("catalog-sync-resume-btn")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("catalog-automation-run-btn")).toBeDisabled();

    await processingPost(page, "/processing/sync/catalog/stop/?includeLists=0");
  });

  test("catalog automation run button shares the same runtime ownership as manual", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto("/catalog");
    await page.getByTestId("catalog-automation-run-btn").click();

    await expect.poll(
      async () => (await page.getByTestId("catalog-automation-run-btn").getAttribute("data-state")) || "",
    ).toMatch(/syncing|pausing|paused/);
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeDisabled({
      timeout: 30_000,
    });

    await page.getByTestId("catalog-automation-run-btn").click();
    await waitForCard(
      page,
      "catalog-automation",
      (payload) => payload?.sync?.status === "paused",
      { description: "catalog automation pause" },
    );

    await expect(page.getByTestId("catalog-sync-start-btn")).toBeDisabled();
    await processingPost(page, "/processing/sync/catalog/stop/?includeLists=0");
  });

  test("scheduled catalog automation uses the same live runtime as button-started automation", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const scheduledTime = nextMinuteTimeString();
    await page.goto("/catalog");

    const toggle = page.getByTestId("catalog-automation-enabled");
    if (!(await toggle.isChecked())) {
      await toggle.check();
    }
    await page.getByTestId("catalog-automation-interval").selectOption("daily");
    await page.getByTestId("catalog-automation-time").fill(scheduledTime);
    await page.getByTestId("catalog-automation-save-btn").click();

    await expect(page.getByTestId("catalog-automation-status")).toContainText("Saved");

    const scheduledRun = await waitForCard(
      page,
      "catalog-automation",
      (payload) =>
        payload?.sync?.triggerSource === "scheduler" &&
        payload?.sync?.runMode === "catalog_automation" &&
        ["syncing", "pausing", "paused"].includes(payload?.sync?.status),
      {
        attempts: 150,
        delayMs: 1000,
        description: "scheduled catalog automation to start",
      },
    );

    expect(scheduledRun.sync.triggerSource).toBe("scheduler");
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeDisabled();

    await processingPost(page, "/processing/sync/catalog/stop/?includeLists=0");
    await processingPost(page, "/processing/automation/catalog/?includeLists=0", {
      enabled: false,
      interval: "weekly",
      time: "03:00",
    });
  });

  test("incomplete automation stays separate from catalog runtime and incomplete counts are server-backed", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto("/incomplete", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("incomplete-page")).toBeVisible({
      timeout: 30_000,
    });

    const incompleteTable = await processingTable(page, "incomplete-records");
    await expect.poll(
      async () =>
        (await page.getByTestId("incomplete-records-count").textContent())?.trim(),
    ).toBe(String(incompleteTable.pagination.totalCount));

    await page.getByTestId("incomplete-automation-run-btn").click();
    await waitForCard(
      page,
      "incomplete-automation",
      (payload) => ["syncing", "pausing", "paused"].includes(payload?.sync?.status),
      { description: "incomplete automation to start" },
    );

    await page.goto("/catalog");
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeEnabled();

    await processingPost(page, "/processing/sync/incomplete/stop/?includeLists=0");
  });

  test("scheduled incomplete automation uses the same live runtime as the run button", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const scheduledTime = nextMinuteTimeString();
    await page.goto("/incomplete", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("incomplete-page")).toBeVisible({
      timeout: 30_000,
    });

    const toggle = page.getByTestId("incomplete-automation-enabled");
    if (!(await toggle.isChecked())) {
      await toggle.check();
    }
    await page
      .getByTestId("incomplete-automation-interval")
      .selectOption("daily");
    await page.getByTestId("incomplete-automation-time").fill(scheduledTime);
    await page.getByTestId("incomplete-automation-save-btn").click();

    await expect(page.getByTestId("incomplete-automation-status")).toContainText(
      "Saved",
    );

    const scheduledRun = await waitForCard(
      page,
      "incomplete-automation",
      (payload) =>
        payload?.sync?.triggerSource === "scheduler" &&
        payload?.sync?.runMode === "incomplete_automation" &&
        ["syncing", "pausing", "paused"].includes(payload?.sync?.status),
      {
        attempts: 150,
        delayMs: 1000,
        description: "scheduled incomplete automation to start",
      },
    );

    expect(scheduledRun.sync.triggerSource).toBe("scheduler");
    await page.goto("/catalog", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeEnabled();

    await processingPost(page, "/processing/sync/incomplete/stop/?includeLists=0");
    await processingPost(page, "/processing/automation/incomplete/?includeLists=0", {
      enabled: false,
      interval: "weekly",
      time: "03:00",
    });
  });

  test("created deletion hydrates deleted card and create again returns the request to live flow", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("create-page")).toBeVisible({
      timeout: 30_000,
    });

    const createdRow = await ensureCreatedRequest(page);
    const createdRequestId = createdRow.requestId || createdRow.id;
    const createdTable = await processingTable(page, "create-created");

    await expect.poll(
      async () =>
        (await page.getByTestId("create-created-count").textContent())?.trim(),
    ).toBe(String(createdTable.pagination.totalCount));

    await page.getByTestId("create-created-search").fill(createdRow.title);
    const filteredCreatedTable = await processingTable(page, "create-created", {
      q: createdRow.title,
    });
    await expect.poll(
      async () =>
        (await page.getByTestId("create-created-count").textContent())?.trim(),
    ).toBe(String(filteredCreatedTable.pagination.totalCount));

    await expect(
      page.getByTestId(`create-created-select-${createdRequestId}`),
    ).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId(`create-created-select-${createdRequestId}`).check();
    await page.getByTestId("create-created-delete-btn").click();

    await waitForTable(
      page,
      "on-hold-deleted",
      (payload) =>
        payload.rows.some(
          (row) => (row.requestId || row.id) === createdRequestId,
        ),
      {
        params: { q: createdRow.title },
        description: "deleted card to hydrate after deleting a created request",
      },
    );

    await page.goto("/on-hold", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("on-hold-page")).toBeVisible({
      timeout: 30_000,
    });

    await page.getByTestId("on-hold-deleted-search").fill(createdRow.title);
    const deletedFilteredTable = await processingTable(page, "on-hold-deleted", {
      q: createdRow.title,
    });
    await expect.poll(
      async () =>
        (await page.getByTestId("on-hold-deleted-count").textContent())?.trim(),
    ).toBe(String(deletedFilteredTable.pagination.totalCount));

    await expect(
      page.getByTestId(`on-hold-deleted-select-${createdRequestId}`),
    ).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId(`on-hold-deleted-select-${createdRequestId}`).check();
    await page.getByTestId("on-hold-deleted-create-again-btn").click();

    const emptyDeletedTable = await waitForTable(
      page,
      "on-hold-deleted",
      (payload) =>
        !payload.rows.some(
          (row) => (row.requestId || row.id) === createdRequestId,
        ),
      {
        params: { q: createdRow.title },
        description: "recreated request to leave the deleted card",
      },
    );
    expect(emptyDeletedTable.pagination.totalCount).toBe(0);

    const relocated = await waitForRequestInCards(
      page,
      [
        "create-created",
        "on-hold-failed",
      ],
      createdRequestId,
      createdRow.title,
      {
        attempts: 180,
        description: "recreated request to finish processing again",
      },
    );

    expect(["create-created", "on-hold-failed"]).toContain(relocated.card);
  });

  test("duplicate resolution keeps counts server-backed and moves the request out of duplicate", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await page.goto("/on-hold", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("on-hold-page")).toBeVisible({
      timeout: 30_000,
    });

    let duplicateRow = null;
    try {
      duplicateRow = await ensureDuplicateRequest(page);
    } catch (error) {
      test.skip(
        true,
        error instanceof Error ? error.message : "No live duplicate request is available.",
      );
    }
    const duplicateRequestId = duplicateRow.requestId || duplicateRow.id;
    const duplicateTable = await processingTable(page, "on-hold-duplicate");

    await expect.poll(
      async () =>
        (await page.getByTestId("on-hold-duplicate-count").textContent())?.trim(),
    ).toBe(String(duplicateTable.pagination.totalCount));

    await page.getByTestId("on-hold-duplicate-search").fill(duplicateRow.title);
    const filteredDuplicateTable = await processingTable(page, "on-hold-duplicate", {
      q: duplicateRow.title,
    });
    await expect.poll(
      async () =>
        (await page.getByTestId("on-hold-duplicate-count").textContent())?.trim(),
    ).toBe(String(filteredDuplicateTable.pagination.totalCount));

    await expect(
      page.getByTestId(`on-hold-duplicate-select-${duplicateRequestId}`),
    ).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId(`on-hold-duplicate-select-${duplicateRequestId}`).check();
    await page.getByTestId("on-hold-duplicate-new-btn").click();

    await waitForTable(
      page,
      "on-hold-duplicate",
      (payload) =>
        !payload.rows.some(
          (row) => (row.requestId || row.id) === duplicateRequestId,
        ),
      {
        params: { q: duplicateRow.title },
        description: "duplicate request to leave duplicate card after marking new",
      },
    );

    const relocated = await waitForRequestInCards(
      page,
      [
        "create-requests",
        "create-queue",
        "create-processing",
        "create-created",
        "on-hold-failed",
      ],
      duplicateRequestId,
      duplicateRow.title,
      {
        attempts: 180,
        description: "resolved duplicate request to re-enter live processing flow",
      },
    );

    expect(
      [
        "create-requests",
        "create-queue",
        "create-processing",
        "create-created",
        "on-hold-failed",
      ],
    ).toContain(relocated.card);
  });
});
