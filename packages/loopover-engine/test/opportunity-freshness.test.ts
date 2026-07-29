import { test } from "node:test";
import assert from "node:assert/strict";

import { computeOpportunityFreshness } from "../dist/index.js";

const nowMs = Date.parse("2026-07-03T00:00:00.000Z");

test("barrel: the public entrypoint re-exports the freshness scorer API", () => {
  assert.equal(typeof computeOpportunityFreshness, "function");
});

test("computeOpportunityFreshness returns 0 when no open issues exist", () => {
  assert.equal(computeOpportunityFreshness([], nowMs), 0);
  assert.equal(
    computeOpportunityFreshness([{ state: "closed", updatedAt: "2026-07-01T00:00:00.000Z" }], nowMs),
    0,
  );
});

test("computeOpportunityFreshness decays with issue age", () => {
  const fresh = computeOpportunityFreshness(
    [{ state: "open", updatedAt: "2026-07-01T00:00:00.000Z" }],
    nowMs,
  );
  assert.ok(fresh > 0.7);

  const stale = computeOpportunityFreshness(
    [{ state: "open", createdAt: "2023-01-01T00:00:00.000Z" }],
    nowMs,
  );
  assert.ok(stale <= 0.05);
});

test("computeOpportunityFreshness uses the most recently updated open issue", () => {
  const score = computeOpportunityFreshness(
    [
      { state: "open", updatedAt: "2023-01-01T00:00:00.000Z" },
      { state: "open", updatedAt: "2026-07-01T00:00:00.000Z" },
    ],
    nowMs,
  );
  assert.ok(score > 0.7);
});

test("computeOpportunityFreshness normalizes issue state case and blank timestamps", () => {
  assert.ok(
    computeOpportunityFreshness([{ state: "OPEN", updatedAt: "2026-07-01T00:00:00.000Z" }], nowMs) > 0.7,
  );
  assert.ok(
    computeOpportunityFreshness([{ state: " open ", updatedAt: "2026-07-01T00:00:00.000Z" }], nowMs) > 0.7,
  );
  const score = computeOpportunityFreshness(
    [{ state: "open", updatedAt: "", createdAt: "2026-07-01T00:00:00.000Z" }],
    nowMs,
  );
  assert.ok(score > 0.7);
});

test("computeOpportunityFreshness falls back from malformed updatedAt to createdAt", () => {
  const stale = computeOpportunityFreshness(
    [{ state: "open", updatedAt: "not-a-date", createdAt: "2023-01-01T00:00:00.000Z" }],
    nowMs,
  );
  assert.ok(stale <= 0.05);

  const fresh = computeOpportunityFreshness(
    [{ state: "open", updatedAt: "not-a-date", createdAt: "2026-07-01T00:00:00.000Z" }],
    nowMs,
  );
  assert.ok(fresh > 0.7);
});

test("computeOpportunityFreshness handles large open-issue lists without spreading into Math.min", () => {
  const issues = Array.from({ length: 200_000 }, (_, index) => ({
    state: "open",
    updatedAt: index === 0 ? "2026-07-01T00:00:00.000Z" : "2023-01-01T00:00:00.000Z",
  }));
  const score = computeOpportunityFreshness(issues, nowMs);
  assert.ok(score > 0.7);
});

test("#9618: a non-finite clock returns the 0 no-signal sentinel", () => {
  assert.equal(computeOpportunityFreshness([{ state: "open", updatedAt: "2026-07-01T00:00:00.000Z" }], Number.NaN), 0);
  assert.equal(computeOpportunityFreshness([{ state: "open", updatedAt: "2026-07-01T00:00:00.000Z" }], Number.POSITIVE_INFINITY), 0);
});

test("#9618: no open issues returns the 0 no-signal sentinel", () => {
  assert.equal(computeOpportunityFreshness([], 1_700_000_000_000), 0);
  assert.equal(computeOpportunityFreshness([{ state: "closed", updatedAt: "2023-11-14T00:00:00.000Z" }], 1_700_000_000_000), 0);
});

test("#9618: the measured range floor and ceiling are exactly 0.05 and 1", () => {
  // ~5 years old -> exp(-age/20) underflows the clamp to the 0.05 floor; same-day (age 0) -> exp(0) = 1.
  assert.equal(computeOpportunityFreshness([{ state: "open", updatedAt: "2018-11-14T00:00:00.000Z" }], 1_700_000_000_000), 0.05);
  assert.equal(computeOpportunityFreshness([{ state: "open", updatedAt: "2023-11-14T00:00:00.000Z" }], 1_700_000_000_000), 1);
});
