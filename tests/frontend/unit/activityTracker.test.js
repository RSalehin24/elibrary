import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProcessingActivityPayload,
  shouldPollProcessingActivity,
} from "../../../app/frontend/src/features/processing/helpers/activityTracker.js";

test("normalizeProcessingActivityPayload deduplicates scopes and infers activity from them", () => {
  assert.deepEqual(
    normalizeProcessingActivityPayload({
      can_manage_processing: 1,
      has_visible_activity: false,
      active_scopes: ["jobs", "jobs", " source_jobs ", "", null],
    }),
    {
      canManageProcessing: true,
      hasVisibleActivity: true,
      activeScopes: ["jobs", "source_jobs"],
    },
  );
});

test("normalizeProcessingActivityPayload preserves an idle snapshot", () => {
  assert.deepEqual(normalizeProcessingActivityPayload({}), {
    canManageProcessing: false,
    hasVisibleActivity: false,
    activeScopes: [],
  });
});

test("shouldPollProcessingActivity only polls authenticated processing routes", () => {
  assert.equal(
    shouldPollProcessingActivity({
      authenticated: true,
      pathname: "/processing-my-requests",
      sessionLoading: false,
    }),
    true,
  );
  assert.equal(
    shouldPollProcessingActivity({
      authenticated: true,
      pathname: "/home",
      sessionLoading: false,
    }),
    false,
  );
  assert.equal(
    shouldPollProcessingActivity({
      authenticated: false,
      pathname: "/processing-my-requests",
      sessionLoading: false,
    }),
    false,
  );
  assert.equal(
    shouldPollProcessingActivity({
      authenticated: true,
      pathname: "/processing-my-requests",
      sessionLoading: true,
    }),
    false,
  );
});
