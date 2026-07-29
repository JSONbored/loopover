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

  const trendWeek = (trend: Awaited<ReturnType<typeof loadPublicFleetAccuracyTrend>>, weekStart: string) =>
    trend.find((week) => week.weekStart === weekStart);

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

  // #9783: orb_signals now prunes at 90 days, folding into orb_signal_rollups. This series looks back 8
  // weeks, so a week can outlive its raw rows only if the reader unions the rollup back in.
  describe("reads folded history (#9783)", () => {
    const foldedWeek = isoWeekStart(NOW - 3 * 7 * 86_400_000);
    const foldCell = async (env: Env, over: { instance?: string; verdict?: string; outcome?: string; reversal?: string; bucket?: string; n: number }) => {
      await env.DB
        .prepare(
          `INSERT INTO orb_signal_rollups (instance_id, day, gate_verdict, outcome, reversal_flag, gate_reasoncode_bucket, n, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '2026-06-22T00:00:00.000Z')`,
        )
        .bind(over.instance ?? "inst-a", foldedWeek, over.verdict ?? "merge", over.outcome ?? "merged", over.reversal ?? "none", over.bucket ?? "quality", over.n)
        .run();
    };

    it("reconstructs a week whose raw rows are gone, to the SAME number they would have shown", async () => {
      const env = createTestEnv();
      await env.DB.prepare("INSERT INTO orb_instances (instance_id, registered) VALUES ('inst-a', 1)").run();
      await foldCell(env, { n: 8 });
      await foldCell(env, { outcome: "closed", n: 2 });

      const trend = await loadPublicFleetAccuracyTrend(env, NOW);
      expect(trend.find((w) => w.weekStart === foldedWeek)).toEqual({ weekStart: foldedWeek, verdicts: 10, accuracyPct: 80 });
    });

    it("sums a week split across raw rows and folded cells rather than picking one side", async () => {
      // The boundary week: part of it aged out and folded, part is still live. Both halves must count.
      const env = createTestEnv();
      await seed(env, { instance: "inst-a", registered: true, rows: Array.from({ length: 5 }, () => ({ verdict: "merge", outcome: "merged", decidedAt: `${foldedWeek}T09:00:00.000Z` })) });
      await foldCell(env, { outcome: "closed", n: 5 });

      expect(trendWeek(await loadPublicFleetAccuracyTrend(env, NOW), foldedWeek)).toMatchObject({ verdicts: 10, accuracyPct: 50 });
    });

    it("INVARIANT: an UNREGISTERED instance's folded history still never moves a published number", async () => {
      // The fold deliberately keeps unregistered instances (they may be registered later), so the trust gate
      // has to be re-applied at READ time -- otherwise pruning would quietly opt strangers in.
      const env = createTestEnv();
      await env.DB.prepare("INSERT INTO orb_instances (instance_id, registered) VALUES ('stranger', 0)").run();
      await foldCell(env, { instance: "stranger", outcome: "closed", n: 40 });
      for (const week of await loadPublicFleetAccuracyTrend(env, NOW)) expect(week).toMatchObject({ verdicts: null, accuracyPct: null });
    });

    it("REGRESSION: includes the window's FIRST day, which a bare `day >= ?1` string compare drops", async () => {
      // day is 'YYYY-MM-DD' and the bound is a full ISO instant. '2026-05-04' < '2026-05-04T00:00:00.000Z'
      // as strings -- a prefix sorts before the string it prefixes -- so the oldest week would silently
      // vanish the moment its rows were folded.
      const env = createTestEnv();
      const oldestWeek = isoWeekStart(NOW - (PUBLIC_FLEET_TREND_WEEKS - 1) * 7 * 86_400_000);
      await env.DB.prepare("INSERT INTO orb_instances (instance_id, registered) VALUES ('inst-a', 1)").run();
      await env.DB
        .prepare(
          `INSERT INTO orb_signal_rollups (instance_id, day, gate_verdict, outcome, reversal_flag, gate_reasoncode_bucket, n, updated_at)
           VALUES ('inst-a', ?, 'merge', 'merged', 'none', 'quality', 9, '2026-06-22T00:00:00.000Z')`,
        )
        .bind(oldestWeek)
        .run();
      expect(trendWeek(await loadPublicFleetAccuracyTrend(env, NOW), oldestWeek)).toMatchObject({ verdicts: 9 });
    });

    it("scores folded holds and policy_action cells exactly as the live path does", async () => {
      // The fold keeps these cells rather than dropping them, and '' / the real bucket value must go on
      // meaning the same thing to foldInstance after the round trip.
      const env = createTestEnv();
      await env.DB.prepare("INSERT INTO orb_instances (instance_id, registered) VALUES ('inst-a', 1)").run();
      await foldCell(env, { n: 5 });
      await foldCell(env, { verdict: "hold", n: 95 });
      await foldCell(env, { verdict: "close", outcome: "closed", bucket: "policy_action", n: 50 });
      // Empty-string verdict: the fold's COALESCE sentinel for a NULL gate_verdict, which foldInstance must
      // treat as a hold (neither 'merge' nor 'close') exactly as NULL was treated.
      await foldCell(env, { verdict: "", n: 30 });
      expect(trendWeek(await loadPublicFleetAccuracyTrend(env, NOW), foldedWeek)).toMatchObject({ verdicts: 5, accuracyPct: 100 });
    });
  });

  it("degrades to all-null weeks (never throws) when the read fails", async () => {
    const broken = createTestEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    const trend = await loadPublicFleetAccuracyTrend(broken, NOW);
    expect(trend).toHaveLength(PUBLIC_FLEET_TREND_WEEKS);
    for (const week of trend) expect(week).toMatchObject({ verdicts: null, accuracyPct: null });
  });
});
