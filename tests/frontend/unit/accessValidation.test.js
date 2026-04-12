import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAccountAccess,
  getAccountAccessLabels,
} from "../../../app/frontend/src/features/access/utils.js";
import {
  getEmailValidationState,
  isValidEmail,
  normalizeEmail,
} from "../../../app/frontend/src/utils/email.js";

test("normalizeEmail trims surrounding whitespace before validation", () => {
  assert.equal(normalizeEmail("  reader@example.com  "), "reader@example.com");
});

test("isValidEmail accepts standard addresses and rejects malformed values", () => {
  assert.equal(isValidEmail("reader@example.com"), true);
  assert.equal(isValidEmail("reader"), false);
  assert.equal(isValidEmail(" reader@example.com "), true);
});

test("getEmailValidationState reports the normalized value and validity", () => {
  assert.deepEqual(getEmailValidationState(" reader@example.com "), {
    normalizedEmail: "reader@example.com",
    hasEmailInput: true,
    emailLooksValid: true,
  });
  assert.deepEqual(getEmailValidationState("invalid-address"), {
    normalizedEmail: "invalid-address",
    hasEmailInput: true,
    emailLooksValid: false,
  });
});

test("getAccountAccessLabels maps scope labels and keeps them sorted", () => {
  const scopeLabelMap = new Map([
    ["read:durable", "Read durable books"],
    ["metadata:edit", "Edit metadata"],
  ]);

  assert.deepEqual(
    getAccountAccessLabels(
      {
        global_scopes: ["read:durable", "metadata:edit"],
      },
      scopeLabelMap,
    ),
    ["Edit metadata", "Read durable books"],
  );
});

test("formatAccountAccess joins mapped permission labels for filtering", () => {
  const scopeLabelMap = new Map([["read:durable", "Read durable books"]]);

  assert.equal(
    formatAccountAccess(
      {
        global_scopes: ["read:durable"],
      },
      scopeLabelMap,
    ),
    "Read durable books",
  );
  assert.equal(formatAccountAccess({ global_scopes: [] }, scopeLabelMap), "-");
});
