import { routeJson } from "./appMocks.js";

function searchValue(url, key) {
  return new URL(url).searchParams.get(key) || "";
}

function filterSubmissions(submissions, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return submissions;
  }
  return submissions.filter((submission) =>
    String(submission.original_input || "")
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

function filterCatalogEntries(entries, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return entries;
  }
  return entries.filter((entry) =>
    [entry.title, entry.author_line, entry.categories]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedQuery)),
  );
}

function filterIncompleteEntries(entries, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return entries;
  }
  return entries.filter((entry) =>
    [entry.book_title, entry.author_line, entry.source_categories]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedQuery)),
  );
}

function buildCatalogSummary(entries) {
  return entries.reduce(
    (summary, entry) => {
      summary.total += 1;
      const status = entry.curation_status || "new";
      if (Object.hasOwn(summary, status)) {
        summary[status] += 1;
      }
      return summary;
    },
    {
      total: 0,
      new: 0,
      queued: 0,
      processing: 0,
      stopped: 0,
      requeued: 0,
      unfinished: 0,
      failed: 0,
      ready: 0,
      deleted: 0,
    },
  );
}

function buildIncompleteSummary(entries) {
  return entries.reduce(
    (summary, entry) => {
      summary.total_incomplete_books += 1;
      if (entry.removed_from_unfinished) {
        summary.removed_from_unfinished += 1;
        return summary;
      }
      if (entry.catalog_entry_id) {
        summary.still_in_unfinished += 1;
      } else {
        summary.missing_in_catalog += 1;
      }

      const status = entry.latest_job_status || "failed";
      if (Object.hasOwn(summary, status)) {
        summary[status] += 1;
      }
      return summary;
    },
    {
      total_incomplete_books: 0,
      removed_from_unfinished: 0,
      still_in_unfinished: 0,
      missing_in_catalog: 0,
      queued: 0,
      processing: 0,
      failed: 0,
      stopped: 0,
      requeued: 0,
    },
  );
}

function normalizeAutomationPayload(payload) {
  return {
    ...payload,
    daily_run_time: `${payload.daily_run_time || "02:00"}:00`,
  };
}

export async function mockProcessingApi(page) {
  const state = {
    automationUpdateCalls: [],
    catalogCreateCalls: [],
    catalogQueries: [],
    incompleteCreateCalls: [],
    incompleteQueries: [],
    submissionQueries: [],
    submissions: [
      {
        id: "submission-1",
        input_type: "title",
        original_input: "Alpha Book",
        status: "ready",
        resolution_status: "resolved",
        linked_book_slug: "alpha-book",
        linked_book_deleted: false,
        linked_book: { title: "Alpha Book" },
        latest_job: {
          id: "job-1",
          status: "succeeded",
          task_id: "job-task-1",
          last_error: "",
          updated_at: "2026-04-11T00:00:00Z",
        },
        updated_at: "2026-04-11T00:00:00Z",
        created_at: "2026-04-10T00:00:00Z",
        error_message: "",
      },
      {
        id: "submission-2",
        input_type: "title",
        original_input: "Beta Book",
        status: "failed",
        resolution_status: "resolved",
        linked_book_slug: "",
        linked_book_deleted: false,
        linked_book: null,
        latest_job: {
          id: "job-2",
          status: "failed",
          task_id: "job-task-2",
          last_error: "Needs retry",
          updated_at: "2026-04-11T01:00:00Z",
        },
        updated_at: "2026-04-11T01:00:00Z",
        created_at: "2026-04-10T01:00:00Z",
        error_message: "Needs retry",
      },
    ],
    jobs: [
      {
        id: "job-1",
        submission_id: "submission-1",
        submission_input: "Alpha Book",
        status: "succeeded",
        job_type: "ingestion",
        target_book_slug: "alpha-book",
        target_book_deleted: false,
        last_error: "",
        task_id: "job-task-1",
        updated_at: "2026-04-11T00:00:00Z",
        created_at: "2026-04-10T00:00:00Z",
      },
      {
        id: "job-2",
        submission_id: "submission-2",
        submission_input: "Beta Book",
        status: "failed",
        job_type: "ingestion",
        target_book_slug: "",
        target_book_deleted: false,
        last_error: "Needs retry",
        task_id: "job-task-2",
        updated_at: "2026-04-11T01:00:00Z",
        created_at: "2026-04-10T01:00:00Z",
      },
    ],
    catalogEntries: [
      {
        id: "catalog-entry-1",
        title: "Alpha Catalog Book",
        author_line: "Author A",
        categories: "Poetry",
        curation_status: "new",
        local_book_slug: "",
        local_book_title: "",
        latest_job_error: "",
        created_at: "2026-04-10T04:00:00Z",
        updated_at: "2026-04-11T04:00:00Z",
      },
      {
        id: "catalog-entry-2",
        title: "Beta Catalog Book",
        author_line: "Author B",
        categories: "Novel",
        curation_status: "ready",
        local_book_slug: "beta-book",
        local_book_title: "Beta Book",
        latest_job_error: "",
        created_at: "2026-04-10T05:00:00Z",
        updated_at: "2026-04-11T05:00:00Z",
      },
    ],
    incompleteEntries: [
      {
        book_id: "book-1",
        book_title: "Missing Category Book",
        book_slug: "missing-category-book",
        author_line: "Writer One",
        source_url: "https://example.com/missing-category-book",
        source_categories: "History",
        local_categories: "",
        latest_job_error: "Needs reprocessing",
        latest_job_status: "failed",
        removed_from_unfinished: false,
        catalog_entry_id: null,
        updated_at: "2026-04-11T03:00:00Z",
      },
      {
        book_id: "book-2",
        book_title: "Queued Category Book",
        book_slug: "queued-category-book",
        author_line: "Writer Two",
        source_url: "https://example.com/queued-category-book",
        source_categories: "Science",
        local_categories: "Science",
        latest_job_error: "",
        latest_job_status: "queued",
        removed_from_unfinished: false,
        catalog_entry_id: "catalog-entry-3",
        updated_at: "2026-04-11T03:30:00Z",
      },
    ],
    runs: [
      {
        id: "run-1",
        trigger: "scheduled",
        mode: "pending",
        status: "succeeded",
        summary: {
          queued_creates: 2,
          queued_updates: 1,
          skipped_ready: 4,
        },
        last_error: "",
        updated_at: "2026-04-11T02:30:00Z",
        created_at: "2026-04-11T02:00:00Z",
      },
    ],
    automation: {
      settings: {
        enabled: false,
        daily_run_time: "02:00:00",
        frequency: "daily",
        mode: "pending",
        refresh_max_pages: 80,
        next_run_at: "2026-04-12T02:00:00Z",
      },
    },
  };

  await page.route(/.*\/api\/ingestion\/submissions\/.*$/, async (route) => {
    const query = searchValue(route.request().url(), "q");
    state.submissionQueries.push(query);
    await routeJson(route, filterSubmissions(state.submissions, query));
  });

  await page.route(/.*\/api\/ingestion\/jobs\/(?![^?]*\/logs\/).*$/, async (route) => {
    await routeJson(route, state.jobs);
  });

  await page.route(/.*\/api\/ingestion\/duplicate-reviews\/.*$/, async (route) => {
    await routeJson(route, []);
  });

  await page.route(
    "**/api/ingestion/catalog/entries/create-books/",
    async (route) => {
      const payload = route.request().postDataJSON();
      state.catalogCreateCalls.push(payload.ids || []);
      state.catalogEntries = state.catalogEntries.map((entry) =>
        (payload.ids || []).includes(entry.id)
          ? { ...entry, curation_status: "queued" }
          : entry,
      );
      await routeJson(route, {
        queued_updates: (payload.ids || []).length,
        skipped_processing: 0,
      });
    },
  );

  await page.route(
    "**/api/ingestion/catalog/incomplete-check/create-books/",
    async (route) => {
      const payload = route.request().postDataJSON();
      state.incompleteCreateCalls.push(payload.ids || []);
      state.incompleteEntries = state.incompleteEntries.filter(
        (entry) => !(payload.ids || []).includes(entry.book_id),
      );
      await routeJson(route, {
        queued_updates: (payload.ids || []).length,
        skipped_processing: 0,
      });
    },
  );

  await page.route(
    /.*\/api\/ingestion\/catalog\/entries\/(?!create-books\/).*$/,
    async (route) => {
    const query = searchValue(route.request().url(), "q");
    state.catalogQueries.push(query);
    const entries = filterCatalogEntries(state.catalogEntries, query);
    await routeJson(route, {
      entries,
      pagination: {
        page: 1,
        limit: 180,
        total_count: entries.length,
        page_count: 1,
        has_previous: false,
        has_next: false,
      },
      summary: buildCatalogSummary(state.catalogEntries),
      sync_state: null,
    });
    },
  );

  await page.route(
    /.*\/api\/ingestion\/catalog\/incomplete-check\/(?!create-books\/).*$/,
    async (route) => {
      const query = searchValue(route.request().url(), "q");
      state.incompleteQueries.push(query);
      const entries = filterIncompleteEntries(state.incompleteEntries, query);
      await routeJson(route, {
        entries,
        summary: buildIncompleteSummary(state.incompleteEntries),
      });
    },
  );

  await page.route(/.*\/api\/ingestion\/catalog\/curation-runs\/.*$/, async (route) => {
    await routeJson(route, state.runs);
  });

  await page.route("**/api/ingestion/catalog/automation/", async (route) => {
    if (route.request().method() === "GET") {
      await routeJson(route, state.automation);
      return;
    }

    const payload = route.request().postDataJSON();
    state.automationUpdateCalls.push(payload);
    state.automation = {
      settings: {
        ...state.automation.settings,
        ...normalizeAutomationPayload(payload),
        next_run_at: "2026-04-12T04:30:00Z",
      },
    };
    await routeJson(route, state.automation);
  });

  await page.route(/.*\/api\/ingestion\/jobs\/[^/]+\/logs\/$/, async (route) => {
    await routeJson(route, []);
  });

  return state;
}
