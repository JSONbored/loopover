import { describe, expect, it } from "vitest";
import {
  CALIBRATION_TREND_WEEKS,
  MIN_CALIBRATION_TREND_SAMPLE,
  buildCalibrationTrend,
  loadCalibrationTrend,
  type BacktestRunDayRow,
  type FiredDayRow,
  type OverrideDayRow,
} from "../../src/services/rule-calibration-trend";
import { isoWeekStart } from "../../src/services/public-quality-metrics";
import { createApp } from "../../src/api/routes";
import { recordAuditEvent } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const WEEK_MS = 7 * 86_400_000;
const currentMonday = isoWeekStart(NOW);
const priorMonday = isoWeekStart(NOW - WEEK_MS);

describe("buildCalibrationTrend (#8113)", () => {
  it("buckets fired + override day rows per rule per week and computes precision as confirmed/decided", () => {
    const fired: FiredDayRow[] = [
      { ruleId: "linked_issue_scope_mismatch", day: priorMonday, fired: 4 },
      // A second day in the SAME week — must accumulate.
      { ruleId: "linked_issue_scope_mismatch", day: priorMonday, fired: 2 },
    ];
    const overrides: OverrideDayRow[] = [
      { ruleId: "linked_issue_scope_mismatch", day: priorMonday, confirmed: 3, reversed: 1, unrecognized: 0 },
    ];
    const trend = buildCalibrationTrend(fired, overrides, [], NOW, 2);
    expect(trend.rules).toHaveLength(1);
    const [rule] = trend.rules;
    expect(rule!.ruleId).toBe("linked_issue_scope_mismatch");
    expect(rule!.weeks).toEqual([
      { weekStart: priorMonday, fired: 6, confirmed: 3, reversed: 1, precisionPct: 75, unrecognized: 0 },
      { weekStart: currentMonday, fired: 0, confirmed: null, reversed: null, precisionPct: null, unrecognized: 0 },
    ]);
  });

  it("keeps a week's verdict split null below MIN_CALIBRATION_TREND_SAMPLE decided — unknown never fakes 0 or 100", () => {
    const overrides: OverrideDayRow[] = [
      { ruleId: "duplicate_pr_risk", day: currentMonday, confirmed: MIN_CALIBRATION_TREND_SAMPLE - 1, reversed: 0, unrecognized: 0 },
    ];
    const trend = buildCalibrationTrend([], overrides, [], NOW, 1);
    expect(trend.rules[0]!.weeks[0]).toEqual({
      weekStart: currentMonday,
      fired: 0,
      confirmed: null,
      reversed: null,
      precisionPct: null,
      unrecognized: 0,
    });
  });

  it("creates a rule bucket from an override-only history (no firings recorded in the window)", () => {
    const overrides: OverrideDayRow[] = [{ ruleId: "missing_linked_issue", day: currentMonday, confirmed: 2, reversed: 2, unrecognized: 0 }];
    const trend = buildCalibrationTrend([], overrides, [], NOW, 1);
    expect(trend.rules[0]!.weeks[0]!.precisionPct).toBe(50);
    expect(trend.rules[0]!.weeks[0]!.fired).toBe(0);
  });

  it("REGRESSION (#9640): counts a missing/unrecognized $.verdict as unrecognized, excluded from decided/confirmed", () => {
    const overrides: OverrideDayRow[] = [
      { ruleId: "linked_issue_scope_mismatch", day: currentMonday, confirmed: 9, reversed: 1, unrecognized: 5 },
    ];
    const trend = buildCalibrationTrend([], overrides, [], NOW, 1);
    // Below the fix, decided would have been 15 (confirmed folded the 5 unrecognized rows in) and precision 0.933.
    expect(trend.rules[0]!.weeks[0]).toEqual({
      weekStart: currentMonday,
      fired: 0,
      confirmed: 9,
      reversed: 1,
      precisionPct: 90,
      unrecognized: 5,
    });
  });

  it("sorts rules by ruleId for byte-stable output", () => {
    const fired: FiredDayRow[] = [
      { ruleId: "zeta_rule", day: currentMonday, fired: 1 },
      { ruleId: "alpha_rule", day: currentMonday, fired: 1 },
    ];
    expect(buildCalibrationTrend(fired, [], [], NOW, 1).rules.map((rule) => rule.ruleId)).toEqual(["alpha_rule", "zeta_rule"]);
  });

  it("drops rows outside the window and unparseable days, for every row kind", () => {
    const outside = isoWeekStart(NOW - 3 * WEEK_MS);
    const future = isoWeekStart(NOW + 2 * WEEK_MS);
    const fired: FiredDayRow[] = [
      { ruleId: "r", day: outside, fired: 5 },
      { ruleId: "r", day: "not-a-day", fired: 5 },
    ];
    const overrides: OverrideDayRow[] = [{ ruleId: "r", day: future, confirmed: 5, reversed: 5, unrecognized: 0 }];
    const runs: BacktestRunDayRow[] = [{ day: "junk", regressed: 1, improved: 1, unchanged: 1 }];
    const trend = buildCalibrationTrend(fired, overrides, runs, NOW, 2);
    expect(trend.rules).toEqual([]);
    expect(trend.backtestRuns.every((week) => week.runs === 0)).toBe(true);
  });

  it("buckets backtest runs per week with verdict counts and a runs total", () => {
    const runs: BacktestRunDayRow[] = [
      { day: priorMonday, regressed: 1, improved: 2, unchanged: 0 },
      { day: priorMonday, regressed: 0, improved: 0, unchanged: 3 },
      { day: currentMonday, regressed: 0, improved: 1, unchanged: 0 },
    ];
    const trend = buildCalibrationTrend([], [], runs, NOW, 2);
    expect(trend.backtestRuns).toEqual([
      { weekStart: priorMonday, runs: 6, regressed: 1, improved: 2, unchanged: 3 },
      { weekStart: currentMonday, runs: 1, regressed: 0, improved: 1, unchanged: 0 },
    ]);
  });

  it("defaults to CALIBRATION_TREND_WEEKS trailing buckets", () => {
    const trend = buildCalibrationTrend([], [], [], NOW);
    expect(trend.backtestRuns).toHaveLength(CALIBRATION_TREND_WEEKS);
    expect(trend.backtestRuns[0]!.weekStart).toBe(isoWeekStart(NOW - (CALIBRATION_TREND_WEEKS - 1) * WEEK_MS));
  });
});

describe("loadCalibrationTrend (#8113)", () => {
  async function seed(env: Env) {
    const inWindow = new Date(NOW - WEEK_MS).toISOString();
    await recordAuditEvent(env, {
      eventType: "signal.rule_fired:linked_issue_scope_mismatch",
      actor: "loopover",
      targetKey: "o/r#1",
      outcome: "completed",
      metadata: { outcome: "unaddressed" },
      createdAt: inWindow,
    });
    for (const verdict of ["confirmed", "confirmed", "confirmed", "reversed"]) {
      await recordAuditEvent(env, {
        eventType: "signal.human_override:linked_issue_scope_mismatch",
        actor: "human",
        targetKey: "o/r#1",
        outcome: "completed",
        metadata: { verdict },
        createdAt: inWindow,
      });
    }
    // One run per sibling event type, plus one with a missing verdict (counts as unchanged, never vanishes).
    await recordAuditEvent(env, {
      eventType: "calibration.threshold_backtest_run",
      actor: "loopover",
      targetKey: "o/r#2",
      outcome: "completed",
      metadata: { comparison: { ruleId: "x", verdict: "regressed" } },
      createdAt: inWindow,
    });
    await recordAuditEvent(env, {
      eventType: "calibration.logic_backtest_run",
      actor: "loopover",
      targetKey: "o/r#3",
      outcome: "completed",
      metadata: { comparison: { ruleId: "x", verdict: "improved" } },
      createdAt: inWindow,
    });
    await recordAuditEvent(env, {
      eventType: "calibration.logic_backtest_run",
      actor: "loopover",
      targetKey: "o/r#4",
      outcome: "completed",
      metadata: {},
      createdAt: inWindow,
    });
    // Outside the window — must be excluded by the SQL since-filter.
    await recordAuditEvent(env, {
      eventType: "signal.rule_fired:linked_issue_scope_mismatch",
      actor: "loopover",
      targetKey: "o/r#5",
      outcome: "completed",
      metadata: { outcome: "unaddressed" },
      createdAt: new Date(NOW - (CALIBRATION_TREND_WEEKS + 2) * WEEK_MS).toISOString(),
    });
  }

  it("reads fired/override/run history out of audit_events and buckets it", async () => {
    const env = createTestEnv();
    await seed(env);
    const trend = await loadCalibrationTrend(env, NOW);
    const rule = trend.rules.find((entry) => entry.ruleId === "linked_issue_scope_mismatch");
    const priorWeek = rule!.weeks.find((week) => week.weekStart === priorMonday);
    expect(priorWeek).toEqual({ weekStart: priorMonday, fired: 1, confirmed: 3, reversed: 1, precisionPct: 75, unrecognized: 0 });
    const runWeek = trend.backtestRuns.find((week) => week.weekStart === priorMonday);
    expect(runWeek).toEqual({ weekStart: priorMonday, runs: 3, regressed: 1, improved: 1, unchanged: 1 });
  });

  it("returns an empty-but-shaped report on a fresh database", async () => {
    const trend = await loadCalibrationTrend(createTestEnv(), NOW);
    expect(trend.rules).toEqual([]);
    expect(trend.backtestRuns).toHaveLength(CALIBRATION_TREND_WEEKS);
    expect(trend.backtestRuns.every((week) => week.runs === 0)).toBe(true);
  });
});

describe("GET /v1/internal/calibration-trend (#8113)", () => {
  it("401s without the internal token (the /v1/internal/* middleware gate)", async () => {
    const app = createApp();
    const env = createTestEnv();
    expect((await app.request("/v1/internal/calibration-trend", {}, env)).status).toBe(401);
    expect((await app.request("/v1/internal/calibration-trend", { headers: { authorization: "Bearer nope" } }, env)).status).toBe(401);
  });

  it("200s with the report shape and stays aggregate-only (no PR content, no raw context, no private terms)", async () => {
    const app = createApp();
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "signal.rule_fired:duplicate_pr_risk",
      actor: "loopover",
      targetKey: "o/r#9",
      outcome: "completed",
      metadata: { outcome: "warning", diff: "SECRET-DIFF-CONTENT-MUST-NOT-LEAK" },
      createdAt: new Date().toISOString(),
    });
    const res = await app.request("/v1/internal/calibration-trend", { headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: Array<{ ruleId: string }>; backtestRuns: unknown[] };
    expect(body.rules.map((rule) => rule.ruleId)).toContain("duplicate_pr_risk");
    expect(Array.isArray(body.backtestRuns)).toBe(true);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("SECRET-DIFF-CONTENT-MUST-NOT-LEAK");
    expect(raw).not.toMatch(/reward|payout|trust|wallet|hotkey/i);
  });
});
