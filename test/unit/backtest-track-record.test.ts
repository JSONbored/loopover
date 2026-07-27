import { describe, expect, it } from "vitest";
// Direct src-path import — the coverage-twin pattern this calibration module's merged tests established
// (the engine's node:test suite runs against dist/, outside root vitest's coverage instrumentation).
import { compareBacktestScores } from "../../packages/loopover-engine/src/calibration/backtest-compare";
import type { BacktestScoreReport } from "../../packages/loopover-engine/src/calibration/backtest-score";
import { computeRegressedVerdictTrackRecord } from "../../packages/loopover-engine/src/calibration/backtest-track-record";

function score(ruleId: string, overrides: Partial<BacktestScoreReport> = {}): BacktestScoreReport {
  return { ruleId, caseCount: 10, truePositive: 4, falsePositive: 1, trueNegative: 4, falseNegative: 1, precision: 0.8, recall: 0.8, ...overrides };
}

function comparison(ruleId: string, candidate: Partial<BacktestScoreReport>) {
  return compareBacktestScores(score(ruleId), score(ruleId, candidate));
}

describe("computeRegressedVerdictTrackRecord (#8140)", () => {
  it("returns zero totals and a null rate for zero runs", () => {
    expect(computeRegressedVerdictTrackRecord([])).toEqual({ totalRuns: 0, regressedRuns: 0, regressedRate: null, perRule: new Map() });
  });

  it("counts all-clean runs with a real 0 rate and full per-rule buckets", () => {
    const record = computeRegressedVerdictTrackRecord([comparison("a", { precision: 0.9 }), comparison("a", {})]);
    expect(record).toMatchObject({ totalRuns: 2, regressedRuns: 0, regressedRate: 0 });
    expect(record.perRule.get("a")).toEqual({ total: 2, regressed: 0, improved: 1, unchanged: 1 });
  });

  it("counts regressed runs into totals and the rate", () => {
    const record = computeRegressedVerdictTrackRecord([
      comparison("a", { precision: 0.6 }),
      comparison("a", { precision: 0.9 }),
      comparison("a", { recall: 0.5 }),
      comparison("a", {}),
    ]);
    expect(record).toMatchObject({ totalRuns: 4, regressedRuns: 2, regressedRate: 0.5 });
  });

  it("separates the per-ruleId breakdown across multiple rules", () => {
    const record = computeRegressedVerdictTrackRecord([
      comparison("rule_a", { precision: 0.6 }),
      comparison("rule_a", { precision: 0.95 }),
      comparison("rule_b", {}),
    ]);
    expect(record.perRule.get("rule_a")).toEqual({ total: 2, regressed: 1, improved: 1, unchanged: 0 });
    expect(record.perRule.get("rule_b")).toEqual({ total: 1, regressed: 0, improved: 0, unchanged: 1 });
  });
});
