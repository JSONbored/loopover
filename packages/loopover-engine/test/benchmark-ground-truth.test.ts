import assert from "node:assert/strict";
import { test } from "node:test";

import { benchmarkHorizonEnd, deriveBenchmarkGroundTruth, scoreableGroundTruths, type BenchmarkGroundTruth } from "../dist/index.js";

// #9261 (harness #9216, epic #8534): the labels every proposal is scored against. The three properties these
// tests exist to pin are the three the surrounding system already believes and a benchmark must not
// contradict: reversal-aware settlement, unresolved excluded from the denominator, and stability of a
// settled label regardless of when extraction runs.

const FROZEN = "2026-07-01T00:00:00.000Z";
const BASE = { snapshotRef: "a1".repeat(32), frozenAt: FROZEN, horizonDays: 14 };

/** Narrow one truth to the settled variant, failing the test loudly if it is not — `noUncheckedIndexedAccess`
 *  makes a destructured element possibly-undefined, which blocks the discriminant narrowing on its own. */
function settledAt(set: { truths: readonly BenchmarkGroundTruth[] }, index = 0): Extract<BenchmarkGroundTruth, { outcome: "settled" }> {
  const truth = set.truths[index];
  assert.ok(truth && truth.outcome === "settled", `truths[${index}] is not settled`);
  return truth;
}

/** `frozenAt + days`, as an ISO string — the tests' own arithmetic, independent of the module's. */
function at(days: number, hours = 0): string {
  return new Date(Date.parse(FROZEN) + days * 86_400_000 + hours * 3_600_000).toISOString();
}

test("benchmarkHorizonEnd is the inclusive frozenAt + horizonDays instant", () => {
  assert.equal(benchmarkHorizonEnd(FROZEN, 14), "2026-07-15T00:00:00.000Z");
  assert.equal(benchmarkHorizonEnd(FROZEN, 1), "2026-07-02T00:00:00.000Z");
});

test("settles on the LAST qualifying action in the window, carrying only that action's own parameters", () => {
  const set = deriveBenchmarkGroundTruth({
    ...BASE,
    workUnitIds: ["o/r#1", "o/r#2", "o/r#3"],
    events: [
      // #1: labeled, then changes requested, then merged — the merge is the settled state.
      { workUnitId: "o/r#1", action: "label", occurredAt: at(1), labels: ["bug"] },
      { workUnitId: "o/r#1", action: "request_changes", occurredAt: at(2) },
      { workUnitId: "o/r#1", action: "merge", occurredAt: at(3) },
      { workUnitId: "o/r#2", action: "close", occurredAt: at(4), reasonClass: "duplicate" },
      { workUnitId: "o/r#3", action: "label", occurredAt: at(5), labels: ["docs", "good-first-issue"] },
    ],
  });
  const [first, second, third] = set.truths;
  assert.deepEqual(first, { workUnitId: "o/r#1", outcome: "settled", action: "merge", settledAt: at(3), reversal: null });
  // A merge carries NO reasonClass/labels keys at all — not present-but-undefined.
  assert.equal("reasonClass" in (first as object), false);
  assert.equal("labels" in (first as object), false);
  assert.deepEqual(second, { workUnitId: "o/r#2", outcome: "settled", action: "close", reasonClass: "duplicate", settledAt: at(4), reversal: null });
  assert.deepEqual(third, { workUnitId: "o/r#3", outcome: "settled", action: "label", labels: ["docs", "good-first-issue"], settledAt: at(5), reversal: null });
});

test("REGRESSION: a merge later REVERTED inside the horizon is not a clean merge — the reversal is recorded", () => {
  const set = deriveBenchmarkGroundTruth({
    ...BASE,
    workUnitIds: ["o/r#1"],
    events: [{ workUnitId: "o/r#1", action: "merge", occurredAt: at(2) }],
    reversals: [{ workUnitId: "o/r#1", kind: "reversal_reverted", occurredAt: at(5) }],
  });
  const truth = settledAt(set);
  // The realized ACTION is still the merge — it is simply not a confirmed one, exactly as
  // public-rule-precision.ts records a reversed decision rather than erasing it.
  assert.equal(truth.action, "merge");
  assert.deepEqual(truth.reversal, { kind: "reversal_reverted", occurredAt: at(5) });
  // A reversed unit is still SCOREABLE — the reversal changes confirmation, not whether it counts.
  assert.equal(set.coverage.scoreable, 1);
});

test("the established reversal vocabulary is accepted verbatim, and the EARLIEST overturning wins", () => {
  for (const kind of ["reversal_reopened", "reversal_reverted", "reversal_superseded"] as const) {
    const set = deriveBenchmarkGroundTruth({
      ...BASE,
      workUnitIds: ["o/r#1"],
      events: [{ workUnitId: "o/r#1", action: "close", occurredAt: at(1), reasonClass: "stale" }],
      reversals: [
        { workUnitId: "o/r#1", kind: "reversal_superseded", occurredAt: at(9) },
        { workUnitId: "o/r#1", kind, occurredAt: at(4) },
      ],
    });
    assert.deepEqual(settledAt(set).reversal, { kind, occurredAt: at(4) });
  }
});

test("INVARIANT: a reversal is ignored unless it lands inside the horizon AND strictly after the settled action", () => {
  const events = [{ workUnitId: "o/r#1", action: "merge" as const, occurredAt: at(5) }];
  const cases = [
    ["before the settled action", at(3)],
    ["at the same instant as the settled action", at(5)],
    ["after the horizon end", at(30)],
    ["before the snapshot was frozen", at(-2)],
  ] as const;
  for (const [why, occurredAt] of cases) {
    const set = deriveBenchmarkGroundTruth({
      ...BASE,
      workUnitIds: ["o/r#1"],
      events,
      reversals: [{ workUnitId: "o/r#1", kind: "reversal_reverted", occurredAt }],
    });
    assert.equal(settledAt(set).reversal, null, why);
  }
  // A reversal for a DIFFERENT work unit never attaches.
  const other = deriveBenchmarkGroundTruth({
    ...BASE,
    workUnitIds: ["o/r#1"],
    events,
    reversals: [{ workUnitId: "o/r#2", kind: "reversal_reverted", occurredAt: at(7) }],
  });
  assert.equal(settledAt(other).reversal, null);
});

test("REGRESSION: a work unit with no action in the horizon is `unresolved` and leaves the denominator", () => {
  const set = deriveBenchmarkGroundTruth({
    ...BASE,
    workUnitIds: ["acted", "silent", "too-early", "too-late"],
    events: [
      { workUnitId: "acted", action: "merge", occurredAt: at(3) },
      // Outside the window in both directions: an action before the freeze is history the agent could
      // already see, and one after the horizon is beyond the question that was asked.
      { workUnitId: "too-early", action: "merge", occurredAt: at(-1) },
      { workUnitId: "too-late", action: "merge", occurredAt: at(20) },
    ],
  });
  assert.deepEqual(
    set.truths.map((truth) => [truth.workUnitId, truth.outcome]),
    [["acted", "settled"], ["silent", "unresolved"], ["too-early", "unresolved"], ["too-late", "unresolved"]],
  );
  // Excluded from the denominator — never counted as a correct abstention or an incorrect prediction.
  assert.deepEqual(set.coverage, { workUnits: 4, scoreable: 1, unresolved: 3, unresolvedRate: 0.75 });
  assert.deepEqual(scoreableGroundTruths(set).map((truth) => truth.workUnitId), ["acted"]);
});

test("boundary events are INSIDE the window at both ends — inclusive, matching the published horizonEnd", () => {
  const set = deriveBenchmarkGroundTruth({
    ...BASE,
    workUnitIds: ["at-freeze", "at-end"],
    events: [
      { workUnitId: "at-freeze", action: "hold", occurredAt: FROZEN },
      { workUnitId: "at-end", action: "merge", occurredAt: benchmarkHorizonEnd(FROZEN, 14) },
    ],
  });
  assert.equal(set.coverage.unresolved, 0);
  assert.equal(set.horizonEnd, benchmarkHorizonEnd(FROZEN, 14));
});

test("INVARIANT: ground truth is stable regardless of WHEN extraction runs, once the horizon has elapsed", () => {
  // The same (snapshot, horizon) with the same in-window events must yield byte-identical output no matter
  // how much later history has accumulated — a leaderboard that drifts under its own scores is not one.
  const input = {
    ...BASE,
    workUnitIds: ["o/r#1", "o/r#2"],
    events: [
      { workUnitId: "o/r#1", action: "merge" as const, occurredAt: at(3) },
      { workUnitId: "o/r#2", action: "close" as const, occurredAt: at(6), reasonClass: "spam" as const },
    ],
    reversals: [{ workUnitId: "o/r#1", kind: "reversal_reverted" as const, occurredAt: at(8) }],
  };
  const early = deriveBenchmarkGroundTruth(input);
  // Extraction re-run much later, with a year of further history appended: none of it is in the window,
  // so none of it may move a settled label.
  const late = deriveBenchmarkGroundTruth({
    ...input,
    events: [...input.events, { workUnitId: "o/r#1", action: "merge" as const, occurredAt: at(400) }],
    reversals: [...input.reversals, { workUnitId: "o/r#2", kind: "reversal_reopened" as const, occurredAt: at(400) }],
  });
  assert.deepEqual(late, early);
});

test("an unparseable timestamp is out-of-window, not a crash and not a silent settle", () => {
  const set = deriveBenchmarkGroundTruth({
    ...BASE,
    workUnitIds: ["o/r#1"],
    events: [{ workUnitId: "o/r#1", action: "merge", occurredAt: "not a date" }],
  });
  assert.equal(set.truths[0]?.outcome, "unresolved");
});

test("identical timestamps keep the earlier-listed event, so a stable input order yields a stable label", () => {
  const set = deriveBenchmarkGroundTruth({
    ...BASE,
    workUnitIds: ["o/r#1"],
    events: [
      { workUnitId: "o/r#1", action: "merge", occurredAt: at(2) },
      { workUnitId: "o/r#1", action: "close", occurredAt: at(2), reasonClass: "defective" },
    ],
  });
  assert.equal(settledAt(set).action, "merge");
});

test("an empty work-unit roster reports a NULL unresolved rate, never 0 (which would read as fully resolved)", () => {
  const set = deriveBenchmarkGroundTruth({ ...BASE, workUnitIds: [], events: [] });
  assert.deepEqual(set.coverage, { workUnits: 0, scoreable: 0, unresolved: 0, unresolvedRate: null });
  assert.deepEqual(scoreableGroundTruths(set), []);
});

test("REGRESSION: benchmarkHorizonEnd throws a NAMED error for an unparseable frozenAt or non-finite horizonDays", () => {
  // Fails closed as `invalid_frozen_at` rather than the bare RangeError `new Date(NaN).toISOString()` throws.
  assert.throws(() => benchmarkHorizonEnd("not a date", 14), /invalid_frozen_at: not a date/);
  assert.throws(() => benchmarkHorizonEnd("", 14), /invalid_frozen_at/);
  // A non-finite horizonDays is a caller bug, not an empty benchmark — NaN and Infinity both fail closed.
  assert.throws(() => benchmarkHorizonEnd(FROZEN, Number.NaN), /invalid_horizon_days: NaN/);
  assert.throws(() => benchmarkHorizonEnd(FROZEN, Number.POSITIVE_INFINITY), /invalid_horizon_days/);
});

test("REGRESSION: the window guard fires from deriveBenchmarkGroundTruth before any partial result is computed", () => {
  assert.throws(
    () => deriveBenchmarkGroundTruth({ ...BASE, frozenAt: "not a date", workUnitIds: ["o/r#1"], events: [] }),
    /invalid_frozen_at: not a date/,
  );
  assert.throws(
    () => deriveBenchmarkGroundTruth({ ...BASE, horizonDays: Number.NaN, workUnitIds: ["o/r#1"], events: [] }),
    /invalid_horizon_days: NaN/,
  );
});

test("REGRESSION: a duplicated workUnitId is rejected, never silently de-duplicated into a corrupt denominator", () => {
  assert.throws(
    () => deriveBenchmarkGroundTruth({ ...BASE, workUnitIds: ["o/r#1", "o/r#2", "o/r#1"], events: [] }),
    /invalid_duplicate_work_unit_id: o\/r#1/,
  );
});

test("the guards are ADDITIVE: a valid input still yields the exact same ground-truth set", () => {
  const set = deriveBenchmarkGroundTruth({
    ...BASE,
    workUnitIds: ["o/r#1", "o/r#2"],
    events: [
      { workUnitId: "o/r#1", action: "merge", occurredAt: at(3) },
      { workUnitId: "o/r#2", action: "close", occurredAt: at(6), reasonClass: "spam" },
    ],
    reversals: [{ workUnitId: "o/r#1", kind: "reversal_reverted", occurredAt: at(8) }],
  });
  assert.deepEqual(set, {
    schemaVersion: 1,
    snapshotRef: BASE.snapshotRef,
    horizonDays: 14,
    frozenAt: FROZEN,
    horizonEnd: "2026-07-15T00:00:00.000Z",
    truths: [
      { workUnitId: "o/r#1", outcome: "settled", action: "merge", settledAt: at(3), reversal: { kind: "reversal_reverted", occurredAt: at(8) } },
      { workUnitId: "o/r#2", outcome: "settled", action: "close", reasonClass: "spam", settledAt: at(6), reversal: null },
    ],
    coverage: { workUnits: 2, scoreable: 2, unresolved: 0, unresolvedRate: 0 },
  });
});

test("close/label parameters are dropped when the settled action is not the one they belong to", () => {
  // A malformed upstream event carrying a reasonClass on a merge must not leak it into the label.
  const set = deriveBenchmarkGroundTruth({
    ...BASE,
    workUnitIds: ["o/r#1", "o/r#2"],
    events: [
      { workUnitId: "o/r#1", action: "merge", occurredAt: at(1), reasonClass: "spam", labels: ["x"] },
      // A close whose reasonClass is genuinely absent stays absent rather than being invented.
      { workUnitId: "o/r#2", action: "close", occurredAt: at(1) },
    ],
  });
  assert.equal("reasonClass" in (set.truths[0] as object), false);
  assert.equal("labels" in (set.truths[0] as object), false);
  assert.equal("reasonClass" in (set.truths[1] as object), false);
});
