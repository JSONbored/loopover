import assert from "node:assert/strict";
import { test } from "node:test";

import { compareBacktestScores, compareDirectionalBacktestScores, type BacktestScoreReport } from "../dist/index.js";

function report(overrides: Partial<BacktestScoreReport> = {}): BacktestScoreReport {
  return {
    ruleId: "missing_linked_issue",
    caseCount: 10,
    truePositive: 4,
    falsePositive: 2,
    trueNegative: 3,
    falseNegative: 1,
    precision: 0.5,
    recall: 0.5,
    ...overrides,
  };
}

test("barrel: the public entrypoint re-exports the Pareto-floor comparator (#8086)", () => {
  assert.equal(typeof compareBacktestScores, "function");
});

test("compareBacktestScores: both axes improving is an improved verdict with empty regressedAxes", () => {
  const comparison = compareBacktestScores(report(), report({ precision: 0.7, recall: 0.6 }));
  assert.deepEqual(comparison.improvedAxes, ["precision", "recall"]);
  assert.deepEqual(comparison.regressedAxes, []);
  assert.equal(comparison.verdict, "improved");
});

test("compareBacktestScores: PARETO FLOOR -- one axis improving while the other regresses is a regressed verdict", () => {
  const comparison = compareBacktestScores(report(), report({ precision: 0.9, recall: 0.3 }));
  assert.deepEqual(comparison.improvedAxes, ["precision"]);
  assert.deepEqual(comparison.regressedAxes, ["recall"]);
  assert.equal(comparison.verdict, "regressed");
});

test("compareBacktestScores: an axis with a null on either side is excluded from both lists", () => {
  const nullBaseline = compareBacktestScores(report({ precision: null }), report({ precision: 0.9, recall: 0.6 }));
  assert.deepEqual(nullBaseline.improvedAxes, ["recall"]);
  assert.deepEqual(nullBaseline.regressedAxes, []);
  assert.equal(nullBaseline.verdict, "improved");

  const nullCandidate = compareBacktestScores(report(), report({ recall: null }));
  assert.deepEqual(nullCandidate.improvedAxes, []);
  assert.deepEqual(nullCandidate.regressedAxes, []);
  assert.equal(nullCandidate.verdict, "unchanged");
});

test("compareBacktestScores: equal non-null axes land in neither list and yield an unchanged verdict", () => {
  const comparison = compareBacktestScores(report(), report());
  assert.deepEqual(comparison.improvedAxes, []);
  assert.deepEqual(comparison.regressedAxes, []);
  assert.equal(comparison.verdict, "unchanged");
  assert.equal(comparison.ruleId, "missing_linked_issue");
});

test("compareBacktestScores: mismatched ruleIds throw, naming both rules", () => {
  assert.throws(
    () => compareBacktestScores(report(), report({ ruleId: "other_rule" })),
    /cannot compare backtest scores for different rules: missing_linked_issue vs other_rule/,
  );
});

test("barrel: the public entrypoint re-exports the direction-aware comparator (#8225)", () => {
  assert.equal(typeof compareDirectionalBacktestScores, "function");
});

test("compareDirectionalBacktestScores: win axis up + within-budget sacrifice is improved; over-budget regresses", () => {
  const orientation = { mustImprove: "recall" as const, maxSacrifice: 0.1 };
  const ok = compareDirectionalBacktestScores(report(), report({ recall: 0.7, precision: 0.45 }), orientation);
  assert.equal(ok.verdict, "improved");
  const over = compareDirectionalBacktestScores(report(), report({ recall: 0.9, precision: 0.3 }), orientation);
  assert.equal(over.verdict, "regressed");
});

test("compareDirectionalBacktestScores: mismatched ruleIds throw, naming both rules", () => {
  assert.throws(
    () =>
      compareDirectionalBacktestScores(report(), report({ ruleId: "other_rule" }), {
        mustImprove: "recall",
        maxSacrifice: 0.1,
      }),
    /cannot compare backtest scores for different rules: missing_linked_issue vs other_rule/,
  );
});

test("compareDirectionalBacktestScores: a negative or non-finite maxSacrifice throws -- a caller bug, not a comparison", () => {
  assert.throws(
    () => compareDirectionalBacktestScores(report(), report(), { mustImprove: "recall", maxSacrifice: -0.1 }),
    /maxSacrifice must be a non-negative finite number, got -0.1/,
  );
  assert.throws(
    () => compareDirectionalBacktestScores(report(), report(), { mustImprove: "recall", maxSacrifice: Number.NaN }),
    /maxSacrifice must be a non-negative finite number, got NaN/,
  );
});

test("compareDirectionalBacktestScores: a null on either axis excludes that axis -- unknown stays unknown", () => {
  const orientation = { mustImprove: "recall" as const, maxSacrifice: 0.1 };
  // A null WIN axis can never earn "improved": the axis the trade exists to win is unjudgeable.
  const nullWin = compareDirectionalBacktestScores(report({ recall: null }), report({ recall: 0.9, precision: 0.9 }), orientation);
  assert.deepEqual(nullWin.regressedAxes, []);
  assert.deepEqual(nullWin.improvedAxes, ["precision"]);
  assert.equal(nullWin.verdict, "unchanged");
  // A null SACRIFICE axis drops out of the trade accounting entirely, leaving the win to decide the verdict.
  const nullSacrifice = compareDirectionalBacktestScores(report(), report({ recall: 0.7, precision: null }), orientation);
  assert.deepEqual(nullSacrifice.improvedAxes, ["recall"]);
  assert.deepEqual(nullSacrifice.regressedAxes, []);
  assert.equal(nullSacrifice.verdict, "improved");
});

test("compareDirectionalBacktestScores: an exact-boundary sacrifice (drop === maxSacrifice) is the accepted trade", () => {
  // 0.75 and 0.5 are exact IEEE-754 binary fractions, so their difference is exactly 0.25 -- landing the
  // sacrifice drop precisely on maxSacrifice to exercise the `> maxSacrifice` boundary's false arm.
  const orientation = { mustImprove: "recall" as const, maxSacrifice: 0.25 };
  const comparison = compareDirectionalBacktestScores(report({ precision: 0.75 }), report({ recall: 0.7, precision: 0.5 }), orientation);
  assert.deepEqual(comparison.regressedAxes, []);
  assert.deepEqual(comparison.improvedAxes, ["recall"]);
  assert.equal(comparison.verdict, "improved");
});

test("compareDirectionalBacktestScores: a lone sacrifice-axis gain with a flat win axis stays unchanged", () => {
  const orientation = { mustImprove: "recall" as const, maxSacrifice: 0.1 };
  const comparison = compareDirectionalBacktestScores(report(), report({ precision: 0.9 }), orientation);
  assert.deepEqual(comparison.improvedAxes, ["precision"]);
  assert.deepEqual(comparison.regressedAxes, []);
  assert.equal(comparison.verdict, "unchanged");
});

test("compareDirectionalBacktestScores: mustImprove precision flips the sacrifice axis to recall", () => {
  const orientation = { mustImprove: "precision" as const, maxSacrifice: 0.1 };
  const improved = compareDirectionalBacktestScores(report(), report({ precision: 0.7, recall: 0.42 }), orientation);
  assert.deepEqual(improved.improvedAxes, ["precision"]);
  assert.deepEqual(improved.regressedAxes, []);
  assert.equal(improved.verdict, "improved");
  const overBudget = compareDirectionalBacktestScores(report(), report({ precision: 0.7, recall: 0.3 }), orientation);
  assert.deepEqual(overBudget.regressedAxes, ["recall"]);
  assert.equal(overBudget.verdict, "regressed");
});
