import assert from "node:assert/strict";
import { test } from "node:test";

import {
  benchmarkWindowState,
  decideSubmission,
  DEFAULT_HELD_OUT_FRACTION,
  DEFAULT_SUBMISSION_CAP,
  gateHeldOutPublication,
  heldOutPublicationDecision,
  splitBacktestCorpus,
  splitBenchmarkWorkUnits,
  type BenchmarkWindow,
  type BenchmarkWorkUnitRef,
} from "../dist/index.js";

// #9263 (harness #9216, epic #8534): the controls that make a leaderboard position mean "generalizes"
// rather than "has submitted the most times". Each of the four recorded decisions in the module header has
// its enforcing test here, and the load-bearing one is that held-out MEMBERSHIP is not inferable from
// anything the published shape can carry.

const POLICY = { splitSeed: "seed-2026q3", heldOutFraction: DEFAULT_HELD_OUT_FRACTION };

/** Work units across many repos, several units per repo — the shape decision 1 is about. */
function unitsAcrossRepos(repoCount: number, perRepo = 3): BenchmarkWorkUnitRef[] {
  const units: BenchmarkWorkUnitRef[] = [];
  for (let repo = 0; repo < repoCount; repo += 1) {
    for (let index = 0; index < perRepo; index += 1) {
      units.push({ workUnitId: `owner/repo${repo}#${index}`, repoFullName: `owner/repo${repo}` });
    }
  }
  return units;
}

const WINDOW: BenchmarkWindow = {
  benchmarkId: "bench-2026q3",
  snapshotRef: "a1".repeat(32),
  opensAt: "2026-07-01T00:00:00.000Z",
  closesAt: "2026-09-30T00:00:00.000Z",
};

test("DECISION 1: the split is at REPO granularity — a repo's units never straddle the boundary", () => {
  const units = unitsAcrossRepos(24);
  const split = splitBenchmarkWorkUnits("bench-2026q3", units, POLICY);
  const heldOutRepos = new Set(split.heldOut.map((unit) => unit.repoFullName));
  const visibleRepos = new Set(split.visible.map((unit) => unit.repoFullName));
  // The two repo sets are disjoint: no repo contributes to both slices, which is the whole property.
  for (const repo of heldOutRepos) assert.equal(visibleRepos.has(repo), false, `${repo} straddles the split`);
  assert.equal(heldOutRepos.size + visibleRepos.size, 24);
  assert.equal(split.heldOutRepoCount, heldOutRepos.size);
  assert.equal(split.visibleRepoCount, visibleRepos.size);
  // Every unit is accounted for exactly once.
  assert.equal(split.visible.length + split.heldOut.length, units.length);
});

test("DECISION 1: the assignment IS the shared primitive's, not a lookalike", () => {
  // Recomputing through splitBacktestCorpus directly must name the same held-out repos — a second split
  // mechanism is exactly what requirement 1 forbids, so the equality is asserted rather than assumed.
  const units = unitsAcrossRepos(16);
  const repos = [...new Set(units.map((unit) => unit.repoFullName))];
  const direct = splitBacktestCorpus(
    repos.map((repoFullName) => ({
      ruleId: "bench-2026q3",
      targetKey: repoFullName,
      outcome: "repo",
      label: "confirmed" as const,
      firedAt: "",
      decidedAt: "",
    })),
    POLICY.heldOutFraction,
    POLICY.splitSeed,
  );
  const split = splitBenchmarkWorkUnits("bench-2026q3", units, POLICY);
  assert.deepEqual(
    [...new Set(split.heldOut.map((unit) => unit.repoFullName))].sort(),
    direct.heldOut.map((repoCase) => repoCase.targetKey).sort(),
  );
});

test("PROPERTY: assignment is deterministic, seed-dependent, and stable as the corpus grows", () => {
  const small = unitsAcrossRepos(12);
  const grown = [...small, ...unitsAcrossRepos(20).slice(36)];
  const a = splitBenchmarkWorkUnits("b", small, POLICY);
  const b = splitBenchmarkWorkUnits("b", small, POLICY);
  assert.deepEqual(a, b, "identical inputs must give identical output");
  // A different seed reassigns; without the seed, membership is unguessable.
  const other = splitBenchmarkWorkUnits("b", small, { ...POLICY, splitSeed: "different" });
  assert.notDeepEqual(
    [...new Set(other.heldOut.map((unit) => unit.repoFullName))].sort(),
    [...new Set(a.heldOut.map((unit) => unit.repoFullName))].sort(),
  );
  // Growth never reshuffles an already-assigned repo — the property backtest-split.ts exists to guarantee.
  const grownSplit = splitBenchmarkWorkUnits("b", grown, POLICY);
  const grownHeldOutRepos = new Set(grownSplit.heldOut.map((unit) => unit.repoFullName));
  for (const unit of a.heldOut) assert.ok(grownHeldOutRepos.has(unit.repoFullName), `${unit.repoFullName} moved`);
});

test("the split degenerates cleanly at both extremes and on an empty corpus", () => {
  const units = unitsAcrossRepos(8);
  assert.equal(splitBenchmarkWorkUnits("b", units, { ...POLICY, heldOutFraction: 0 }).heldOut.length, 0);
  assert.equal(splitBenchmarkWorkUnits("b", units, { ...POLICY, heldOutFraction: 1 }).visible.length, 0);
  const empty = splitBenchmarkWorkUnits("b", [], POLICY);
  assert.deepEqual(empty, { visible: [], heldOut: [], heldOutRepoCount: 0, visibleRepoCount: 0 });
  // An out-of-range fraction fails closed through the primitive's own guard, rather than splitting nothing.
  assert.throws(() => splitBenchmarkWorkUnits("b", units, { ...POLICY, heldOutFraction: 1.5 }), /invalid_held_out_fraction/);
});

test("benchmarkWindowState: pending before opening, open through the inclusive close, retired after", () => {
  assert.equal(benchmarkWindowState(WINDOW, "2026-06-30T23:59:59.000Z"), "pending");
  assert.equal(benchmarkWindowState(WINDOW, WINDOW.opensAt), "open");
  assert.equal(benchmarkWindowState(WINDOW, "2026-08-01T00:00:00.000Z"), "open");
  assert.equal(benchmarkWindowState(WINDOW, WINDOW.closesAt), "open");
  assert.equal(benchmarkWindowState(WINDOW, "2026-10-01T00:00:00.000Z"), "retired");
});

test("DECISION 3: the submission cap is enforced per (agent, window) and names its refusal", () => {
  const now = "2026-08-01T00:00:00.000Z";
  const first = decideSubmission({ window: WINDOW, now, priorSubmissions: 0 });
  assert.deepEqual(first, { accepted: true, submissionIndex: 1, remaining: DEFAULT_SUBMISSION_CAP - 1 });
  const last = decideSubmission({ window: WINDOW, now, priorSubmissions: DEFAULT_SUBMISSION_CAP - 1 });
  assert.deepEqual(last, { accepted: true, submissionIndex: DEFAULT_SUBMISSION_CAP, remaining: 0 });
  // Brute force stops here — the refusal says WHICH control fired.
  assert.deepEqual(decideSubmission({ window: WINDOW, now, priorSubmissions: DEFAULT_SUBMISSION_CAP }), {
    accepted: false,
    reason: "cap_reached",
    remaining: 0,
  });
  // An over-count (a replayed or double-recorded submission) still refuses, and never reports negative room.
  assert.deepEqual(decideSubmission({ window: WINDOW, now, priorSubmissions: 999 }), { accepted: false, reason: "cap_reached", remaining: 0 });
  // An explicit cap overrides the default in both directions.
  assert.equal(decideSubmission({ window: WINDOW, now, priorSubmissions: 2, cap: 3 }).accepted, true);
  assert.equal(decideSubmission({ window: WINDOW, now, priorSubmissions: 3, cap: 3 }).accepted, false);
});

test("DECISION 4: a retired window refuses submissions; so does one that has not opened", () => {
  assert.deepEqual(decideSubmission({ window: WINDOW, now: "2026-10-02T00:00:00.000Z", priorSubmissions: 0 }), {
    accepted: false,
    reason: "window_retired",
    remaining: DEFAULT_SUBMISSION_CAP,
  });
  assert.deepEqual(decideSubmission({ window: WINDOW, now: "2026-06-01T00:00:00.000Z", priorSubmissions: 0 }), {
    accepted: false,
    reason: "window_not_open",
    remaining: DEFAULT_SUBMISSION_CAP,
  });
  // A retired window refuses even with room left — rotation is not extended by an unused quota.
  assert.equal(decideSubmission({ window: WINDOW, now: "2026-12-01T00:00:00.000Z", priorSubmissions: 1 }).accepted, false);
});

test("DECISION 2: held-out publishes at close, never on demand while the window is open", () => {
  assert.deepEqual(heldOutPublicationDecision(WINDOW, "2026-08-15T00:00:00.000Z"), {
    publish: false,
    reason: "window_open_between_cadences",
  });
  assert.deepEqual(heldOutPublicationDecision(WINDOW, "2026-10-05T00:00:00.000Z"), { publish: true, reason: "evaluation_closed" });
  assert.deepEqual(heldOutPublicationDecision(WINDOW, "2026-06-01T00:00:00.000Z"), { publish: false, reason: "window_not_open" });
});

test("DECISION 2: a configured cadence publishes on the fixed schedule only, not on submission", () => {
  const cadenced: BenchmarkWindow = { ...WINDOW, heldOutPublishEveryDays: 30 };
  // Exactly 30 and 60 days after opening: scheduled boundaries.
  assert.deepEqual(heldOutPublicationDecision(cadenced, "2026-07-31T00:00:00.000Z"), { publish: true, reason: "scheduled_cadence" });
  assert.deepEqual(heldOutPublicationDecision(cadenced, "2026-08-30T00:00:00.000Z"), { publish: true, reason: "scheduled_cadence" });
  // A day either side of a boundary — and the opening instant itself — publish nothing.
  for (const between of ["2026-07-30T00:00:00.000Z", "2026-08-01T00:00:00.000Z", WINDOW.opensAt]) {
    assert.equal(heldOutPublicationDecision(cadenced, between).publish, false, between);
  }
});

test("REGRESSION: a gated payload DROPS the held-out score rather than flagging it, so it cannot be serialized by mistake", () => {
  const scores = { visible: { macro: 0.7 }, heldOut: { macro: 0.4 } };
  const open = gateHeldOutPublication(WINDOW, "2026-08-15T00:00:00.000Z", scores);
  assert.equal(open.heldOut, null);
  // The held-out value is absent from the payload ENTIRELY -- no count, no fraction, nothing an observer
  // could difference across submissions to recover per-unit membership.
  assert.equal(JSON.stringify(open).includes("0.4"), false);
  assert.deepEqual(open.visible, { macro: 0.7 });
  // After close there is nothing left to leak into, so the real score is published.
  const closed = gateHeldOutPublication(WINDOW, "2026-10-05T00:00:00.000Z", scores);
  assert.deepEqual(closed.heldOut, { macro: 0.4 });
  assert.deepEqual(closed.heldOutPublication, { publish: true, reason: "evaluation_closed" });
});

test("REGRESSION: nothing in a published open-window payload reveals held-out MEMBERSHIP", () => {
  // The adversary's question is "is repo X held out?". The published shape must not answer it, directly or
  // by differencing: it carries the visible slice and a policy decision, and no held-out identifiers.
  const units = unitsAcrossRepos(12);
  const split = splitBenchmarkWorkUnits("bench-2026q3", units, POLICY);
  const published = gateHeldOutPublication(WINDOW, "2026-08-15T00:00:00.000Z", {
    visible: { units: split.visible.map((unit) => unit.workUnitId) },
    heldOut: { units: split.heldOut.map((unit) => unit.workUnitId) },
  });
  const serialized = JSON.stringify(published);
  for (const unit of split.heldOut) {
    assert.equal(serialized.includes(unit.workUnitId), false, `${unit.workUnitId} leaked`);
    assert.equal(serialized.includes(unit.repoFullName), false, `${unit.repoFullName} leaked`);
  }
  assert.ok(split.heldOut.length > 0, "fixture must actually hold something out");
});
