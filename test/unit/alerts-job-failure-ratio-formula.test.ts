import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

// Regression test (#3892): LoopoverHighJobFailureRatio's expr used to divide failed-job rate by
// loopover_jobs_processed_total alone. That metric only increments on SUCCESS (src/selfhost/pg-queue.ts,
// src/selfhost/sqlite-queue.ts), so the old expr computed failed:success, not a true failure percentage --
// at a genuine 50% failure rate it evaluated to 100%. This pins the corrected failed/(failed+processed)
// shape (matching the Grafana "Job Failure Rate" panel's formula) so the bug can't silently return.

interface AlertRule {
  alert: string;
  expr: string;
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

describe("LoopoverHighJobFailureRatio alert formula (#3892)", () => {
  const expr = findAlert("LoopoverHighJobFailureRatio").expr;
  const flat = expr.replace(/\s+/g, " ").trim();

  it("divides failed by (failed + processed), not by processed alone", () => {
    expect(flat).toMatch(
      /sum\(rate\(loopover_jobs_failed_total\[10m\]\)\) \/ \( sum\(rate\(loopover_jobs_failed_total\[10m\]\)\) \+ sum\(rate\(loopover_jobs_processed_total\[10m\]\)\) \) > 0/,
    );
  });

  it("still guards the ratio comparison against a 0/0 NaN before applying the 10% threshold", () => {
    expect(flat).toMatch(/\) > 0 \) > 0\.10/);
  });
});
