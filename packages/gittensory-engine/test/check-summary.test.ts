import { test } from "node:test";
import assert from "node:assert/strict";

import { isFailingCheckSummary } from "../dist/signals/check-summary.js";
import type { CheckSummaryRecord } from "../dist/scoring/types.js";

function check(overrides: Partial<CheckSummaryRecord> & Pick<CheckSummaryRecord, "status">): CheckSummaryRecord {
  return {
    id: "check-1",
    repoFullName: "owner/repo",
    name: "ci",
    payload: {},
    ...overrides,
  };
}

test("isFailingCheckSummary: treats known failing conclusions as failing", () => {
  for (const conclusion of ["failure", "failed", "timed_out", "cancelled", "action_required", "startup_failure"]) {
    assert.equal(isFailingCheckSummary(check({ status: "completed", conclusion })), true, conclusion);
    assert.equal(isFailingCheckSummary(check({ status: conclusion.toUpperCase(), conclusion: null })), true, `${conclusion} on status`);
  }
});

test("isFailingCheckSummary: treats success-like outcomes as not failing", () => {
  assert.equal(isFailingCheckSummary(check({ status: "completed", conclusion: "success" })), false);
  assert.equal(isFailingCheckSummary(check({ status: "success", conclusion: null })), false);
  assert.equal(isFailingCheckSummary(check({ status: "in_progress", conclusion: null })), false);
});

test("isFailingCheckSummary: falls back to status when conclusion is absent", () => {
  assert.equal(isFailingCheckSummary(check({ status: "FAILED", conclusion: undefined })), true);
  assert.equal(isFailingCheckSummary(check({ status: "SUCCESS", conclusion: undefined })), false);
});
