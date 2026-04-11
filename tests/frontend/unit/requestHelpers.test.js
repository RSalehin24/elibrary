import assert from "node:assert/strict";
import test from "node:test";

import {
  filterJobsByControls,
  getRequestPrimaryText,
  getRequestSecondaryText,
} from "../../../app/frontend/src/features/processing/helpers/request.js";

test("request helpers present readable labels for source urls", () => {
  assert.equal(
    getRequestPrimaryText(
      "https://www.ebanglalibrary.com/books/%E0%A6%86%E0%A6%AE%E0%A6%BE%E0%A6%B0-%E0%A6%AC%E0%A6%87/",
    ),
    "আমার বই",
  );
  assert.equal(
    getRequestSecondaryText(
      "https://www.ebanglalibrary.com/books/%E0%A6%86%E0%A6%AE%E0%A6%BE%E0%A6%B0-%E0%A6%AC%E0%A6%87/",
    ),
    "ebanglalibrary.com/books/আমার-বই/",
  );
});

test("filterJobsByControls matches status, job type, request text, and errors", () => {
  const jobs = [
    {
      id: "job-1",
      status: "processing",
      job_type: "ingestion",
      submission_input: "https://example.com/books/alpha-book/",
      last_error: "",
    },
    {
      id: "job-2",
      status: "failed",
      job_type: "reprocess",
      submission_input: "Manual title",
      last_error: "network timeout",
    },
  ];

  assert.deepEqual(
    filterJobsByControls(jobs, {
      q: "alpha book",
      status: "processing",
      job_type: "ingestion",
    }).map((job) => job.id),
    ["job-1"],
  );

  assert.deepEqual(
    filterJobsByControls(jobs, {
      q: "timeout",
      status: "failed",
      job_type: "reprocess",
    }).map((job) => job.id),
    ["job-2"],
  );
});
