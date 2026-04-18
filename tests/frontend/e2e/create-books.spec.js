import { expect, test } from "./support/playwright";

function nowIso() {
  return new Date(Date.UTC(2026, 3, 17, 9, 0, 0)).toISOString();
}

async function mockAuthenticatedSession(page) {
  await page.route("**/api/auth/session/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user: {
          id: "create-processing-user",
          email: "create-processing@example.com",
          full_name: "Create Processing",
          is_superuser: true,
          capabilities: ["processing:manage"],
          totp_setup_required: false,
        },
      }),
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

async function mockCreateProcessingApi(page) {
  const timestamp = nowIso();
  const state = {
    records: [
      {
        id: "create-page-record",
        name: "Create Page Request",
        url: "https://example.test/create-page-request",
        category: "Regression",
        writer: "Create Writer",
        translator: null,
        composer: null,
        publisher: "Create Press",
        createdAt: timestamp,
        updatedAt: timestamp,
        bookCreationState: "initial",
        selectable: false,
        latestRequestId: "create-page-request",
      },
    ],
    requests: [
      {
        id: "create-page-request",
        bookRecordId: "create-page-record",
        state: "initial",
        createdAt: timestamp,
        updatedAt: timestamp,
        progress: null,
        errorMessage: null,
        isResumed: false,
        isConfirmedNotDuplicate: false,
        duplicateOfRequestId: null,
        duplicateOfRecordId: null,
        duplicateConfirmed: false,
        linkedBookId: null,
      },
    ],
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
        interval: "weekly",
        time: "03:00",
        saved: false,
        lastRunAt: null,
        statusMessage: "",
      },
      incomplete: {
        enabled: false,
        interval: "weekly",
        time: "03:00",
        saved: false,
        lastRunAt: null,
        statusMessage: "",
      },
    },
    ui: {
      pipelineDelayMs: 2_000,
    },
  };

  async function fulfillState(route) {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(state),
    });
  }

  await page.route("**/api/processing/state/", fulfillState);
  await page.route("**/api/processing/pipeline/advance/", fulfillState);
}

test.describe("Create processing page", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the /create route renders the new processing request cards", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockCreateProcessingApi(page);

    await page.goto("/create");

    await expect(
      page.getByRole("heading", { level: 1, name: "Create", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("create-requests-card")).toBeVisible();
    await expect(page.getByTestId("create-requests-row-create-page-request")).toBeVisible();
    await expect(page.getByText("Create EPUB")).toHaveCount(0);
  });
});
