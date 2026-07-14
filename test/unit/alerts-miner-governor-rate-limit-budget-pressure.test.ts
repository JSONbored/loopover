import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  GOVERNOR_CAP_USAGE_RATIO,
  GOVERNOR_RATE_LIMIT_REMAINING_RATIO,
} from "../../packages/loopover-miner/lib/governor-metrics-cli.js";

// Fixture for the LoopOverMinerGovernorRateLimitPressureHigh / LoopOverMinerGovernorCapUsageHigh alerts
// (#5187). This is the config-side equivalent of a `promtool test rules` harness (the repo ships no promtool
// dependency): it pins each rule's formula, threshold, and metric names to the real renderer surface so the
// alerts can't silently drift away from the metrics they consume. Mirrors
// alerts-miner-portfolio-queue-backlog.test.ts (#5186) and alerts-miner-prediction-calibration-drift.test.ts
// (#5188).
//
// Deliberately keyed off governor-metrics-cli.js's exported metric-name CONSTANTS (renderGovernorMetrics)
// rather than hardcoded strings: if that renderer ever renames a gauge, this test fails instead of the alert
// going quietly stale against a metric name that no longer exists.

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

describe("LoopOverMinerGovernorRateLimitPressureHigh alert (#5187)", () => {
  const rule = findAlert("LoopOverMinerGovernorRateLimitPressureHigh");
  const flat = rule.expr.replace(/\s+/g, " ").trim();

  it("lives in its own miner-scoped rule group, separate from the loopover server groups", () => {
    const group = alertsDoc.groups.find((g) => g.rules.some((r) => r.alert === rule.alert));
    expect(group?.name).toBe("loopover-miner-governor");
  });

  it("keys off the real renderer's rate-limit-remaining gauge, not an invented metric name", () => {
    expect(GOVERNOR_RATE_LIMIT_REMAINING_RATIO).toBe("loopover_miner_governor_rate_limit_remaining_ratio");
    expect(flat).toBe(`${GOVERNOR_RATE_LIMIT_REMAINING_RATIO} < 0.1`);
  });

  it("requires 10m of sustained pressure (>= 10 successive 60s windows) before firing", () => {
    expect(rule.for).toBe("10m");
  });

  it("never references any loopover_* server metric (a miner rule must not fire on server data)", () => {
    expect(flat).not.toMatch(/loopover_(?!miner_)/);
  });

  it("has warning severity and human-readable annotations", () => {
    expect(rule.labels?.severity).toBe("warning");
    expect(rule.annotations?.summary).toBeTruthy();
    expect(rule.annotations?.description).toBeTruthy();
    expect(rule.annotations?.runbook).toBeTruthy();
  });

  it("only reads governor state -- the runbook never instructs a governor decision-logic change", () => {
    const runbook = rule.annotations?.runbook ?? "";
    expect(runbook).not.toMatch(/chokepoint/i);
    expect(runbook).not.toMatch(/evaluateGovernorChokepointGate/);
  });
});

describe("LoopOverMinerGovernorCapUsageHigh alert (#5187)", () => {
  const rule = findAlert("LoopOverMinerGovernorCapUsageHigh");
  const flat = rule.expr.replace(/\s+/g, " ").trim();

  it("lives in the same miner-scoped governor rule group", () => {
    const group = alertsDoc.groups.find((g) => g.rules.some((r) => r.alert === rule.alert));
    expect(group?.name).toBe("loopover-miner-governor");
  });

  it("keys off the real renderer's cap-usage gauge, thresholded at 90%", () => {
    expect(GOVERNOR_CAP_USAGE_RATIO).toBe("loopover_miner_governor_cap_usage_ratio");
    expect(flat).toBe(`${GOVERNOR_CAP_USAGE_RATIO} > 0.9`);
  });

  it("has a 10m sustain window and warning severity", () => {
    expect(rule.for).toBe("10m");
    expect(rule.labels?.severity).toBe("warning");
  });

  it("never references any loopover_* server metric (a miner rule must not fire on server data)", () => {
    expect(flat).not.toMatch(/loopover_(?!miner_)/);
  });

  it("only reads governor state -- the runbook never instructs a governor decision-logic change", () => {
    const runbook = rule.annotations?.runbook ?? "";
    expect(runbook).not.toMatch(/chokepoint/i);
    expect(runbook).not.toMatch(/evaluateGovernorChokepointGate/);
  });
});
