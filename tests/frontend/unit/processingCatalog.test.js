import assert from "node:assert/strict";
import test from "node:test";

import {
  hasActiveCatalogCreationWork,
  isCatalogEntryCreatePending,
  resolvePendingCatalogCreationEntries,
} from "../../../app/frontend/src/features/processing/helpers/catalog.js";

test("isCatalogEntryCreatePending treats processing snapshots as active work", () => {
  assert.equal(
    isCatalogEntryCreatePending({
      curation_status: "processing",
      latest_job_status: "",
      latest_submission_status: "",
    }),
    true,
  );

  assert.equal(
    isCatalogEntryCreatePending({
      curation_status: "failed",
      latest_job_status: "failed",
      latest_submission_status: "duplicate",
    }),
    false,
  );

  assert.equal(
    isCatalogEntryCreatePending({
      curation_status: "queued",
      latest_job_status: "",
      latest_submission_status: "",
    }),
    true,
  );
});

test("resolvePendingCatalogCreationEntries keeps tracked rows active from catalog snapshots or active jobs", () => {
  const pendingEntries = resolvePendingCatalogCreationEntries(
    [
      {
        id: "visible-processing",
        source_url: "https://www.ebanglalibrary.com/books/visible-processing/",
      },
      {
        id: "hidden-processing",
        source_url: "https://www.ebanglalibrary.com/books/hidden-processing/",
      },
      {
        id: "finished",
        source_url: "https://www.ebanglalibrary.com/books/finished/",
      },
    ],
    {
      catalogEntries: [
        {
          id: "visible-processing",
          curation_status: "processing",
          latest_job_status: "processing",
          latest_submission_status: "processing",
        },
        {
          id: "finished",
          curation_status: "ready",
          latest_job_status: "succeeded",
          latest_submission_status: "ready",
        },
      ],
      catalogOverviewEntries: [],
      jobs: [
        {
          id: "job-hidden-processing",
          status: "queued",
          submission_input:
            "https://www.ebanglalibrary.com/books/hidden-processing/",
        },
      ],
    },
  );

  assert.deepEqual(
    pendingEntries.map((entry) => entry.id),
    ["visible-processing", "hidden-processing"],
  );
});

test("hasActiveCatalogCreationWork detects active catalog jobs and submissions", () => {
  assert.equal(
    hasActiveCatalogCreationWork({
      submissions: [{ id: "ready", status: "ready" }],
      jobs: [{ id: "done", status: "succeeded" }],
      catalogEntries: [{ id: "done-entry", curation_status: "ready" }],
    }),
    false,
  );

  assert.equal(
    hasActiveCatalogCreationWork({
      submissions: [{ id: "queued-submission", status: "queued" }],
    }),
    true,
  );

  assert.equal(
    hasActiveCatalogCreationWork({
      jobs: [{ id: "queued-job", status: "queued" }],
    }),
    true,
  );
});
