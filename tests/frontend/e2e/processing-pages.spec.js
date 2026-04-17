import { expect, test } from "./support/playwright";

const PROCESSING_TIMEOUT_MS = 20 * 60 * 1000;

const sessionPayload = {
  authenticated: true,
  user: {
    id: "processing-user",
    email: "processing-admin@example.com",
    full_name: "Processing Admin",
    is_superuser: true,
    capabilities: ["processing:manage"],
    totp_setup_required: false,
  },
};

function iso(offsetMinutes = 0) {
  return new Date(Date.UTC(2026, 3, 17, 8, offsetMinutes, 0)).toISOString();
}

function record(overrides = {}) {
  return {
    id: "record-1",
    name: "Reusable Systems",
    url: "https://example.test/books/reusable-systems",
    category: "Architecture",
    writer: "Ada Writer",
    translator: null,
    composer: null,
    publisher: "North Press",
    createdAt: iso(1),
    updatedAt: iso(1),
    bookCreationState: "not_created",
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    id: "request-1",
    bookRecordId: "record-1",
    state: "initial",
    createdAt: iso(2),
    updatedAt: iso(2),
    progress: null,
    errorMessage: null,
    isResumed: false,
    isConfirmedNotDuplicate: false,
    duplicateOfRequestId: null,
    duplicateOfRecordId: null,
    ...overrides,
  };
}

function baseState(overrides = {}) {
  return {
    records: [],
    requests: [],
    sync: {
      status: "idle",
      progress: null,
      fetchedCount: 0,
      skippedCount: 0,
      updatedCount: 0,
      appendedCount: 0,
      message: "Ready to sync.",
      remotePages: [],
      pageIndex: 0,
    },
    automation: {
      catalog: {
        enabled: false,
        interval: "daily",
        time: "02:00",
        saved: false,
        lastRunAt: "",
      },
      incomplete: {
        enabled: false,
        interval: "daily",
        time: "03:00",
        saved: false,
        lastRunAt: "",
      },
    },
    ui: {
      actionDelayMs: 80,
      pipelineDelayMs: 500,
    },
    ...overrides,
  };
}

async function mockAuthenticatedSession(page) {
  await page.route("**/api/auth/session/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sessionPayload),
    });
  });
  await page.route("**/api/csrf/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ detail: "ok" }),
    });
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function latestRequestForRecord(state, recordId) {
  return state.requests
    .filter((item) => item.bookRecordId === recordId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function requestBlocksSelection(requestItem) {
  return requestItem && !["failed", "deleted"].includes(requestItem.state);
}

function recordSelectable(state, recordItem) {
  const recordRequests = state.requests.filter(
    (item) => item.bookRecordId === recordItem.id,
  );
  const confirmedDuplicate = recordRequests.find(
    (item) => item.state === "duplicate" && item.duplicateConfirmed,
  );
  if (confirmedDuplicate) {
    const original = state.requests.find(
      (item) => item.id === confirmedDuplicate.duplicateOfRequestId,
    );
    return !original || ["failed", "deleted"].includes(original.state);
  }
  return !recordRequests.some(requestBlocksSelection);
}

function syncRecordStates(state) {
  state.records = state.records.map((recordItem) => {
    const latest = latestRequestForRecord(state, recordItem.id);
    return {
      selectable: recordSelectable(state, recordItem),
      ...recordItem,
      bookCreationState: latest?.state || recordItem.bookCreationState,
      latestRequestId: latest?.id || null,
      selectable: recordSelectable(state, recordItem),
    };
  });
  return state;
}

function nextRequestId(state, recordId) {
  const preferred = `request-${recordId}`;
  if (!state.requests.some((item) => item.id === preferred)) {
    return preferred;
  }
  let index = 2;
  while (state.requests.some((item) => item.id === `${preferred}-${index}`)) {
    index += 1;
  }
  return `${preferred}-${index}`;
}

function createRequestForRecord(state, recordId, stateValue = "initial") {
  const timestamp = iso(30 + state.requests.length);
  state.requests.push({
    id: nextRequestId(state, recordId),
    bookRecordId: recordId,
    state: stateValue,
    createdAt: timestamp,
    updatedAt: timestamp,
    progress: null,
    errorMessage: null,
    isResumed: false,
    isConfirmedNotDuplicate: false,
    duplicateOfRequestId: null,
    duplicateOfRecordId: null,
    duplicateConfirmed: false,
  });
}

function reconcilePage(state, pageRecords) {
  for (const incoming of pageRecords) {
    const existing = state.records.find((item) => item.id === incoming.id);
    if (!existing) {
      state.records.push(incoming);
      state.sync.appendedCount += 1;
      continue;
    }
    if (existing.updatedAt !== incoming.updatedAt) {
      Object.assign(existing, incoming, {
        bookCreationState: existing.bookCreationState,
      });
      state.sync.updatedCount += 1;
      continue;
    }
    state.sync.skippedCount += 1;
  }
}

function nextStateTimestamp(state) {
  return Date.parse(state.ui?.nowIso || iso(10));
}

function applyRequestTimeouts(state) {
  const now = nextStateTimestamp(state);
  for (const item of state.requests) {
    if (item.state !== "processing") {
      continue;
    }
    const updatedAt = Date.parse(item.updatedAt || item.createdAt || "");
    if (!Number.isFinite(updatedAt) || now - updatedAt <= PROCESSING_TIMEOUT_MS) {
      continue;
    }
    item.state = "failed";
    item.errorMessage =
      item.errorMessage || "Processing exceeded 20 minutes without completing.";
    item.updatedAt = new Date(now).toISOString();
  }
}

function finalizeSync(state) {
  state.sync.status = "idle";
  state.sync.progress = null;
  state.sync.message = `Sync complete. Updated ${state.sync.updatedCount}, Skipped ${state.sync.skippedCount}, Added ${state.sync.appendedCount}.`;
}

function advanceSyncPage(state) {
  const pageRecords = state.sync.remotePages[state.sync.pageIndex] || [];
  if (!pageRecords.length) {
    finalizeSync(state);
    return;
  }
  reconcilePage(state, pageRecords);
  state.sync.fetchedCount += pageRecords.length;
  state.sync.pageIndex += 1;
  const nextPage = state.sync.remotePages[state.sync.pageIndex] || [];
  if (state.sync.status === "pausing") {
    state.sync.status = "paused";
    state.sync.progress = {
      savedAt: iso(99),
      checkpoint: `page-${state.sync.pageIndex}`,
      savedData: {
        fetchedCount: state.sync.fetchedCount,
        nextPageIndex: state.sync.pageIndex,
      },
    };
    state.sync.message = `Saved ${state.sync.fetchedCount} ${state.sync.fetchedCount === 1 ? "record" : "records"} before pausing.`;
    return;
  }

  if (!nextPage.length) {
    finalizeSync(state);
    return;
  }

  state.sync.message = `Fetched ${state.sync.fetchedCount} ${state.sync.fetchedCount === 1 ? "record" : "records"} so far.`;
}

async function mockProcessingApi(page, initialState) {
  let state = syncRecordStates(clone(initialState));
  const controller = {
    setNowIso(nowIso) {
      state.ui = {
        ...state.ui,
        nowIso,
      };
    },
    updateRequest(id, updates) {
      state.requests = state.requests.map((item) =>
        item.id === id ? { ...item, ...updates, updatedAt: iso(900) } : item,
      );
      state = syncRecordStates(state);
    },
  };

  async function fulfillState(route, extra = {}) {
    applyRequestTimeouts(state);
    state = syncRecordStates(state);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...state, ...extra }),
    });
  }

  async function delayForActions() {
    await page.waitForTimeout(Math.max(20, state.ui?.actionDelayMs || 80));
  }

  await page.route("**/api/processing/state/", async (route) => {
    await fulfillState(route);
  });
  await page.route("**/api/processing/sync/start/", async (route) => {
    const body = route.request().postDataJSON();
    state.sync = {
      ...state.sync,
      ...(body?.remotePages ? { remotePages: body.remotePages } : {}),
      status: "syncing",
      progress: null,
      fetchedCount: 0,
      skippedCount: 0,
      updatedCount: 0,
      appendedCount: 0,
      pageIndex: 0,
      message: "Syncing catalog records.",
    };
    await delayForActions();
    await fulfillState(route);
  });
  await page.route("**/api/processing/sync/pause/", async (route) => {
    if (state.sync.status === "syncing") {
      state.sync.status = "pausing";
      state.sync.message = "Pausing after the current page finishes.";
    }
    await delayForActions();
    await fulfillState(route);
  });
  await page.route("**/api/processing/sync/advance/", async (route) => {
    await delayForActions();
    advanceSyncPage(state);
    await fulfillState(route);
  });
  await page.route("**/api/processing/sync/resume/", async (route) => {
    state.sync.status = "syncing";
    state.sync.progress = null;
    state.sync.pageIndex = 0;
    state.sync.message = "Reconciling saved records from the beginning.";
    await fulfillState(route);
  });
  await page.route("**/api/processing/records/create-requests/", async (route) => {
    const body = route.request().postDataJSON();
    await delayForActions();
    for (const id of body.ids || []) {
      const recordItem = state.records.find((item) => item.id === id);
      if (recordItem && recordSelectable(state, recordItem)) {
        createRequestForRecord(state, id);
      }
    }
    await fulfillState(route);
  });
  await page.route("**/api/processing/automation/catalog/", async (route) => {
    state.automation.catalog = {
      ...state.automation.catalog,
      ...route.request().postDataJSON(),
      saved: true,
      statusMessage: "Saved.",
    };
    await delayForActions();
    await fulfillState(route);
  });
  await page.route("**/api/processing/automation/catalog/run/", async (route) => {
    let createdCount = 0;
    await delayForActions();
    for (const recordItem of state.records) {
      const latest = latestRequestForRecord(state, recordItem.id);
      const latestState = latest?.state || recordItem.bookCreationState;
      if (
        (!latest && recordItem.bookCreationState === "not_created") ||
        ["failed", "deleted"].includes(latestState)
      ) {
        createRequestForRecord(state, recordItem.id);
        createdCount += 1;
      }
    }
    state.automation.catalog.statusMessage = `Created ${createdCount} requests.`;
    await fulfillState(route, { createdCount });
  });
  await page.route("**/api/processing/pipeline/advance/", async (route) => {
    applyRequestTimeouts(state);
    for (const item of state.requests) {
      if (item.state === "initial") {
        item.state = "queued";
      } else if (item.state === "queued") {
        item.state = "processing";
      } else if (item.state === "processing") {
        if (item.pipelineOutcome === "failed") {
          item.state = "failed";
          item.errorMessage = item.errorMessage || "Pipeline failed after retries.";
        } else if (item.pipelineOutcome === "duplicate") {
          item.state = "duplicate";
        } else {
          item.state = "created";
        }
      }
      item.updatedAt = iso(200 + state.requests.indexOf(item));
    }
    applyRequestTimeouts(state);
    await fulfillState(route);
  });
  await page.route("**/api/processing/requests/action/", async (route) => {
    const body = route.request().postDataJSON();
    await delayForActions();
    for (const id of body.ids || []) {
      const item = state.requests.find((requestItem) => requestItem.id === id);
      if (!item) {
        continue;
      }
      if (body.action === "delete") {
        item.state = "deleted";
        item.progress = null;
      } else if (body.action === "pause") {
        item.state = "paused";
        item.progress = {
          savedAt: iso(88),
          checkpoint: "Paused at processing",
          savedData: {},
        };
      } else if (body.action === "resume") {
        item.state = "initial";
        item.isResumed = true;
      } else if (body.action === "retry") {
        item.state = "initial";
        item.errorMessage = null;
      } else if (body.action === "new") {
        item.state = "initial";
        item.isConfirmedNotDuplicate = true;
      } else if (body.action === "confirm_duplicate") {
        item.state = "duplicate";
        item.duplicateConfirmed = true;
      } else if (body.action === "create_again" || body.action === "recreate") {
        item.state = "initial";
      }
      item.updatedAt = iso(300 + state.requests.indexOf(item));
    }
    await fulfillState(route);
  });
  await page.route("**/api/processing/automation/incomplete/", async (route) => {
    state.automation.incomplete = {
      ...state.automation.incomplete,
      ...route.request().postDataJSON(),
      saved: true,
      statusMessage: "Saved.",
    };
    await delayForActions();
    await fulfillState(route);
  });
  await page.route("**/api/processing/automation/incomplete/run/", async (route) => {
    let resolvedCount = 0;
    await delayForActions();
    for (const recordItem of state.records) {
      if (recordItem.category === "Incomplete" && recordItem.willResolveToCategory) {
        recordItem.category = recordItem.willResolveToCategory;
        recordItem.wasIncomplete = true;
        recordItem.resolvedFromIncomplete = true;
        const latest = latestRequestForRecord(state, recordItem.id);
        if (latest) {
          latest.state = "created";
        } else {
          createRequestForRecord(state, recordItem.id, "created");
        }
        resolvedCount += 1;
      }
    }
    state.automation.incomplete.statusMessage = `Resolved ${resolvedCount} book.`;
    await fulfillState(route, { resolvedCount });
  });

  return controller;
}

async function boot(page, path, state) {
  await mockAuthenticatedSession(page);
  const processingApi = await mockProcessingApi(page, state);
  await page.goto(path);
  return processingApi;
}

function row(page, pageId, cardId, id) {
  return page.getByTestId(`${pageId}-${cardId}-row-${id}`);
}

function checkbox(page, pageId, cardId, id) {
  return page.getByTestId(`${pageId}-${cardId}-select-${id}`);
}

async function expectVisibleCount(page, pageId, cardId, count) {
  await expect(page.getByTestId(`${pageId}-${cardId}-count`)).toContainText(
    `${count}`,
  );
}

test.describe("processing pages replacement", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("catalog sync, filters, record selection, and request creation", async ({
    page,
  }) => {
    const existing = record({
      id: "existing",
      name: "Stable Local Book",
      writer: "Local Writer",
      publisher: "Local Press",
      updatedAt: iso(1),
    });
    const active = record({
      id: "active",
      name: "Locked Processing Book",
      category: "Science",
      writer: "Busy Writer",
      publisher: "Busy Press",
      bookCreationState: "processing",
    });
    const remoteChanged = record({
      id: "existing",
      name: "Stable Local Book Revised",
      writer: "Local Writer",
      publisher: "Local Press",
      updatedAt: iso(10),
    });
    const remoteNew = record({
      id: "new-remote",
      name: "Fresh Remote Book",
      category: "Poetry",
      writer: "Remote Writer",
      translator: "Case Translator",
      publisher: "Remote House",
      updatedAt: iso(11),
    });

    await boot(
      page,
      "/catalog",
      baseState({
        records: [existing, active],
        requests: [
          request({
            id: "active-request",
            bookRecordId: "active",
            state: "processing",
          }),
        ],
        sync: {
          ...baseState().sync,
          remotePages: [[remoteChanged], [remoteNew], []],
        },
        ui: {
          ...baseState().ui,
          syncDelayMs: 2_000,
        },
      }),
    );

    await expect(
      page.getByRole("heading", { level: 1, name: "Catalog" }),
    ).toBeVisible();
    await expect(page.getByTestId("catalog-overview-stat-records")).toContainText(
      "2",
    );
    await expect(page.getByTestId("catalog-records-table")).toBeVisible();

    await page.getByTestId("catalog-sync-start-btn").click();
    await expect(page.getByTestId("catalog-sync-loader")).toBeVisible();
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeDisabled();

    await page.getByTestId("catalog-sync-pause-btn").click();
    await expect(page.getByTestId("catalog-sync-pause-btn")).toContainText(
      "Pausing...",
    );
    await expect(page.getByTestId("catalog-sync-resume-btn")).toBeVisible();
    await expect(page.getByTestId("catalog-sync-loader")).toHaveCount(0);
    await expect(page.getByTestId("catalog-sync-progress")).toContainText(
      "Saved 1 record",
    );

    await page.getByTestId("catalog-sync-resume-btn").click();
    await expect(row(page, "catalog", "records", "new-remote")).toBeVisible();
    await expect(row(page, "catalog", "records", "existing")).toContainText(
      "Stable Local Book Revised",
    );
    await expect(page.getByTestId("catalog-sync-progress")).toContainText(
      "Skipped 1",
    );
    await expect(page.getByTestId("catalog-sync-progress")).toContainText(
      "Added 1",
    );
    await expect(page.getByTestId("catalog-overview-stat-records")).toContainText(
      "3",
    );

    await page.getByTestId("catalog-records-search").fill("remote writer");
    await expectVisibleCount(page, "catalog", "records", 1);
    await expect(row(page, "catalog", "records", "new-remote")).toBeVisible();
    await page.getByTestId("catalog-records-search").fill("case translator");
    await expectVisibleCount(page, "catalog", "records", 1);
    await page.getByTestId("catalog-records-search").fill("remote house");
    await expectVisibleCount(page, "catalog", "records", 1);
    await page.getByTestId("catalog-records-search").fill("");
    await page.getByTestId("catalog-records-category-filter").selectOption("Poetry");
    await expect(page.getByTestId("catalog-records-active-filters")).toContainText(
      "Poetry",
    );
    await expectVisibleCount(page, "catalog", "records", 1);
    await page
      .getByTestId("catalog-records-status-filter")
      .selectOption("not_created");
    await expect(page.getByTestId("catalog-records-active-filters")).toContainText(
      "Not created",
    );

    await page.getByTestId("catalog-records-category-filter").selectOption("");
    await page.getByTestId("catalog-records-status-filter").selectOption("");
    await expect(checkbox(page, "catalog", "records", "active")).toBeDisabled();
    await checkbox(page, "catalog", "records", "new-remote").check();
    await page.getByTestId("catalog-records-create-btn").click();
    await expect(page.getByTestId("catalog-records-loader")).toBeVisible();
    await expect(page.getByTestId("catalog-records-create-btn")).toBeDisabled();
    await expect(page.getByTestId("catalog-records-loader")).toHaveCount(0);
    await page.goto("/create");
    await expect(row(page, "create", "requests", "request-new-remote")).toBeVisible();
  });

  test("manual sync completes automatically without an explicit pause", async ({
    page,
  }) => {
    await boot(
      page,
      "/catalog",
      baseState({
        sync: {
          ...baseState().sync,
          remotePages: [
            [record({ id: "sync-a", name: "Sync A", updatedAt: iso(21) })],
            [record({ id: "sync-b", name: "Sync B", updatedAt: iso(22) })],
            [],
          ],
        },
        ui: {
          ...baseState().ui,
          syncDelayMs: 120,
          pipelineDelayMs: 2_000,
        },
      }),
    );

    await page.getByTestId("catalog-sync-start-btn").click();
    await expect(page.getByTestId("catalog-sync-loader")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Sync started" })).toBeVisible();
    await expect(row(page, "catalog", "records", "sync-a")).toBeVisible();
    await expect(row(page, "catalog", "records", "sync-b")).toBeVisible();
    await expect(page.getByTestId("catalog-sync-loader")).toHaveCount(0);
    await expect(page.getByTestId("catalog-sync-start-btn")).toBeEnabled();
    await expect(page.getByTestId("catalog-sync-progress")).toContainText(
      "Sync complete",
    );
    await expect(
      page.getByRole("status").filter({ hasText: "Sync complete" }),
    ).toBeVisible();
  });

  test("automated catalog sync creates eligible requests and auto-advances them", async ({
    page,
  }) => {
    const records = [
      record({ id: "auto-new", name: "Auto New", bookCreationState: "not_created" }),
      record({ id: "auto-failed", name: "Auto Failed", bookCreationState: "failed" }),
      record({ id: "auto-deleted", name: "Auto Deleted", bookCreationState: "deleted" }),
      record({ id: "auto-created", name: "Auto Created", bookCreationState: "created" }),
      record({ id: "auto-paused", name: "Auto Paused", bookCreationState: "paused" }),
    ];

    await boot(
      page,
      "/catalog",
      baseState({
        records,
        requests: [
          request({ id: "failed-old", bookRecordId: "auto-failed", state: "failed" }),
          request({ id: "deleted-old", bookRecordId: "auto-deleted", state: "deleted" }),
          request({ id: "created-old", bookRecordId: "auto-created", state: "created" }),
          request({ id: "paused-old", bookRecordId: "auto-paused", state: "paused" }),
        ],
      }),
    );

    await page.getByTestId("catalog-automation-enabled").check();
    await page.getByTestId("catalog-automation-interval").selectOption("weekly");
    await page.getByTestId("catalog-automation-time").fill("04:30");
    await page.getByTestId("catalog-automation-save-btn").click();
    await expect(page.getByTestId("catalog-automation-status")).toContainText(
      "Saved",
    );

    await page.getByTestId("catalog-automation-run-btn").click();
    await expect(page.getByTestId("catalog-automation-loader")).toBeVisible();
    await expect(page.getByTestId("catalog-automation-status")).toContainText(
      "Created 3 request",
    );

    await page.goto("/create");
    await expect(row(page, "create", "requests", "request-auto-new")).toBeVisible();
    await expect(row(page, "create", "queue", "request-auto-new")).toBeVisible();
    await expect(row(page, "create", "processing", "request-auto-new")).toBeVisible();
    await expect(row(page, "create", "created", "request-auto-new")).toBeVisible();
    await expect(row(page, "create", "created", "request-auto-failed")).toBeVisible();
    await expect(row(page, "create", "created", "request-auto-deleted")).toBeVisible();
    await expect(row(page, "create", "created", "created-old")).toBeVisible();
    await expect(row(page, "create", "paused", "paused-old")).toHaveCount(0);
  });

  test("card search, filters, counts, and actions stay scoped to their own cards", async ({
    page,
  }) => {
    await boot(
      page,
      "/create",
      baseState({
        records: [
          record({ id: "initial-alpha", name: "Initial Alpha", category: "Poetry" }),
          record({ id: "initial-beta", name: "Initial Beta", category: "Science" }),
          record({ id: "queued-alpha", name: "Queued Alpha", category: "Poetry" }),
          record({ id: "queued-beta", name: "Queued Beta", category: "Science" }),
        ],
        requests: [
          request({ id: "initial-alpha-request", bookRecordId: "initial-alpha", state: "initial" }),
          request({ id: "initial-beta-request", bookRecordId: "initial-beta", state: "initial" }),
          request({ id: "queued-alpha-request", bookRecordId: "queued-alpha", state: "queued" }),
          request({ id: "queued-beta-request", bookRecordId: "queued-beta", state: "queued" }),
        ],
        ui: { actionDelayMs: 400, pipelineDelayMs: 2_000 },
      }),
    );

    await expectVisibleCount(page, "create", "requests", 2);
    await expectVisibleCount(page, "create", "queue", 2);

    await page.getByTestId("create-requests-search").fill("alpha");
    await expectVisibleCount(page, "create", "requests", 1);
    await expect(row(page, "create", "requests", "initial-alpha-request")).toBeVisible();
    await expect(row(page, "create", "requests", "initial-beta-request")).toHaveCount(0);
    await expectVisibleCount(page, "create", "queue", 2);

    await page.getByTestId("create-queue-category-filter").selectOption("Science");
    await expect(page.getByTestId("create-queue-active-filters")).toContainText(
      "Science",
    );
    await expectVisibleCount(page, "create", "queue", 1);
    await expect(row(page, "create", "queue", "queued-beta-request")).toBeVisible();
    await expect(row(page, "create", "queue", "queued-alpha-request")).toHaveCount(0);
    await expectVisibleCount(page, "create", "requests", 1);

    await checkbox(page, "create", "queue", "queued-beta-request").check();
    await page.getByTestId("create-queue-delete-btn").click();
    await expect(page.getByTestId("create-queue-loader")).toBeVisible();
    await expect(page.getByTestId("create-requests-search")).toHaveValue("alpha");
    await expectVisibleCount(page, "create", "requests", 1);
    await expect(
      checkbox(page, "create", "requests", "initial-alpha-request"),
    ).toBeEnabled();
    await expect(page.getByTestId("create-queue-loader")).toHaveCount(0);
  });

  test("create page cards isolate loaders and move requests between states", async ({
    page,
  }) => {
    await boot(
      page,
      "/create",
      baseState({
        records: [
          record({ id: "initial-a", name: "Initial A", category: "Poetry" }),
          record({ id: "initial-b", name: "Initial B", category: "Poetry" }),
          record({ id: "queued-a", name: "Queued A", category: "Science" }),
          record({ id: "processing-a", name: "Processing A", category: "Science" }),
          record({ id: "created-a", name: "Created A", category: "History" }),
        ],
        requests: [
          request({ id: "initial-a-request", bookRecordId: "initial-a", state: "initial" }),
          request({ id: "initial-b-request", bookRecordId: "initial-b", state: "initial" }),
          request({ id: "queued-a-request", bookRecordId: "queued-a", state: "queued" }),
          request({ id: "processing-a-request", bookRecordId: "processing-a", state: "processing" }),
          request({ id: "created-a-request", bookRecordId: "created-a", state: "created" }),
        ],
        ui: { actionDelayMs: 400, pipelineDelayMs: 20_000 },
      }),
    );

    await expect(page.getByTestId("create-overview-stat-requests")).toContainText(
      "2",
    );
    await expectVisibleCount(page, "create", "requests", 2);
    await expectVisibleCount(page, "create", "queue", 1);
    await expectVisibleCount(page, "create", "processing", 1);
    await expectVisibleCount(page, "create", "created", 1);

    await page.getByTestId("create-requests-search").fill("initial a");
    await expectVisibleCount(page, "create", "requests", 1);
    await page.getByTestId("create-requests-search").fill("");
    await page.getByTestId("create-requests-category-filter").selectOption("Poetry");
    await expect(page.getByTestId("create-requests-active-filters")).toContainText(
      "Poetry",
    );
    await expectVisibleCount(page, "create", "requests", 2);

    await checkbox(page, "create", "requests", "initial-a-request").check();
    await checkbox(page, "create", "requests", "initial-b-request").check();
    await page.getByTestId("create-requests-delete-btn").click();
    await expect(page.getByTestId("create-requests-loader")).toBeVisible();
    await expect(page.getByTestId("create-requests-delete-btn")).toBeDisabled();
    await expect(checkbox(page, "create", "queue", "queued-a-request")).toBeEnabled();
    await expect(page.getByTestId("create-requests-loader")).toHaveCount(0);
    await expectVisibleCount(page, "create", "requests", 0);

    await checkbox(page, "create", "processing", "processing-a-request").check();
    await page.getByTestId("create-processing-pause-btn").click();
    await expect(page.getByTestId("create-processing-loader")).toBeVisible();
    await expect(row(page, "create", "processing", "processing-a-request")).toHaveCount(0);
    await page.goto("/on-hold");
    await expect(row(page, "on-hold", "paused", "processing-a-request")).toBeVisible();
    await expect(row(page, "on-hold", "paused", "processing-a-request")).toContainText(
      "Paused at processing",
    );

    await page.goto("/create");
    await checkbox(page, "create", "created", "created-a-request").check();
    await page.getByTestId("create-created-delete-btn").click();
    await expect(row(page, "create", "created", "created-a-request")).toHaveCount(0);
    await page.goto("/on-hold");
    await expect(row(page, "on-hold", "deleted", "created-a-request")).toBeVisible();
  });

  test("on-hold page resumes, retries, resolves duplicates, deletes, and recreates", async ({
    page,
  }) => {
    await boot(
      page,
      "/on-hold",
      baseState({
        records: [
          record({ id: "paused-book", name: "Paused Book" }),
          record({ id: "failed-book", name: "Failed Book" }),
          record({ id: "duplicate-book", name: "Duplicate Book" }),
          record({ id: "deleted-book", name: "Deleted Book" }),
          record({ id: "original-book", name: "Original Book", bookCreationState: "processing" }),
        ],
        requests: [
          request({
            id: "paused-request",
            bookRecordId: "paused-book",
            state: "paused",
            progress: {
              savedAt: iso(20),
              checkpoint: "chapter-4",
              savedData: { chapters: 4 },
            },
          }),
          request({
            id: "failed-request",
            bookRecordId: "failed-book",
            state: "failed",
            errorMessage: "Retry threshold exceeded",
          }),
          request({
            id: "duplicate-request",
            bookRecordId: "duplicate-book",
            state: "duplicate",
            duplicateOfRequestId: "original-request",
            duplicateOfRecordId: "original-book",
          }),
          request({ id: "deleted-request", bookRecordId: "deleted-book", state: "deleted" }),
          request({ id: "original-request", bookRecordId: "original-book", state: "processing" }),
        ],
        ui: { actionDelayMs: 120, pipelineDelayMs: 1_000 },
      }),
    );

    await expect(page.getByTestId("on-hold-overview-stat-paused")).toContainText(
      "1",
    );
    await expect(page.getByTestId("on-hold-failed-table")).toContainText(
      "Error Reason",
    );
    await expect(row(page, "on-hold", "paused", "paused-request")).toContainText(
      "chapter-4",
    );
    await expect(row(page, "on-hold", "failed", "failed-request")).toContainText(
      "Retry threshold exceeded",
    );

    await checkbox(page, "on-hold", "paused", "paused-request").check();
    await page.getByTestId("on-hold-paused-resume-btn").click();
    await expect(page.getByTestId("on-hold-paused-loader")).toBeVisible();
    await expect(row(page, "on-hold", "paused", "paused-request")).toHaveCount(0);
    await page.goto("/create");
    await expect(row(page, "create", "requests", "paused-request")).toBeVisible();

    await page.goto("/on-hold");
    await checkbox(page, "on-hold", "failed", "failed-request").check();
    await page.getByTestId("on-hold-failed-retry-btn").click();
    await expect(row(page, "on-hold", "failed", "failed-request")).toHaveCount(0);
    await page.goto("/create");
    await expect(row(page, "create", "requests", "failed-request")).toBeVisible();

    await page.goto("/on-hold");
    await checkbox(page, "on-hold", "duplicate", "duplicate-request").check();
    await page.getByTestId("on-hold-duplicate-new-btn").click();
    await expect(row(page, "on-hold", "duplicate", "duplicate-request")).toHaveCount(0);
    await page.goto("/create");
    await expect(row(page, "create", "requests", "duplicate-request")).toBeVisible();

    await page.goto("/on-hold");
    await checkbox(page, "on-hold", "deleted", "deleted-request").check();
    await page.getByTestId("on-hold-deleted-create-again-btn").click();
    await expect(row(page, "on-hold", "deleted", "deleted-request")).toHaveCount(0);
    await page.goto("/create");
    await expect(row(page, "create", "requests", "deleted-request")).toBeVisible();
  });

  test("duplicate confirmation locks catalog rows until original request is terminal", async ({
    page,
  }) => {
    const processingApi = await boot(
      page,
      "/on-hold",
      baseState({
        records: [
          record({ id: "duplicate-book", name: "Duplicate Candidate" }),
          record({ id: "original-book", name: "Original Candidate", bookCreationState: "processing" }),
        ],
        requests: [
          request({
            id: "duplicate-request",
            bookRecordId: "duplicate-book",
            state: "duplicate",
            duplicateOfRequestId: "original-request",
            duplicateOfRecordId: "original-book",
          }),
          request({ id: "original-request", bookRecordId: "original-book", state: "processing" }),
        ],
        ui: { actionDelayMs: 80, pipelineDelayMs: 20_000 },
      }),
    );

    await checkbox(page, "on-hold", "duplicate", "duplicate-request").check();
    await page.getByTestId("on-hold-duplicate-duplicate-btn").click();
    await expect(row(page, "on-hold", "duplicate", "duplicate-request")).toContainText(
      "Confirmed duplicate",
    );
    await page.goto("/catalog");
    await expect(checkbox(page, "catalog", "records", "duplicate-book")).toBeDisabled();

    processingApi.updateRequest("original-request", { state: "failed" });
    await page.reload();
    await expect(checkbox(page, "catalog", "records", "duplicate-book")).toBeEnabled();
  });

  test("incomplete page automation, read-only records, and completed-book actions", async ({
    page,
  }) => {
    await boot(
      page,
      "/incomplete",
      baseState({
        records: [
          record({
            id: "incomplete-book",
            name: "Incomplete Book",
            category: "Incomplete",
            writer: "Missing Writer",
            wasIncomplete: true,
            willResolveToCategory: "Novel",
          }),
          record({
            id: "completed-book",
            name: "Resolved Book",
            category: "Novel",
            writer: "Done Writer",
            wasIncomplete: true,
            resolvedFromIncomplete: true,
            bookCreationState: "created",
          }),
        ],
        requests: [
          request({
            id: "completed-request",
            bookRecordId: "completed-book",
            state: "created",
          }),
        ],
        ui: { actionDelayMs: 80, pipelineDelayMs: 2_000 },
      }),
    );

    await expect(page.getByTestId("incomplete-overview-stat-incomplete")).toContainText(
      "1",
    );
    await expect(page.getByTestId("incomplete-overview-stat-resolved")).toContainText(
      "1",
    );
    await expect(row(page, "incomplete", "records", "incomplete-book")).toBeVisible();
    await expect(page.getByTestId("incomplete-records-recreate-btn")).toHaveCount(0);

    await page.getByTestId("incomplete-records-search").fill("missing writer");
    await expectVisibleCount(page, "incomplete", "records", 1);
    await page.getByTestId("incomplete-records-category-filter").selectOption("Incomplete");
    await expect(page.getByTestId("incomplete-records-active-filters")).toContainText(
      "Incomplete",
    );

    await page.getByTestId("incomplete-automation-enabled").check();
    await page.getByTestId("incomplete-automation-save-btn").click();
    await expect(page.getByTestId("incomplete-automation-status")).toContainText(
      "Saved",
    );
    await page.getByTestId("incomplete-automation-run-btn").click();
    await expect(page.getByTestId("incomplete-automation-loader")).toBeVisible();
    await expect(row(page, "incomplete", "completed", "request-incomplete-book")).toBeVisible();
    await expect(page.getByTestId("incomplete-overview-stat-incomplete")).toContainText(
      "0",
    );

    await checkbox(page, "incomplete", "completed", "completed-request").check();
    await page.getByTestId("incomplete-completed-recreate-btn").click();
    await expect(page.getByTestId("incomplete-completed-loader")).toBeVisible();
    await expect(row(page, "incomplete", "completed", "completed-request")).toHaveCount(0);
    await page.goto("/create");
    await expect(row(page, "create", "requests", "completed-request")).toBeVisible();

    await page.goto("/incomplete");
    await checkbox(page, "incomplete", "completed", "request-incomplete-book").check();
    await page.getByTestId("incomplete-completed-delete-btn").click();
    await expect(page.getByTestId("incomplete-completed-loader")).toBeVisible();
    await expect(row(page, "incomplete", "completed", "request-incomplete-book")).toHaveCount(0);
    await page.goto("/on-hold");
    await expect(row(page, "on-hold", "deleted", "request-incomplete-book")).toBeVisible();
  });

  test("card actions stay isolated while separate cards are busy", async ({
    page,
  }) => {
    await boot(
      page,
      "/on-hold",
      baseState({
        records: [
          record({ id: "failed-book", name: "Slow Failed" }),
          record({ id: "duplicate-book", name: "Fast Duplicate" }),
        ],
        requests: [
          request({
            id: "failed-request",
            bookRecordId: "failed-book",
            state: "failed",
            errorMessage: "Network retries exhausted",
          }),
          request({
            id: "duplicate-request",
            bookRecordId: "duplicate-book",
            state: "duplicate",
          }),
        ],
        ui: { actionDelayMs: 700, pipelineDelayMs: 2_000 },
      }),
    );

    await checkbox(page, "on-hold", "failed", "failed-request").check();
    await page.getByTestId("on-hold-failed-retry-btn").click();
    await expect(page.getByTestId("on-hold-failed-loader")).toBeVisible();
    await expect(checkbox(page, "on-hold", "failed", "failed-request")).toBeDisabled();
    await expect(checkbox(page, "on-hold", "duplicate", "duplicate-request")).toBeEnabled();

    await checkbox(page, "on-hold", "duplicate", "duplicate-request").check();
    await page.getByTestId("on-hold-duplicate-new-btn").click();
    await expect(page.getByTestId("on-hold-duplicate-loader")).toBeVisible();
    await expect(page.getByTestId("on-hold-failed-loader")).toBeVisible();
    await expect(row(page, "on-hold", "duplicate", "duplicate-request")).toHaveCount(0);
    await expect(row(page, "on-hold", "failed", "failed-request")).toHaveCount(0);
  });

  test("processing notifications surface action completion, duplicate detection, and stale failures", async ({
    page,
  }) => {
    const processingApi = await boot(
      page,
      "/catalog",
      baseState({
        records: [
          record({ id: "toast-record", name: "Toast Record" }),
          record({ id: "duplicate-record", name: "Duplicate Record" }),
          record({ id: "failed-record", name: "Failed Record" }),
          record({ id: "stale-record", name: "Stale Record" }),
        ],
        requests: [
          request({
            id: "duplicate-processing-request",
            bookRecordId: "duplicate-record",
            state: "initial",
            updatedAt: iso(15),
            pipelineOutcome: "duplicate",
          }),
          request({
            id: "failed-processing-request",
            bookRecordId: "failed-record",
            state: "processing",
            updatedAt: iso(39),
            pipelineOutcome: "failed",
          }),
          request({
            id: "stale-processing-request",
            bookRecordId: "stale-record",
            state: "processing",
            updatedAt: iso(5),
          }),
        ],
        ui: {
          ...baseState().ui,
          pipelineDelayMs: 120,
        },
      }),
    );

    processingApi.setNowIso(iso(40));

    await checkbox(page, "catalog", "records", "toast-record").check();
    await page.getByTestId("catalog-records-create-btn").click();
    await expect(
      page.getByRole("status").filter({ hasText: "Requests created" }),
    ).toBeVisible();

    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Pipeline failed after retries." }),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "Duplicate detected" }),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "Book created" }),
    ).toBeVisible();

    await page.goto("/on-hold");
    await expect(
      row(page, "on-hold", "duplicate", "duplicate-processing-request"),
    ).toBeVisible();
    await expect(
      row(page, "on-hold", "failed", "failed-processing-request"),
    ).toContainText("Pipeline failed after retries.");
    await expect(
      row(page, "on-hold", "failed", "stale-processing-request"),
    ).toContainText("Processing exceeded 20 minutes without completing.");
  });
});
