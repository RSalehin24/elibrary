import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSubmissionOverviewSummary,
  orderExpandableCards,
} from "../../../app/frontend/src/features/processing/helpers/summary.js";
import {
  filterCurrentFailedJobs,
  getSubmissionDisplayStatus,
  partitionSubmissionsForCards,
} from "../../../app/frontend/src/features/processing/helpers/request.js";

test("buildSubmissionOverviewSummary counts deleted requests", () => {
  const summary = buildSubmissionOverviewSummary([
    { status: "queued" },
    { status: "deleted" },
    { status: "deleted" },
    { status: "ready" },
  ]);

  assert.equal(summary.total, 4);
  assert.equal(summary.queued, 1);
  assert.equal(summary.deleted, 2);
  assert.equal(summary.ready, 1);
});

test("orderExpandableCards moves expanded cards ahead of collapsed ones", () => {
  const ordered = orderExpandableCards([
    { key: "stopped", expanded: false },
    { key: "queued", expanded: true },
    { key: "deleted", expanded: false },
  ]);

  assert.deepEqual(
    ordered.map((card) => card.key),
    ["queued", "stopped", "deleted"],
  );
});

test("orderExpandableCards prioritizes the most recently expanded card", () => {
  const ordered = orderExpandableCards(
    [
      { key: "stopped", expanded: true },
      { key: "queued", expanded: true },
      { key: "deleted", expanded: false },
      { key: "run-history", expanded: true },
    ],
    "run-history",
  );

  assert.deepEqual(
    ordered.map((card) => card.key),
    ["run-history", "stopped", "queued", "deleted"],
  );
});

test("getSubmissionDisplayStatus prioritizes failed jobs and queued jobs over stale submission status", () => {
  const failedSubmissionIdSet = new Set(["failed-1"]);

  assert.equal(
    getSubmissionDisplayStatus(
      {
        id: "failed-1",
        status: "ready",
        latest_job: { status: "succeeded" },
      },
      failedSubmissionIdSet,
    ),
    "failed",
  );

  assert.equal(
    getSubmissionDisplayStatus({
      id: "queued-1",
      status: "ready",
      latest_job: { status: "queued" },
    }),
    "queued",
  );

  assert.equal(
    getSubmissionDisplayStatus({
      id: "deleted-1",
      status: "deleted",
      latest_job: { status: "failed" },
    }),
    "deleted",
  );
});

test("filterCurrentFailedJobs excludes resolved failed job history", () => {
  const failedJobs = filterCurrentFailedJobs([
    { id: "current-failed", status: "failed", submission_status: "failed" },
    { id: "retried", status: "failed", submission_status: "queued" },
    { id: "deleted", status: "failed", submission_status: "deleted" },
    { id: "processing", status: "processing", submission_status: "processing" },
  ]);

  assert.deepEqual(
    failedJobs.map((job) => job.id),
    ["current-failed"],
  );
});

test("partitionSubmissionsForCards keeps requests in a single display bucket", () => {
  const groups = partitionSubmissionsForCards(
    [
      { id: "request-1", status: "pending_resolution" },
      { id: "ready-1", status: "ready" },
      { id: "queued-1", status: "ready", latest_job: { status: "queued" } },
      { id: "processing-1", status: "ready", latest_job: { status: "processing" } },
      { id: "stopped-1", status: "stopped" },
      { id: "deleted-1", status: "deleted" },
      { id: "failed-1", status: "ready" },
      { id: "duplicate-review-1", status: "ready" },
      { id: "duplicate-1", status: "duplicate" },
    ],
    new Set(["failed-1"]),
    new Set(["duplicate-review-1"]),
  );

  assert.deepEqual(groups.requests.map((submission) => submission.id), [
    "request-1",
  ]);
  assert.deepEqual(groups.ready.map((submission) => submission.id), [
    "ready-1",
  ]);
  assert.deepEqual(groups.queued.map((submission) => submission.id), [
    "queued-1",
  ]);
  assert.deepEqual(groups.processing.map((submission) => submission.id), [
    "processing-1",
  ]);
  assert.deepEqual(groups.stopped.map((submission) => submission.id), [
    "stopped-1",
  ]);
  assert.deepEqual(groups.deleted.map((submission) => submission.id), [
    "deleted-1",
  ]);
  assert.deepEqual(groups.failed.map((submission) => submission.id), [
    "failed-1",
  ]);
});
