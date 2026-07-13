import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  QUEUE_ITEMS,
  QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS,
} from "../../packages/gittensory-miner/lib/portfolio-queue-cli.js";

// Fixture for the GittensoryMinerPortfolioQueueItemStuck / GittensoryMinerPortfolioQueueBacklogHigh alerts
// (#5186). This is the config-side equivalent of a `promtool test rules` harness (the repo ships no promtool
// dependency): it pins each rule's formula, threshold, and metric names to the real renderer surface so the
// alerts can't silently drift away from the metrics they consume. Mirrors
// alerts-miner-prediction-calibration-drift.test.ts (#5188) and alerts-job-failure-ratio-formula.test.ts (#3892).
//
// Deliberately keyed off portfolio-queue-cli.js's exported metric-name CONSTANTS (renderPortfolioQueueMetrics)
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

describe("GittensoryMinerPortfolioQueueItemStuck alert (#5186)", () => {
  const rule = findAlert("GittensoryMinerPortfolioQueueItemStuck");
  const flat = rule.expr.replace(/\s+/g, " ").trim();

  it("lives in its own miner-scoped rule group, separate from the loopover server groups", () => {
    const group = alertsDoc.groups.find((g) => g.rules.some((r) => r.alert === rule.alert));
    expect(group?.name).toBe("gittensory-miner-portfolio-queue");
  });

  it("keys off the real renderer's oldest-lease-age gauge, not an invented metric name", () => {
    expect(QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS).toBe(
      "gittensory_miner_portfolio_queue_oldest_in_progress_lease_age_seconds",
    );
    expect(flat).toContain(QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS);
  });

  it("thresholds at a generous multiple of the 30m default reclaim window (1h), sustained 15m", () => {
    expect(flat).toBe(`${QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS} > 3600`);
    expect(rule.for).toBe("15m");
  });

  it("never references any loopover_* server metric (a miner rule must not fire on server data)", () => {
    expect(flat).not.toMatch(/loopover_/);
  });

  it("has warning severity and human-readable annotations", () => {
    expect(rule.labels?.severity).toBe("warning");
    expect(rule.annotations?.summary).toBeTruthy();
    expect(rule.annotations?.description).toBeTruthy();
    expect(rule.annotations?.runbook).toBeTruthy();
  });
});

describe("GittensoryMinerPortfolioQueueBacklogHigh alert (#5186)", () => {
  const rule = findAlert("GittensoryMinerPortfolioQueueBacklogHigh");
  const flat = rule.expr.replace(/\s+/g, " ").trim();

  it("lives in the same miner-scoped portfolio-queue rule group", () => {
    const group = alertsDoc.groups.find((g) => g.rules.some((r) => r.alert === rule.alert));
    expect(group?.name).toBe("gittensory-miner-portfolio-queue");
  });

  it("keys off the real renderer's items gauge, scoped to the queued status label", () => {
    expect(QUEUE_ITEMS).toBe("gittensory_miner_portfolio_queue_items");
    expect(flat).toBe(`${QUEUE_ITEMS}{status="queued"} > 200`);
  });

  it("has a 30m sustain window and warning severity", () => {
    expect(rule.for).toBe("30m");
    expect(rule.labels?.severity).toBe("warning");
  });

  it("never references any loopover_* server metric (a miner rule must not fire on server data)", () => {
    expect(flat).not.toMatch(/loopover_/);
  });
});
