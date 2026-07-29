import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareBenchmarkScores,
  deriveBenchmarkGroundTruth,
  scoreBacktest,
  scoreBenchmarkProposals,
  SCORED_ACTIONS,
  type BenchmarkAction,
  type BenchmarkActionKind,
  type BenchmarkProposal,
  type BenchmarkScoreReport,
} from "../dist/index.js";

// #9262 (harness #9216, epic #8534): multi-class scoring built ON the shared confusion-matrix and
// Pareto-floor primitives. The load-bearing test here is the ANTI-DRIFT guard — an equivalent binary case
// scored through this adapter and through `scoreBacktest` directly must produce the identical report, which
// is what makes "benchmark scores are the same kind of number as the internal backtest's" mechanical rather
// than a claim in a comment.

const FROZEN = "2026-07-01T00:00:00.000Z";
const SNAPSHOT = "a1".repeat(32);
const SUBJECT = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

function at(days: number): string {
  return new Date(Date.parse(FROZEN) + days * 86_400_000).toISOString();
}

/** Ground truth from a compact [workUnitId, realizedAction] list; `null` means no action (unresolved). */
function truthFrom(pairs: ReadonlyArray<[string, BenchmarkActionKind | null]>) {
  return deriveBenchmarkGroundTruth({
    snapshotRef: SNAPSHOT,
    frozenAt: FROZEN,
    horizonDays: 14,
    workUnitIds: pairs.map(([id]) => id),
    events: pairs.flatMap(([id, action]) => (action ? [{ workUnitId: id, action, occurredAt: at(2) }] : [])),
  });
}

/** Proposals from a compact [workUnitId, predictedAction | "abstain"] list. */
function proposalsFrom(pairs: ReadonlyArray<[string, BenchmarkActionKind | "abstain"]>): BenchmarkProposal[] {
  return pairs.map(([workUnitId, choice]) => ({
    schemaVersion: 1,
    benchmarkId: "bench-1",
    snapshotRef: SNAPSHOT,
    workUnitId,
    subject: { kind: "agent", id: SUBJECT },
    prediction: choice === "abstain" ? { kind: "abstain" as const } : { kind: "act" as const, action: actionOf(choice) },
  }));
}

function actionOf(kind: BenchmarkActionKind): BenchmarkAction {
  if (kind === "close") return { kind, reasonClass: "defective" };
  if (kind === "request_changes") return { kind, blockingConcern: "concern" };
  if (kind === "label") return { kind, labels: ["bug"] };
  return { kind };
}

test("ANTI-DRIFT: an equivalent binary case scores identically through this adapter and through scoreBacktest", () => {
  // Two realized merges and two realized closes; the agent gets one of each right. Scored here as the
  // one-vs-rest `merge` report, and independently through the shared primitive on the same four cases.
  const groundTruth = truthFrom([["u1", "merge"], ["u2", "merge"], ["u3", "close"], ["u4", "close"]]);
  const proposals = proposalsFrom([["u1", "merge"], ["u2", "close"], ["u3", "merge"], ["u4", "close"]]);
  const report = scoreBenchmarkProposals({ subjectId: SUBJECT, groundTruth, proposals });

  const predictions: BenchmarkActionKind[] = ["merge", "close", "merge", "close"];
  const realized: BenchmarkActionKind[] = ["merge", "merge", "close", "close"];
  const direct = scoreBacktest(
    "merge",
    realized.map((actual, index) => ({
      ruleId: "merge",
      targetKey: String(index),
      outcome: actual,
      label: actual === "merge" ? ("reversed" as const) : ("confirmed" as const),
      firedAt: FROZEN,
      decidedAt: groundTruth.horizonEnd,
      metadata: { index },
    })),
    (backtestCase) => (predictions[(backtestCase.metadata as { index: number }).index] === "merge" ? "reversed" : "confirmed"),
  );
  assert.deepEqual(report.perAction.merge, direct);
  // And the counts are the ones a human would write down by hand: TP=u1, FP=u3, TN=u4, FN=u2.
  assert.deepEqual(
    { tp: direct.truePositive, fp: direct.falsePositive, tn: direct.trueNegative, fn: direct.falseNegative },
    { tp: 1, fp: 1, tn: 1, fn: 1 },
  );
});

test("scores every action one-vs-rest, each report self-labeled by its action", () => {
  const groundTruth = truthFrom([["u1", "merge"], ["u2", "close"], ["u3", "request_changes"], ["u4", "label"], ["u5", "hold"]]);
  const report = scoreBenchmarkProposals({
    subjectId: SUBJECT,
    groundTruth,
    proposals: proposalsFrom([["u1", "merge"], ["u2", "close"], ["u3", "request_changes"], ["u4", "label"], ["u5", "hold"]]),
  });
  for (const action of SCORED_ACTIONS) {
    assert.equal(report.perAction[action].ruleId, action);
    assert.equal(report.perAction[action].caseCount, 5);
    assert.equal(report.perAction[action].precision, 1);
    assert.equal(report.perAction[action].recall, 1);
  }
  assert.deepEqual(report.macro, { precision: 1, recall: 1, actionsScored: 5 });
  assert.deepEqual(report.micro, { precision: 1, recall: 1, accuracy: 1 });
});

test("REGRESSION: macro exposes the answer-merge-to-everything agent that micro flatters", () => {
  // Eight merges, two closes — the skew the module header warns about. The agent answers "merge" always.
  const pairs: Array<[string, BenchmarkActionKind]> = [
    ["u1", "merge"], ["u2", "merge"], ["u3", "merge"], ["u4", "merge"],
    ["u5", "merge"], ["u6", "merge"], ["u7", "merge"], ["u8", "merge"],
    ["u9", "close"], ["u10", "close"],
  ];
  const report = scoreBenchmarkProposals({
    subjectId: SUBJECT,
    groundTruth: truthFrom(pairs),
    proposals: proposalsFrom(pairs.map(([id]) => [id, "merge"] as [string, BenchmarkActionKind])),
  });
  // Micro (=accuracy) says 80% — respectable-looking for an agent that never made a decision.
  assert.equal(report.micro.accuracy, 0.8);
  // Macro sees the floor-level `close` recall (0 of 2 caught) and drags the headline down accordingly.
  assert.equal(report.perAction.close.recall, 0);
  assert.ok(report.macro.recall !== null && report.macro.recall < 0.6, `macro recall ${report.macro.recall}`);
});

test("an action with no realized instances is EXCLUDED from the macro mean, never counted as 0", () => {
  // Only merges are realized, and the agent gets them all right. `close`/`label`/... have no positives, so
  // their recall is null and must leave the average rather than dragging a perfect agent to 0.2.
  const report = scoreBenchmarkProposals({
    subjectId: SUBJECT,
    groundTruth: truthFrom([["u1", "merge"], ["u2", "merge"]]),
    proposals: proposalsFrom([["u1", "merge"], ["u2", "merge"]]),
  });
  assert.equal(report.perAction.close.recall, null);
  assert.equal(report.macro.recall, 1);
  // ...and the count says the headline is an average over ONE action, not five — the claim is legible.
  const scoredRecallActions = SCORED_ACTIONS.filter((action) => report.perAction[action].recall !== null);
  assert.deepEqual(scoredRecallActions, ["merge"]);
});

test("coverage: abstentions lower coverage and never enter the confusion matrix as errors", () => {
  const report = scoreBenchmarkProposals({
    subjectId: SUBJECT,
    groundTruth: truthFrom([["u1", "merge"], ["u2", "close"], ["u3", "merge"], ["u4", "close"]]),
    proposals: proposalsFrom([["u1", "merge"], ["u2", "abstain"], ["u3", "merge"]]),
  });
  // u2 declared an abstention; u4 was simply never answered — the SAME act, scored the same way.
  assert.deepEqual(report.coverage, {
    decided: 2,
    abstained: 2,
    coverage: 0.5,
    unresolvedExcluded: 0,
    unscorableProposals: 0,
  });
  // Two decided cases only: an abstention is absent from every count, so precision stays perfect.
  assert.equal(report.perAction.merge.caseCount, 2);
  assert.equal(report.perAction.merge.precision, 1);
  assert.equal(report.perAction.close.falseNegative, 0);
});

test("unresolved ground truth leaves the denominator before scoring begins, and is reported", () => {
  const report = scoreBenchmarkProposals({
    subjectId: SUBJECT,
    groundTruth: truthFrom([["u1", "merge"], ["u2", null], ["u3", null]]),
    // The agent answered the unresolved units too; they are excluded regardless of what it said.
    proposals: proposalsFrom([["u1", "merge"], ["u2", "close"], ["u3", "merge"]]),
  });
  assert.equal(report.coverage.decided, 1);
  assert.equal(report.coverage.unresolvedExcluded, 2);
  // A proposal for an excluded unit is unscorable, not free credit and not an error.
  assert.equal(report.coverage.unscorableProposals, 2);
  assert.equal(report.perAction.merge.caseCount, 1);
});

test("a proposal for a work unit outside the snapshot is counted as unscorable, never scored", () => {
  const report = scoreBenchmarkProposals({
    subjectId: SUBJECT,
    groundTruth: truthFrom([["u1", "merge"]]),
    proposals: proposalsFrom([["u1", "merge"], ["not-in-snapshot", "merge"], ["also-not", "close"]]),
  });
  assert.equal(report.coverage.unscorableProposals, 2);
  assert.equal(report.perAction.merge.caseCount, 1);
});

test("a resubmitted proposal is a correction: the LAST one for a work unit wins", () => {
  const report = scoreBenchmarkProposals({
    subjectId: SUBJECT,
    groundTruth: truthFrom([["u1", "merge"]]),
    proposals: proposalsFrom([["u1", "close"], ["u1", "merge"]]),
  });
  assert.equal(report.perAction.merge.truePositive, 1);
  assert.equal(report.coverage.decided, 1);
});

test("an agent that faced nothing reports NULL coverage, never 0", () => {
  const report = scoreBenchmarkProposals({ subjectId: SUBJECT, groundTruth: truthFrom([]), proposals: [] });
  assert.deepEqual(report.coverage, { decided: 0, abstained: 0, coverage: null, unresolvedExcluded: 0, unscorableProposals: 0 });
  assert.deepEqual(report.macro, { precision: null, recall: null, actionsScored: 0 });
  assert.deepEqual(report.micro, { precision: null, recall: null, accuracy: null });
});

test("the report carries the snapshot and subject it commits to", () => {
  const report = scoreBenchmarkProposals({
    subjectId: SUBJECT,
    groundTruth: truthFrom([["u1", "merge"]]),
    proposals: proposalsFrom([["u1", "merge"]]),
  });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.snapshotRef, SNAPSHOT);
  assert.equal(report.subjectId, SUBJECT);
});

test("REGRESSION: the Pareto floor holds across actions — gaining on merge while losing on close is REGRESSED", () => {
  const groundTruth = truthFrom([
    ["u1", "merge"], ["u2", "merge"], ["u3", "merge"],
    ["u4", "close"], ["u5", "close"], ["u6", "close"],
  ]);
  // Baseline catches 1 of 3 merges (recall 0.33) and all 3 closes (recall 1). The candidate buys perfect
  // merge recall by spending close recall: 3 of 3 merges, 1 of 3 closes. Precision stays 1 on both actions
  // in both reports, so recall alone moves and the trade is unambiguous.
  const baseline = scoreBenchmarkProposals({
    subjectId: SUBJECT,
    groundTruth,
    proposals: proposalsFrom([["u1", "merge"], ["u2", "hold"], ["u3", "hold"], ["u4", "close"], ["u5", "close"], ["u6", "close"]]),
  });
  const candidate = scoreBenchmarkProposals({
    subjectId: SUBJECT,
    groundTruth,
    proposals: proposalsFrom([["u1", "merge"], ["u2", "merge"], ["u3", "merge"], ["u4", "close"], ["u5", "hold"], ["u6", "hold"]]),
  });
  assert.equal(baseline.perAction.merge.recall, 0.3333333333333333);
  assert.equal(candidate.perAction.merge.recall, 1);
  assert.equal(baseline.perAction.close.recall, 1);
  assert.equal(candidate.perAction.close.recall, 0.3333333333333333);
  const comparison = compareBenchmarkScores(baseline, candidate);
  assert.ok(comparison.improvedActions.includes("merge"), "merge should have improved");
  assert.ok(comparison.regressedActions.includes("close"), "close should have regressed");
  // A trade is not a win — the entire point of the floor.
  assert.equal(comparison.verdict, "regressed");
});

test("comparison verdicts: improved when only gains, unchanged when identical, per-action detail preserved", () => {
  const groundTruth = truthFrom([["u1", "merge"], ["u2", "merge"]]);
  const worse = scoreBenchmarkProposals({ subjectId: SUBJECT, groundTruth, proposals: proposalsFrom([["u1", "merge"], ["u2", "close"]]) });
  const better = scoreBenchmarkProposals({ subjectId: SUBJECT, groundTruth, proposals: proposalsFrom([["u1", "merge"], ["u2", "merge"]]) });
  assert.equal(compareBenchmarkScores(worse, better).verdict, "improved");
  assert.equal(compareBenchmarkScores(better, better).verdict, "unchanged");
  const detail = compareBenchmarkScores(worse, better);
  assert.equal(detail.perAction.merge.verdict, "improved");
  for (const action of SCORED_ACTIONS) assert.equal(detail.perAction[action].ruleId, action);
});

test("comparing two DIFFERENT subjects throws — that is a caller bug, not a valid comparison", () => {
  const groundTruth = truthFrom([["u1", "merge"]]);
  const mine = scoreBenchmarkProposals({ subjectId: "agent-a", groundTruth, proposals: proposalsFrom([["u1", "merge"]]) });
  const theirs: BenchmarkScoreReport = { ...mine, subjectId: "agent-b" };
  assert.throws(() => compareBenchmarkScores(mine, theirs), /different subjects/);
});
