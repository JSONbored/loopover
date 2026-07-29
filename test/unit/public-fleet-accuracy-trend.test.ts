import { describe, expect, it } from "vitest";
import {
  buildPublicFleetAccuracyTrend,
  loadPublicFleetAccuracyTrend,
  MIN_FLEET_TREND_VERDICTS,
  PUBLIC_FLEET_TREND_WEEKS,
  type FleetTrendCell,
} from "../../src/services/public-fleet-accuracy-trend";
import { isoWeekStart } from "../../src/services/public-quality-metrics";
import { createTestEnv } from "../helpers/d1";

// #9676: the fleet-population weekly series. Load-bearing properties: it uses decisionAccuracy (the
// headline's estimand, #8820) rather than 1 - reversalRate, it counts only scored merge/close verdicts, and
// it only ever sees REGISTERED instances.

const NOW = Date.parse("2026-06-22T12:00:00.000Z");

const cell = (over: Partial<FleetTrendCell> = {}): FleetTrendCell => ({
  weekStart: isoWeekStart(NOW),
  instance_id: "inst",
  verdict: "merge",
  outcome: "merged",
  reversal_flag: "none",
  gate_reasoncode_bucket: "quality",
  n: 1,
  ...over,
});

describe("buildPublicFleetAccuracyTrend (#9676)", () => {
  it("scores decisionAccuracy: confirmed verdicts over scored verdicts", () => {
    const week = isoWeekStart(NOW);
    const trend = buildPublicFleetAccuracyTrend(
      [cell({ n: 8 }), cell({ outcome: "closed", n: 2 })], // 8 confirmed merges, 2 merges that closed instead
      NOW,
      1,
    );
    expect(trend[0]).toEqual({ weekStart: week, verdicts: 10, accuracyPct: 80 });
  });

  it("INVARIANT: uses decisionAccuracy, NOT 1 - reversalRate -- holds must not dilute it", () => {
    // 5 confirmed merges plus 95 holds. The reversal formula would divide by all 100 and report ~100%
    // regardless of gate quality; decisionAccuracy scores only the 5 decisions the gate actually made.
    const trend = buildPublicFleetAccuracyTrend([cell({ n: 5 }), cell({ verdict: "hold", n: 95 })], NOW, 1);
    expect(trend[0]?.verdicts).toBe(5);
    expect(trend[0]?.accuracyPct).toBe(100);
  });

  it("counts a reverted merge and a reopened/superseded close as the gate being wrong", () => {
    const reverted = buildPublicFleetAccuracyTrend([cell({ n: 5 }), cell({ reversal_flag: "reverted", n: 5 })], NOW, 1);
    expect(reverted[0]?.accuracyPct).toBe(50);
    for (const flag of ["reopened", "superseded"] as const) {
      const closes = buildPublicFleetAccuracyTrend(
        [cell({ verdict: "close", outcome: "closed", n: 5 }), cell({ verdict: "close", outcome: "closed", reversal_flag: flag, n: 5 })],
        NOW,
        1,
      );
      expect(closes[0]?.accuracyPct).toBe(50);
    }
  });

  it("excludes policy_action rows from scoring entirely (#8825), rather than inflating either side", () => {
    const trend = buildPublicFleetAccuracyTrend(
      [cell({ n: 5 }), cell({ gate_reasoncode_bucket: "policy_action", verdict: "close", outcome: "closed", n: 50 })],
      NOW,
      1,
    );
    expect(trend[0]).toEqual({ weekStart: isoWeekStart(NOW), verdicts: 5, accuracyPct: 100 });
  });

  it("redacts a week below the verdict floor rather than publishing a coin flip", () => {
    const trend = buildPublicFleetAccuracyTrend([cell({ n: MIN_FLEET_TREND_VERDICTS - 1 })], NOW, 1);
    expect(trend[0]).toMatchObject({ verdicts: null, accuracyPct: null });
  });

  it("publishes at exactly the floor", () => {
    expect(buildPublicFleetAccuracyTrend([cell({ n: MIN_FLEET_TREND_VERDICTS })], NOW, 1)[0]?.accuracyPct).toBe(100);
  });

  it("redacts a week of holds only -- activity without a single scored decision", () => {
    const trend = buildPublicFleetAccuracyTrend([cell({ verdict: "hold", n: 40 })], NOW, 1);
    expect(trend[0]).toMatchObject({ verdicts: null, accuracyPct: null });
  });

  it("buckets into trailing UTC-Monday weeks and ignores rows outside the window", () => {
    const current = isoWeekStart(NOW);
    const prior = isoWeekStart(NOW - 7 * 86_400_000);
    const ancient = isoWeekStart(NOW - 60 * 86_400_000);
    const trend = buildPublicFleetAccuracyTrend(
      [cell({ weekStart: prior, n: 10 }), cell({ weekStart: current, n: 5 }), cell({ weekStart: ancient, n: 999 })],
      NOW,
      2,
    );
    expect(trend.map((w) => w.weekStart)).toEqual([prior, current]);
    expect(trend.map((w) => w.verdicts)).toEqual([10, 5]);
  });

  it("ignores an unparseable weekStart rather than corrupting a bucket", () => {
    const trend = buildPublicFleetAccuracyTrend([cell({ weekStart: "not-a-date", n: 99 }), cell({ n: 5 })], NOW, 1);
    expect(trend[0]?.verdicts).toBe(5);
  });

  it("returns all-null weeks for empty input, and defaults to PUBLIC_FLEET_TREND_WEEKS", () => {
    const trend = buildPublicFleetAccuracyTrend([], NOW);
    expect(trend).toHaveLength(PUBLIC_FLEET_TREND_WEEKS);
    for (const week of trend) expect(week).toMatchObject({ verdicts: null, accuracyPct: null });
  });
});

describe("loadPublicFleetAccuracyTrend — end to end over orb_signals", () => {
  async function seed(env: Env, input: { instance: string; registered: boolean; rows: Array<{ verdict: string; outcome: string; reversal?: string; decidedAt: string }> }): Promise<void> {
    await env.DB.prepare("INSERT OR IGNORE INTO orb_instances (instance_id, registered) VALUES (?, ?)").bind(input.instance, input.registered ? 1 : 0).run();
    let i = 0;
    for (const row of input.rows) {
      i += 1;
      await env.DB
        .prepare(
          `INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag, gate_reasoncode_bucket, decision_timestamp, received_at)
           VALUES (?, ?, ?, ?, ?, ?, 'quality', ?, ?)`,
        )
        .bind(input.instance, `repo-${input.instance}`, `pr-${input.instance}-${i}`, row.verdict, row.outcome, row.reversal ?? "none", row.decidedAt, row.decidedAt)
        .run();
    }
  }

  const thisWeek = `${isoWeekStart(NOW)}T09:00:00.000Z`;

  it("scores a registered instance's week from real rows", async () => {
    const env = createTestEnv();
    await seed(env, {
      instance: "inst-a",
      registered: true,
      rows: [
        ...Array.from({ length: 8 }, () => ({ verdict: "merge", outcome: "merged", decidedAt: thisWeek })),
        ...Array.from({ length: 2 }, () => ({ verdict: "merge", outcome: "closed", decidedAt: thisWeek })),
      ],
    });
    const trend = await loadPublicFleetAccuracyTrend(env, NOW);
    expect(trend[trend.length - 1]).toEqual({ weekStart: isoWeekStart(NOW), verdicts: 10, accuracyPct: 80 });
  });

  it("INVARIANT: an UNREGISTERED instance never moves a published number", async () => {
    // The ingest is open, so a stranger's signals must not reach the public surface until a human opts them
    // in -- the same trust gate computeFleetAnalytics applies to the headline.
    const env = createTestEnv();
    await seed(env, {
      instance: "stranger",
      registered: false,
      rows: Array.from({ length: 40 }, () => ({ verdict: "merge", outcome: "closed", decidedAt: thisWeek })),
    });
    const trend = await loadPublicFleetAccuracyTrend(env, NOW);
    for (const week of trend) expect(week).toMatchObject({ verdicts: null, accuracyPct: null });
  });

  it("pools registered instances within a week", async () => {
    const env = createTestEnv();
    await seed(env, { instance: "a", registered: true, rows: Array.from({ length: 5 }, () => ({ verdict: "merge", outcome: "merged", decidedAt: thisWeek })) });
    await seed(env, { instance: "b", registered: true, rows: Array.from({ length: 5 }, () => ({ verdict: "merge", outcome: "closed", decidedAt: thisWeek })) });
    expect((await loadPublicFleetAccuracyTrend(env, NOW))[PUBLIC_FLEET_TREND_WEEKS - 1]).toMatchObject({ verdicts: 10, accuracyPct: 50 });
  });

  it("buckets by when the gate DECIDED, not when the row was received", async () => {
    // A late export must not pile older decisions into the week it arrived.
    const env = createTestEnv();
    const priorWeek = `${isoWeekStart(NOW - 7 * 86_400_000)}T09:00:00.000Z`;
    await env.DB.prepare("INSERT OR IGNORE INTO orb_instances (instance_id, registered) VALUES ('late', 1)").run();
    for (let i = 0; i < 6; i += 1) {
      await env.DB
        .prepare(
          `INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag, gate_reasoncode_bucket, decision_timestamp, received_at)
           VALUES ('late', 'r', ?, 'merge', 'merged', 'none', 'quality', ?, ?)`,
        )
        .bind(`pr-${i}`, priorWeek, thisWeek)
        .run();
    }
    const trend = await loadPublicFleetAccuracyTrend(env, NOW);
    expect(trend[trend.length - 2]).toMatchObject({ verdicts: 6 });
    expect(trend[trend.length - 1]).toMatchObject({ verdicts: null });
  });

  it("drops a row whose timestamp column is unparseable rather than bucketing it to the epoch", async () => {
    // decision_timestamp is TEXT with no format constraint, so a malformed value is reachable in practice.
    // It must be dropped explicitly, not silently land somewhere via Date.parse -> NaN arithmetic.
    const env = createTestEnv();
    await env.DB.prepare("INSERT OR IGNORE INTO orb_instances (instance_id, registered) VALUES ('bad', 1)").run();
    for (let i = 0; i < 6; i += 1) {
      await env.DB
        .prepare(
          `INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag, gate_reasoncode_bucket, decision_timestamp, received_at)
           VALUES ('bad', 'r', ?, 'merge', 'merged', 'none', 'quality', 'not-a-timestamp', 'not-a-timestamp')`,
        )
        .bind(`pr-${i}`)
        .run();
    }
    const trend = await loadPublicFleetAccuracyTrend(env, NOW);
    for (const week of trend) expect(week).toMatchObject({ verdicts: null, accuracyPct: null });
  });

  it("degrades to all-null weeks (never throws) when the read fails", async () => {
    const broken = createTestEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    const trend = await loadPublicFleetAccuracyTrend(broken, NOW);
    expect(trend).toHaveLength(PUBLIC_FLEET_TREND_WEEKS);
    for (const week of trend) expect(week).toMatchObject({ verdicts: null, accuracyPct: null });
  });
});
