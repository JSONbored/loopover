import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  MINER_PREDICTION_CORRECT_TOTAL,
  MINER_PREDICTION_INCORRECT_TOTAL,
} from "../../packages/gittensory-engine/src/miner-prediction-metrics";

// Fixture for the GittensoryMinerPredictionCalibrationDrift alert (#5188). This is the config-side
// equivalent of a `promtool test rules` harness (the repo ships no promtool dependency): it pins the
// rule's formula, threshold, and metric names to the real renderer surface so the alert can't silently
// drift away from the metrics it consumes. Mirrors alerts-job-failure-ratio-formula.test.ts (#3892).
//
// Deliberately keyed off the engine's exported metric-name CONSTANTS (renderMinerPredictionMetrics,
// packages/gittensory-engine/src/miner-prediction-metrics.ts) rather than hardcoded strings: if that
// renderer ever renames a counter, this test fails instead of the alert going quietly stale against a
// metric name that no longer exists.

interface AlertRule {
  alert: string;
  expr: string;
  for?: string;
  labels?: { severity?: string };
  annotations?: { summary?: string; description?: string; runbook?: string };
}
interface AlertGroup {
  name: string;
  rules: AlertRule[];
}
interface AlertsDoc {
  groups: AlertGroup[];
}

const alertsDoc = parseYaml(readFileSync("prometheus/rules/alerts.yml", "utf8")) as AlertsDoc;

function findAlert(name: string): AlertRule {
  for (const group of alertsDoc.groups) {
    const rule = group.rules.find((r) => r.alert === name);
    if (rule) return rule;
  }
  throw new Error(`alert ${name} not found in prometheus/rules/alerts.yml`);
}

describe("GittensoryMinerPredictionCalibrationDrift alert (#5188)", () => {
  const rule = findAlert("GittensoryMinerPredictionCalibrationDrift");
  const flat = rule.expr.replace(/\s+/g, " ").trim();

  it("lives in its own miner-scoped rule group, separate from the loopover server groups", () => {
    const group = alertsDoc.groups.find((g) => g.rules.some((r) => r.alert === rule.alert));
    expect(group?.name).toBe("gittensory-miner-prediction");
  });

  it("keys off the miner renderer's real correct/incorrect counters, not invented metric names", () => {
    expect(MINER_PREDICTION_CORRECT_TOTAL).toBe("loopover_miner_prediction_correct_total");
    expect(MINER_PREDICTION_INCORRECT_TOTAL).toBe("loopover_miner_prediction_incorrect_total");
    expect(flat).toContain(MINER_PREDICTION_CORRECT_TOTAL);
    expect(flat).toContain(MINER_PREDICTION_INCORRECT_TOTAL);
  });

  it("uses the incorrect/(correct+incorrect) drift ratio shape over a 6h window", () => {
    expect(flat).toMatch(
      /sum\(rate\(loopover_miner_prediction_incorrect_total\[6h\]\)\) \/ \( sum\(rate\(loopover_miner_prediction_correct_total\[6h\]\)\) \+ sum\(rate\(loopover_miner_prediction_incorrect_total\[6h\]\)\)/,
    );
  });

  it("guards the ratio against a 0/0 NaN so it degrades to silent when no predictions are resolved (invariant)", () => {
    // The trailing `> 0` on the denominator is what makes an absent/empty calibration series yield no
    // result instead of a false-positive alert.
    expect(flat).toMatch(/> 0 \) \) > 0\.5/);
  });

  it("never references any loopover_* server metric (a miner rule must not fire on server data)", () => {
    expect(flat).not.toMatch(/loopover_(?!miner_)/);
  });

  it("has a sustain window, warning severity, and human-readable annotations", () => {
    expect(rule.for).toBe("30m");
    expect(rule.labels?.severity).toBe("warning");
    expect(rule.annotations?.summary).toBeTruthy();
    expect(rule.annotations?.description).toBeTruthy();
  });
});
