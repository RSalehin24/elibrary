import { expect, test } from "./support/playwright";
import { ProcessingPageModel } from "./pages/processingPage";
import { seedData } from "./support/seedData";

function createCatalogSyncState(overrides = {}) {
  return {
    status: "queued",
    max_pages: 80,
    task_id: "seed-catalog-refresh",
    queue_name: "celery",
    retry_count: 0,
    refreshed_entries: 0,
    last_error: "",
    requested_by_email: "superadmin@example.com",
    created_at: "2026-04-14T00:00:00Z",
    updated_at: "2026-04-14T00:00:00Z",
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

function createCatalogEntriesPayload(entriesOrEntry, overrides = {}) {
  const entries = Array.isArray(entriesOrEntry)
    ? entriesOrEntry
    : [entriesOrEntry];
  const summary = {
    total: entries.length,
    new: 0,
    queued: 0,
    processing: 0,
    stopped: 0,
    unfinished: 0,
    failed: 0,
    ready: 0,
    deleted: 0,
  };

  for (const entry of entries) {
    const status = entry.curation_status;
    const latestJobStatus = entry.latest_job_status || "";

    if (status === "processing" && latestJobStatus === "queued") {
      summary.queued += 1;
    } else if (status === "processing") {
      summary.processing += 1;
    } else if (Object.hasOwn(summary, status)) {
      summary[status] += 1;
    }
  }

  return {
    entries,
    pagination: {
      page: 1,
      limit: 180,
      total: entries.length,
      page_count: 1,
    },
    summary,
    sync_state: null,
    ...overrides,
  };
}

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
  await expect(processingPage.cardResultCount("Ready")).toHaveText(/\d+/, {
    timeout: 15_000,
  });
  await expect(bulkBar.getByRole("button", { name: "Delete" })).toBeVisible();
  await expect(bulkBar.getByRole("button", { name: "Delete all" })).toHaveCount(0);
}

function createProcessingJob({
  id,
  submissionId,
  input,
  status,
  origin = "user",
  submissionStatus = status,
  lastError = "",
  taskId = "",
}) {
  return {
    id,
    submission_id: submissionId,
    job_type: "create",
    status,
    task_id: taskId,
    queue_name: "celery",
    retry_count: 0,
    cancel_requested: false,
    submission_origin: origin,
    submission_input: input,
    submission_status: submissionStatus,
    submission_resolution_status: "resolved",
    target_book_slug: "",
    target_book_title: "",
    target_book_deleted: false,
    last_error: lastError,
    created_at: "2026-04-14T00:00:00Z",
    updated_at: "2026-04-14T00:00:00Z",
    started_at: status === "processing" ? "2026-04-14T00:01:00Z" : null,
    finished_at: ["failed", "stopped", "succeeded"].includes(status)
      ? "2026-04-14T00:05:00Z"
      : null,
  };
}

function createProcessingSubmission({
  id,
  input,
  status,
  origin = "user",
  latestJob = null,
  errorMessage = "",
}) {
  return {
    id,
    input_type: "text",
    origin,
    original_input: input,
    resolved_url: "",
    resolution_status: "resolved",
    resolution_confidence: 1,
    status,
    review_state: "",
    error_message: errorMessage,
    linked_book_slug: "",
    linked_book: "",
    linked_book_deleted: false,
    served_from_database: false,
    canonical_submission_id: "",
    uses_existing_request: false,
    candidates: [],
    latest_job: latestJob ? { ...latestJob } : null,
    created_at: "2026-04-14T00:00:00Z",
    updated_at: "2026-04-14T00:00:00Z",
  };
}

async function mockMyRequestsRoutes(page) {
  const processingJob = createProcessingJob({
    id: "job-user-processing",
    submissionId: "submission-user-processing",
    input: seedData.submissions.userProcessing,
    status: "processing",
    taskId: "task-user-processing",
  });
  const stoppedJob = createProcessingJob({
    id: "job-user-stopped",
    submissionId: "submission-user-stopped",
    input: seedData.submissions.userStopped,
    status: "stopped",
    lastError: "Seeded stop",
  });
  const failedJob = createProcessingJob({
    id: "job-user-failed",
    submissionId: "submission-user-failed",
    input: seedData.submissions.userFailed,
    status: "failed",
    lastError: "Seeded failed job log entry.",
  });

  let jobs = [processingJob, stoppedJob, failedJob];
  let submissions = [
    createProcessingSubmission({
      id: "submission-user-pending",
      input: seedData.submissions.userPending,
      status: "pending_resolution",
    }),
    createProcessingSubmission({
      id: "submission-user-ready",
      input: "E2E User Ready Submission",
      status: "ready",
    }),
    createProcessingSubmission({
      id: "submission-user-processing",
      input: seedData.submissions.userProcessing,
      status: "processing",
      latestJob: processingJob,
    }),
    createProcessingSubmission({
      id: "submission-user-stopped",
      input: seedData.submissions.userStopped,
      status: "stopped",
      latestJob: stoppedJob,
      errorMessage: "Seeded stop",
    }),
    createProcessingSubmission({
      id: "submission-user-deleted",
      input: seedData.submissions.userDeleted,
      status: "deleted",
    }),
    createProcessingSubmission({
      id: "submission-user-failed",
      input: seedData.submissions.userFailed,
      status: "failed",
      latestJob: failedJob,
      errorMessage: "Seeded failed job log entry.",
    }),
  ];

  const duplicateReviews = [
    {
      id: "review-user-duplicate",
      submission_id: "submission-user-duplicate",
      submission_input: seedData.submissions.duplicateReview,
      input_value: seedData.submissions.duplicateReview,
      existing_book_title: "E2E Existing Duplicate Book",
      existing_book_slug: "e2e-existing-duplicate-book",
      existing_book_deleted: false,
      candidate_title: seedData.submissions.duplicateReview,
      status: "pending",
      created_at: "2026-04-14T00:00:00Z",
      updated_at: "2026-04-14T00:00:00Z",
    },
  ];

  const setSubmissionReady = (submissionId, jobId, input) => {
    const succeededJob = createProcessingJob({
      id: jobId,
      submissionId,
      input,
      status: "succeeded",
      submissionStatus: "ready",
      taskId: `task-${jobId}`,
    });
    jobs = jobs.map((job) => (job.id === jobId ? succeededJob : job));
    if (!jobs.some((job) => job.id === jobId)) {
      jobs = jobs.concat(succeededJob);
    }
    submissions = submissions.map((submission) =>
      submission.id === submissionId
        ? {
            ...submission,
            status: "ready",
            latest_job: { ...succeededJob },
            updated_at: "2026-04-14T00:10:00Z",
          }
        : submission,
    );
  };

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

  await page.route("**/api/ingestion/jobs/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (
      method === "POST" &&
      url.pathname.endsWith("/jobs/job-user-processing/stop/")
    ) {
      const stoppedProcessingJob = createProcessingJob({
        id: "job-user-processing",
        submissionId: "submission-user-processing",
        input: seedData.submissions.userProcessing,
        status: "stopped",
        lastError: "Stopped by test",
      });
      jobs = jobs.map((job) =>
        job.id === stoppedProcessingJob.id ? stoppedProcessingJob : job,
      );
      submissions = submissions.map((submission) =>
        submission.id === "submission-user-processing"
          ? {
              ...submission,
              status: "stopped",
              latest_job: { ...stoppedProcessingJob },
              error_message: "Stopped by test",
              updated_at: "2026-04-14T00:06:00Z",
            }
          : submission,
      );
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }

    if (
      method === "POST" &&
      url.pathname.endsWith("/jobs/job-user-stopped/resume/")
    ) {
      setSubmissionReady(
        "submission-user-stopped",
        "job-user-stopped",
        seedData.submissions.userStopped,
      );
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(jobs),
    });
  });

  await page.route("**/api/ingestion/submissions/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (
      method === "POST" &&
      url.pathname.endsWith("/submissions/submission-user-deleted/retry/")
    ) {
      setSubmissionReady(
        "submission-user-deleted",
        "job-user-deleted-retry",
        seedData.submissions.userDeleted,
      );
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }

    if (
      method === "POST" &&
      url.pathname.endsWith("/submissions/submission-user-stopped/retry/")
    ) {
      setSubmissionReady(
        "submission-user-stopped",
        "job-user-stopped",
        seedData.submissions.userStopped,
      );
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(submissions),
    });
  });

  await page.route("**/api/ingestion/duplicate-reviews/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(duplicateReviews),
    });
  });
}

async function mockCatalogBooksOverviewRoutes(page) {
  const processingJob = createProcessingJob({
    id: "job-curation-processing",
    submissionId: "submission-curation-processing",
    input: seedData.submissions.curationProcessing,
    status: "processing",
    origin: "curation",
    taskId: "task-curation-processing",
  });
  const jobs = [processingJob];
  const submissions = [
    createProcessingSubmission({
      id: "submission-curation-ready",
      input: seedData.submissions.curationReady,
      status: "ready",
      origin: "curation",
    }),
    createProcessingSubmission({
      id: "submission-curation-processing",
      input: seedData.submissions.curationProcessing,
      status: "processing",
      origin: "curation",
      latestJob: processingJob,
    }),
    createProcessingSubmission({
      id: "submission-curation-queued",
      input: seedData.submissions.curationQueued,
      status: "queued",
      origin: "curation",
    }),
    createProcessingSubmission({
      id: "submission-curation-stopped",
      input: seedData.submissions.curationStopped,
      status: "stopped",
      origin: "curation",
      errorMessage: "Seeded stop",
    }),
    createProcessingSubmission({
      id: "submission-curation-deleted",
      input: seedData.submissions.curationDeleted,
      status: "deleted",
      origin: "curation",
    }),
  ];
  const catalogEntries = [
    {
      id: "catalog-beta",
      title: seedData.catalogEntries.beta,
      author_line: "E2E Catalog Writer",
      categories: "E2E Fiction",
      source_url: "https://www.ebanglalibrary.com/books/e2e-beta-catalog-book/",
      curation_status: "new",
      local_book_slug: "",
      local_book_title: "",
      local_book_state: "",
      latest_submission_status: "",
      latest_job_status: "",
      latest_job_error: "",
      activity_at: "2026-04-14T00:02:00Z",
      updated_at: null,
      last_seen_at: "2026-04-14T00:02:00Z",
    },
    {
      id: "catalog-alpha",
      title: seedData.catalogEntries.alpha,
      author_line: "E2E Catalog Writer",
      categories: "E2E Fiction",
      source_url: "https://www.ebanglalibrary.com/books/e2e-alpha-catalog-book/",
      curation_status: "new",
      local_book_slug: "",
      local_book_title: "",
      local_book_state: "",
      latest_submission_status: "",
      latest_job_status: "",
      latest_job_error: "",
      activity_at: "2026-04-14T00:01:00Z",
      updated_at: null,
      last_seen_at: "2026-04-14T00:01:00Z",
    },
  ];

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

  await page.route("**/api/ingestion/jobs/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(jobs),
    });
  });

  await page.route("**/api/ingestion/submissions/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(submissions),
    });
  });

  await page.route("**/api/ingestion/duplicate-reviews/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/ingestion/catalog/curation-runs/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/ingestion/catalog/entries/**", async (route) => {
    const url = new URL(route.request().url());
    const sortedEntries =
      url.searchParams.get("sort") === "title_asc"
        ? [...catalogEntries].sort((first, second) =>
            first.title.localeCompare(second.title),
          )
        : catalogEntries;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createCatalogEntriesPayload(sortedEntries)),
    });
  });
}

function createDuplicateReview() {
  return {
    id: "review-user-duplicate",
    submission_id: "submission-user-duplicate",
    submission: {
      id: "submission-user-duplicate",
      original_input: seedData.submissions.duplicateReview,
      status: "duplicate",
    },
    submission_input: seedData.submissions.duplicateReview,
    input_value: seedData.submissions.duplicateReview,
    existing_book: {
      title: "E2E Existing Duplicate Book",
      slug: "e2e-existing-duplicate-book",
    },
    existing_book_title: "E2E Existing Duplicate Book",
    existing_book_slug: "e2e-existing-duplicate-book",
    existing_book_deleted: false,
    candidate_title: seedData.submissions.duplicateReview,
    status: "pending",
    created_at: "2026-04-14T00:00:00Z",
    updated_at: "2026-04-14T00:00:00Z",
  };
}

async function mockFailedRequestsRoutes(page) {
  const failedJob = createProcessingJob({
    id: "job-user-failed",
    submissionId: "submission-user-failed",
    input: seedData.submissions.userFailed,
    status: "failed",
    lastError: "Seeded failure for live-browser coverage.",
  });
  let jobs = [failedJob];
  const submissions = [
    createProcessingSubmission({
      id: "submission-user-failed",
      input: seedData.submissions.userFailed,
      status: "failed",
      latestJob: failedJob,
      errorMessage: "Seeded failure for live-browser coverage.",
    }),
  ];
  const duplicateReviews = [createDuplicateReview()];

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

  await page.route("**/api/ingestion/jobs/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (method === "POST" && url.pathname.endsWith("/jobs/bulk-delete/")) {
      jobs = [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ deleted_count: 1, skipped_active: 0 }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(jobs),
    });
  });

  await page.route("**/api/ingestion/submissions/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (
      method === "POST" &&
      url.pathname.endsWith("/submissions/bulk-delete/")
    ) {
      jobs = [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ deleted_count: 1, skipped_active: 0 }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(submissions),
    });
  });

  await page.route("**/api/ingestion/duplicate-reviews/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(duplicateReviews),
    });
  });
}

async function mockDuplicateRequestsRoutes(page) {
  let duplicateReviews = [createDuplicateReview()];
  let submissions = [];

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

  await page.route("**/api/ingestion/jobs/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/ingestion/submissions/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(submissions),
    });
  });

  await page.route("**/api/ingestion/duplicate-reviews/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (
      method === "POST" &&
      url.pathname.endsWith("/duplicate-reviews/review-user-duplicate/resolve/")
    ) {
      duplicateReviews = [];
      submissions = [
        createProcessingSubmission({
          id: "submission-user-duplicate",
          input: seedData.submissions.duplicateReview,
          status: "queued",
        }),
      ];
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(duplicateReviews),
    });
  });
}

async function mockIncompleteRoutes(page) {
  const incompleteEntry = {
    book_id: "book-incomplete",
    book_title: seedData.books.incomplete.title,
    book_slug: seedData.books.incomplete.slug,
    author_line: "E2E Writer",
    source_url: "https://www.ebanglalibrary.com/books/e2e-incomplete-catalog-book/",
    local_categories: "অসম্পূর্ণ বই",
    source_categories: "E2E Fiction",
    catalog_entry_id: "catalog-incomplete",
    removed_from_unfinished: false,
    latest_job_error: "",
  };
  const failedRun = {
    id: "run-incomplete-failed",
    trigger: "scheduled",
    mode: "pending",
    status: "failed",
    summary: {
      queued_creates: 2,
      queued_updates: 0,
      skipped_ready: 0,
    },
    last_error: "Seeded incomplete run failure.",
    requested_by_email: "superadmin@example.com",
    created_at: "2026-04-14T00:00:00Z",
    updated_at: "2026-04-14T00:05:00Z",
    started_at: "2026-04-14T00:00:00Z",
    finished_at: "2026-04-14T00:05:00Z",
  };

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

  await page.route("**/api/ingestion/jobs/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/ingestion/submissions/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/ingestion/duplicate-reviews/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/ingestion/catalog/curation-runs/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([failedRun]),
    });
  });

  await page.route("**/api/ingestion/catalog/incomplete-check/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (
      method === "POST" &&
      url.pathname.endsWith("/catalog/incomplete-check/create-books/")
    ) {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entries: [incompleteEntry],
        summary: {
          total_incomplete_books: 1,
          removed_from_unfinished: 0,
          still_in_unfinished: 1,
          missing_in_catalog: 0,
          queued: 0,
          processing: 0,
          failed: 0,
          stopped: 0,
        },
      }),
    });
  });
}

async function mockAutomationRoutes(page) {
  const processingJob = createProcessingJob({
    id: "job-automation-processing",
    submissionId: "submission-automation-processing",
    input: seedData.submissions.automationProcessing,
    status: "processing",
    origin: "automation",
    taskId: "task-automation-processing",
  });
  const jobs = [processingJob];
  const submissions = [
    createProcessingSubmission({
      id: "submission-automation-pending",
      input: seedData.submissions.automationPending,
      status: "pending_resolution",
      origin: "automation",
    }),
    createProcessingSubmission({
      id: "submission-automation-ready",
      input: seedData.submissions.automationReady,
      status: "ready",
      origin: "automation",
    }),
    createProcessingSubmission({
      id: "submission-automation-processing",
      input: seedData.submissions.automationProcessing,
      status: "processing",
      origin: "automation",
      latestJob: processingJob,
    }),
    createProcessingSubmission({
      id: "submission-automation-queued",
      input: seedData.submissions.automationQueued,
      status: "queued",
      origin: "automation",
    }),
    createProcessingSubmission({
      id: "submission-automation-stopped",
      input: seedData.submissions.automationStopped,
      status: "stopped",
      origin: "automation",
      errorMessage: "Seeded stop",
    }),
    createProcessingSubmission({
      id: "submission-automation-deleted",
      input: seedData.submissions.automationDeleted,
      status: "deleted",
      origin: "automation",
    }),
  ];
  let automationSettings = {
    enabled: false,
    daily_run_time: "02:00:00",
    frequency: "daily",
    mode: "pending",
    refresh_max_pages: 80,
    next_run_at: null,
  };
  const scheduledRun = {
    id: "run-automation-active",
    trigger: "scheduled",
    mode: "pending",
    status: "processing",
    summary: {
      queued_creates: 7,
      queued_updates: 0,
      skipped_ready: 0,
    },
    last_error: "",
    requested_by_email: "superadmin@example.com",
    created_at: "2026-04-14T00:00:00Z",
    updated_at: "2026-04-14T00:03:00Z",
    started_at: "2026-04-14T00:00:00Z",
    finished_at: null,
  };

  const automationPayload = () => ({
    settings: automationSettings,
    latest_run: scheduledRun,
  });

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

  await page.route("**/api/ingestion/jobs/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(jobs),
    });
  });

  await page.route("**/api/ingestion/submissions/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(submissions),
    });
  });

  await page.route("**/api/ingestion/duplicate-reviews/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/ingestion/catalog/curation-runs/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([scheduledRun]),
    });
  });

  await page.route("**/api/ingestion/catalog/automation**", async (route) => {
    if (route.request().method() === "PATCH") {
      let body = {};
      try {
        body = JSON.parse(route.request().postData() || "{}");
      } catch {
        body = {};
      }
      automationSettings = {
        ...automationSettings,
        ...body,
        daily_run_time: body.daily_run_time
          ? `${body.daily_run_time}:00`
          : automationSettings.daily_run_time,
      };
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(automationPayload()),
    });
  });
}

test.describe("Processing Pages", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/home");
    await page.evaluate(() => {
      window.sessionStorage.removeItem("processing.persistent-page-state");
    });
    await page.goto("/home");
    await expect(
      page.getByRole("heading", { name: "All Books" }),
    ).toBeVisible({ timeout: 15_000 });
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
    await mockMyRequestsRoutes(page);

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
    await mockMyRequestsRoutes(page);

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
    await mockCatalogBooksOverviewRoutes(page);

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

  test("catalog book creation keeps loading and selection disabled until tracked rows finish", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);
    let catalogCreatePhase = "idle";

    const entryBase = {
      id: "tracked-catalog-entry",
      title: seedData.catalogEntries.alpha,
      author_line: "E2E Catalog Writer",
      categories: "E2E Fiction",
      source_url: "https://www.ebanglalibrary.com/books/e2e-alpha-catalog-book/",
      local_book_slug: "",
      local_book_title: "",
      local_book_state: "",
      activity_at: "2026-04-14T00:00:00Z",
      updated_at: null,
      last_seen_at: "2026-04-14T00:00:00Z",
    };

    function currentCatalogEntry() {
      if (catalogCreatePhase === "processing") {
        return {
          ...entryBase,
          curation_status: "processing",
          latest_submission_status: "processing",
          latest_job_status: "processing",
          latest_job_error: "",
        };
      }

      if (catalogCreatePhase === "failed") {
        return {
          ...entryBase,
          curation_status: "failed",
          latest_submission_status: "failed",
          latest_job_status: "failed",
          latest_job_error: "Seeded catalog creation failure.",
        };
      }

      return {
        ...entryBase,
        curation_status: "new",
        latest_submission_status: "",
        latest_job_status: "",
        latest_job_error: "",
      };
    }

    await page.route("**/api/ingestion/catalog/entries/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createCatalogEntriesPayload(currentCatalogEntry())),
      });
    });

    await page.route("**/api/ingestion/jobs/**", async (route) => {
      const jobs =
        catalogCreatePhase === "processing"
          ? [
              {
                id: "tracked-job",
                submission_id: "tracked-submission",
                job_type: "create",
                status: "processing",
                task_id: "tracked-task",
                queue_name: "celery",
                retry_count: 0,
                cancel_requested: false,
                submission_origin: "curation",
                submission_input: entryBase.source_url,
                submission_status: "processing",
                submission_resolution_status: "resolved",
                target_book_slug: "",
                target_book_title: "",
                target_book_deleted: false,
                last_error: "",
                created_at: "2026-04-14T00:00:00Z",
                updated_at: "2026-04-14T00:00:00Z",
                started_at: "2026-04-14T00:00:00Z",
                finished_at: null,
              },
            ]
          : [];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(jobs),
      });
    });

    await page.route(
      "**/api/ingestion/catalog/entries/create-books/",
      async (route) => {
        catalogCreatePhase = "processing";
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            queued_creates: 1,
            queued_updates: 0,
            skipped_ready: 0,
            skipped_processing: 0,
            skipped_deleted: 0,
            skipped_missing: 0,
            errors: [],
          }),
        });
      },
    );

    await processingPage.goto("/processing-catalog-books", "Catalog");
    await expect(
      processingPage.rowInCard("Catalog Books", seedData.catalogEntries.alpha),
    ).toBeVisible();

    await processingPage.catalogRowCheckbox(seedData.catalogEntries.alpha).check();
    await processingPage.catalogCreateSelectedButton().click();

    await expect(
      processingPage.catalogRowCheckbox(seedData.catalogEntries.alpha),
    ).toBeDisabled();
    await expect(
      processingPage
        .rowInCard("Catalog Books", seedData.catalogEntries.alpha)
        .getByRole("button", { name: "Processing..." }),
    ).toBeVisible();

    await processingPage.goto("/processing-my-requests", "My Requests");
    await processingPage.goto("/processing-catalog-books", "Catalog");

    await expect(
      processingPage.catalogRowCheckbox(seedData.catalogEntries.alpha),
    ).toBeDisabled();
    await expect(
      processingPage
        .rowInCard("Catalog Books", seedData.catalogEntries.alpha)
        .getByRole("button", { name: "Processing..." }),
    ).toBeVisible();

    catalogCreatePhase = "failed";
    await page.reload();

    await expect(
      processingPage.catalogRowCheckbox(seedData.catalogEntries.alpha),
    ).toBeEnabled();
    await expect(
      processingPage
        .rowInCard("Catalog Books", seedData.catalogEntries.alpha)
        .getByRole("button", { name: "Create" }),
    ).toBeVisible();
  });

  test("catalog sync control switches to an active state immediately", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);
    let syncState = null;
    let syncActive = false;
    const syncCatalogEntry = {
      id: "catalog-sync-entry",
      title: seedData.catalogEntries.alpha,
      author_line: "E2E Catalog Writer",
      categories: "E2E Fiction",
      source_url: "https://www.ebanglalibrary.com/books/e2e-alpha-catalog-book/",
      curation_status: "new",
      local_book_slug: "",
      local_book_title: "",
      local_book_state: "",
      latest_submission_status: "",
      latest_job_status: "",
      latest_job_error: "",
      activity_at: "2026-04-14T00:00:00Z",
      updated_at: null,
      last_seen_at: "2026-04-14T00:00:00Z",
    };

    await page.route("**/api/ingestion/activity/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          can_manage_processing: true,
          has_visible_activity: syncActive,
          active_scopes: syncActive ? ["catalog_refresh"] : [],
        }),
      });
    });

    await page.route("**/api/ingestion/catalog/entries/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createCatalogEntriesPayload(syncCatalogEntry, {
            sync_state: syncState,
          }),
        ),
      });
    });

    await page.route("**/api/ingestion/catalog/refresh**", async (route) => {
      syncActive = true;
      syncState = createCatalogSyncState();
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify(syncState),
      });
    });

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
    await expect(
      processingPage.catalogSyncStatus().locator(".loading-spinner"),
    ).toBeVisible();
  });

  test("automation keeps run history collapsible with the expanded card first and preserves saved settings", async ({
    page,
  }) => {
    await mockAutomationRoutes(page);

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
    await mockFailedRequestsRoutes(page);

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
    await mockDuplicateRequestsRoutes(page);

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
    await mockIncompleteRoutes(page);

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

  test("catalog page live actions stop, resume, requeue, and delete through the visible cards", async ({
    page,
  }) => {
    const processingPage = new ProcessingPageModel(page);
    const processingSubmissionId = "submission-processing";
    const processingJobId = "job-processing";
    const stoppedSubmissionId = "submission-stopped";
    const stoppedJobId = "job-stopped";
    const deletedSubmissionId = "submission-deleted";
    const deletedQueuedJobId = "job-deleted-queued";
    const catalogEntryId = "catalog-entry-beta";

    let jobs = [
      {
        id: processingJobId,
        submission_id: processingSubmissionId,
        job_type: "create",
        status: "processing",
        task_id: "task-processing",
        queue_name: "celery",
        retry_count: 0,
        cancel_requested: false,
        submission_origin: "curation",
        submission_input: seedData.submissions.curationProcessing,
        submission_status: "processing",
        submission_resolution_status: "resolved",
        target_book_slug: "",
        target_book_title: "",
        target_book_deleted: false,
        last_error: "",
        created_at: "2026-04-14T00:00:00Z",
        updated_at: "2026-04-14T00:00:00Z",
        started_at: "2026-04-14T00:00:00Z",
        finished_at: null,
      },
      {
        id: stoppedJobId,
        submission_id: stoppedSubmissionId,
        job_type: "create",
        status: "stopped",
        task_id: "",
        queue_name: "celery",
        retry_count: 0,
        cancel_requested: false,
        submission_origin: "curation",
        submission_input: seedData.submissions.curationStopped,
        submission_status: "stopped",
        submission_resolution_status: "resolved",
        target_book_slug: "",
        target_book_title: "",
        target_book_deleted: false,
        last_error: "Seeded stop",
        created_at: "2026-04-14T00:00:00Z",
        updated_at: "2026-04-14T00:00:00Z",
        started_at: "2026-04-14T00:00:00Z",
        finished_at: "2026-04-14T00:05:00Z",
      },
    ];
    let submissions = [
      {
        id: processingSubmissionId,
        input_type: "url",
        origin: "curation",
        original_input: seedData.submissions.curationProcessing,
        resolved_url: "https://www.ebanglalibrary.com/books/curation-processing/",
        resolution_status: "resolved",
        resolution_confidence: 1,
        status: "processing",
        review_state: "",
        error_message: "",
        linked_book_slug: "",
        linked_book: "",
        linked_book_deleted: false,
        served_from_database: false,
        canonical_submission_id: "",
        uses_existing_request: false,
        candidates: [],
        latest_job: { ...jobs[0] },
        created_at: "2026-04-14T00:00:00Z",
        updated_at: "2026-04-14T00:00:00Z",
      },
      {
        id: stoppedSubmissionId,
        input_type: "url",
        origin: "curation",
        original_input: seedData.submissions.curationStopped,
        resolved_url: "https://www.ebanglalibrary.com/books/curation-stopped/",
        resolution_status: "resolved",
        resolution_confidence: 1,
        status: "stopped",
        review_state: "",
        error_message: "Seeded stop",
        linked_book_slug: "",
        linked_book: "",
        linked_book_deleted: false,
        served_from_database: false,
        canonical_submission_id: "",
        uses_existing_request: false,
        candidates: [],
        latest_job: { ...jobs[1] },
        created_at: "2026-04-14T00:00:00Z",
        updated_at: "2026-04-14T00:00:00Z",
      },
      {
        id: deletedSubmissionId,
        input_type: "url",
        origin: "curation",
        original_input: seedData.submissions.curationDeleted,
        resolved_url: "https://www.ebanglalibrary.com/books/curation-deleted/",
        resolution_status: "resolved",
        resolution_confidence: 1,
        status: "deleted",
        review_state: "",
        error_message: "",
        linked_book_slug: "",
        linked_book: "",
        linked_book_deleted: false,
        served_from_database: false,
        canonical_submission_id: "",
        uses_existing_request: false,
        candidates: [],
        latest_job: null,
        created_at: "2026-04-14T00:00:00Z",
        updated_at: "2026-04-14T00:00:00Z",
      },
    ];
    let catalogEntries = [
      {
        id: catalogEntryId,
        title: seedData.catalogEntries.beta,
        author_line: "E2E Catalog Writer",
        categories: "E2E Fiction",
        source_url: "https://www.ebanglalibrary.com/books/e2e-beta-catalog-book/",
        curation_status: "new",
        local_book_slug: "",
        local_book_title: "",
        local_book_state: "",
        latest_submission_status: "",
        latest_job_status: "",
        latest_job_error: "",
        activity_at: "2026-04-14T00:00:00Z",
        updated_at: null,
        last_seen_at: "2026-04-14T00:00:00Z",
      },
    ];

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

    await page.route("**/api/ingestion/submissions/**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();

      if (
        method === "POST" &&
        url.pathname.endsWith(`/submissions/${stoppedSubmissionId}/retry/`)
      ) {
        jobs = jobs.map((job) =>
          job.id === stoppedJobId
            ? {
                ...job,
                status: "queued",
                task_id: "task-stopped-queued",
                submission_status: "queued",
                finished_at: null,
              }
            : job,
        );
        const queuedJob = jobs.find((job) => job.id === stoppedJobId);
        submissions = submissions.map((submission) =>
          submission.id === stoppedSubmissionId
            ? {
                ...submission,
                status: "queued",
                latest_job: { ...queuedJob },
                updated_at: "2026-04-14T00:06:00Z",
              }
            : submission,
        );
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({}),
        });
        return;
      }

      if (
        method === "POST" &&
        url.pathname.endsWith(`/submissions/${deletedSubmissionId}/retry/`)
      ) {
        const queuedJob = {
          id: deletedQueuedJobId,
          submission_id: deletedSubmissionId,
          job_type: "create",
          status: "queued",
          task_id: "task-deleted-queued",
          queue_name: "celery",
          retry_count: 0,
          cancel_requested: false,
          submission_origin: "curation",
          submission_input: seedData.submissions.curationDeleted,
          submission_status: "queued",
          submission_resolution_status: "resolved",
          target_book_slug: "",
          target_book_title: "",
          target_book_deleted: false,
          last_error: "",
          created_at: "2026-04-14T00:00:00Z",
          updated_at: "2026-04-14T00:00:00Z",
          started_at: null,
          finished_at: null,
        };
        jobs = jobs.concat(queuedJob);
        submissions = submissions.map((submission) =>
          submission.id === deletedSubmissionId
            ? {
                ...submission,
                status: "queued",
                latest_job: { ...queuedJob },
                updated_at: "2026-04-14T00:10:00Z",
              }
            : submission,
        );
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({}),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(submissions),
      });
    });

    await page.route("**/api/ingestion/jobs/**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();

      if (
        method === "POST" &&
        url.pathname.endsWith(`/jobs/${processingJobId}/stop/`)
      ) {
        jobs = jobs.map((job) =>
          job.id === processingJobId
            ? {
                ...job,
                status: "stopped",
                task_id: "",
                submission_status: "stopped",
                finished_at: "2026-04-14T00:05:00Z",
              }
            : job,
        );
        const stoppedJob = jobs.find((job) => job.id === processingJobId);
        submissions = submissions.map((submission) =>
          submission.id === processingSubmissionId
            ? {
                ...submission,
                status: "stopped",
                latest_job: { ...stoppedJob },
                updated_at: "2026-04-14T00:05:00Z",
              }
            : submission,
        );
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({}),
        });
        return;
      }

      if (
        method === "POST" &&
        url.pathname.endsWith(`/jobs/${stoppedJobId}/resume/`)
      ) {
        jobs = jobs.map((job) =>
          job.id === stoppedJobId
            ? {
                ...job,
                status: "queued",
                task_id: "task-stopped-queued",
                submission_status: "queued",
                finished_at: null,
              }
            : job,
        );
        const queuedJob = jobs.find((job) => job.id === stoppedJobId);
        submissions = submissions.map((submission) =>
          submission.id === stoppedSubmissionId
            ? {
                ...submission,
                status: "queued",
                latest_job: { ...queuedJob },
                updated_at: "2026-04-14T00:06:00Z",
              }
            : submission,
        );
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({}),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(jobs),
      });
    });

    await page.route("**/api/ingestion/duplicate-reviews/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    await page.route("**/api/ingestion/catalog/entries/**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();

      if (
        method === "DELETE" &&
        url.pathname.endsWith(`/catalog/entries/${catalogEntryId}/`)
      ) {
        catalogEntries = catalogEntries.filter((entry) => entry.id !== catalogEntryId);
        await route.fulfill({
          status: 204,
          contentType: "application/json",
          body: "",
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createCatalogEntriesPayload(catalogEntries)),
      });
    });

    await processingPage.goto("/processing-catalog-books", "Catalog");

    await expect(
      processingPage.rowInCard("Processing", seedData.submissions.curationProcessing),
    ).toBeVisible();
    await processingPage
      .rowActionButton("Processing", seedData.submissions.curationProcessing, "Stop")
      .click();
    await expect(page.getByText("Book creation stopped.")).toBeVisible();
    await expect(
      processingPage.rowInCard("Processing", seedData.submissions.curationProcessing),
    ).toHaveCount(0);
    await processingPage.expandCard("Stopped");
    await expect(
      processingPage.rowInCard("Stopped", seedData.submissions.curationProcessing),
    ).toBeVisible();

    await expect(
      processingPage.rowInCard("Stopped", seedData.submissions.curationStopped),
    ).toBeVisible();
    await processingPage
      .rowActionButton("Stopped", seedData.submissions.curationStopped, "Resume")
      .click();
    await expect(page.getByText("Request queued.")).toBeVisible();
    await expect(
      processingPage.rowInCard("Stopped", seedData.submissions.curationStopped),
    ).toHaveCount(0);
    await processingPage.expandCard("Queued");
    await expect(
      processingPage.rowInCard("Queued", seedData.submissions.curationStopped),
    ).toBeVisible();

    await processingPage.expandCard("Deleted");
    await expect(
      processingPage.rowInCard("Deleted", seedData.submissions.curationDeleted),
    ).toBeVisible();
    await processingPage
      .rowActionButton("Deleted", seedData.submissions.curationDeleted, "Add Again to Queue")
      .click();
    await expect(page.getByText("Request queued.")).toBeVisible();
    await expect(
      processingPage.rowInCard("Deleted", seedData.submissions.curationDeleted),
    ).toHaveCount(0);
    await expect(
      processingPage.rowInCard("Queued", seedData.submissions.curationDeleted),
    ).toBeVisible();

    const catalogRow = processingPage.rowInCard(
      "Catalog Books",
      seedData.catalogEntries.beta,
    );
    await expect(catalogRow).toBeVisible();
    await catalogRow.getByRole("button", { name: "Delete" }).click();
    await processingPage.confirmDialog();
    await expect(page.getByText("Catalog row deleted.")).toBeVisible();
    await expect(
      processingPage.rowInCard("Catalog Books", seedData.catalogEntries.beta),
    ).toHaveCount(0);
  });
});
