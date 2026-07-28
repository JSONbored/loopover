import { describe, expect, it, } from "vitest";
import { createTestEnv } from "../helpers/d1";
import {
  aggregateCycleTimePercentiles,
  aggregateFindingAcceptance,
  aggregateReviewEffort,
  buildCycleTimeDistribution,
  computeFindingAcceptance,
  cycleTimeMs,
  EMPTY_CYCLE_TIME,
  EMPTY_FINDING_ACCEPTANCE,
  isParityCutoverReady,
  MIN_PARITY_SAMPLE,
  PARITY_AGREEMENT_FLOOR,
  percentileNearestRank,
  type GateParityRow,
} from "../../src/review/stats";

// Stub D1: route by table name — review_audit → reversals, else decision rows.
const NOW = Date.parse("2026-06-14T00:00:00Z");

describe("aggregateReviewEffort — maintainer complexity fold (#2155)", () => {
  it("returns null avgBand and 0 total minutes for an empty sample", () => {
    expect(aggregateReviewEffort([])).toEqual({ avgBand: null, totalEstimatedMinutes: 0 });
  });

  it("averages bands and sums minutes across per-PR samples", () => {
    // minutes 4 -> band 1; minutes 96 -> band 4 -> rounded avg 3; total 100.
    expect(aggregateReviewEffort([4, 96])).toEqual({ avgBand: 3, totalEstimatedMinutes: 100 });
  });

  it("keeps boundary-rounded minutes in the higher possible avgBand (regression for #2155)", () => {
    expect(aggregateReviewEffort([5, 20, 60, 150])).toEqual({ avgBand: 4, totalEstimatedMinutes: 235 });
  });
});

describe("cycle-time aggregation (#2194)", () => {
  it("cycleTimeMs rejects negative and non-finite deltas", () => {
    expect(cycleTimeMs("2026-06-01T10:00:00Z", "2026-06-01T09:00:00Z")).toBeNull();
    expect(cycleTimeMs("bad", "2026-06-01T09:00:00Z")).toBeNull();
    expect(cycleTimeMs("2026-06-01T10:00:00Z", "2026-06-01T10:05:00Z")).toBe(300_000);
  });

  it("percentileNearestRank uses nearest-rank on sorted samples", () => {
    const sorted = [100, 200, 300, 400];
    expect(percentileNearestRank(sorted, 50)).toBe(200);
    expect(percentileNearestRank(sorted, 90)).toBe(400);
    expect(percentileNearestRank([], 50)).toBeNull();
  });

  it("buildCycleTimeDistribution returns [] for empty input and a single bucket when all samples match", () => {
    expect(buildCycleTimeDistribution([])).toEqual([]);
    expect(buildCycleTimeDistribution([5, 5, 5])).toEqual([3]);
  });

  it("buildCycleTimeDistribution places the max sample in the last bucket (boundary clamp)", () => {
    expect(buildCycleTimeDistribution([0, 100], 2)).toEqual([1, 1]);
  });

  it("aggregateCycleTimePercentiles folds samples into p50/p90/p99 + distribution", () => {
    const agg = aggregateCycleTimePercentiles([60_000, 120_000, 180_000, 240_000, 300_000]);
    expect(agg.sampleSize).toBe(5);
    expect(agg.p50Ms).toBe(180_000);
    expect(agg.p90Ms).toBe(300_000);
    expect(agg.p99Ms).toBe(300_000);
    expect(agg.distribution.length).toBeGreaterThan(0);
  });

  it("aggregateCycleTimePercentiles returns EMPTY_CYCLE_TIME for no valid samples", () => {
    expect(aggregateCycleTimePercentiles([])).toEqual(EMPTY_CYCLE_TIME);
    expect(aggregateCycleTimePercentiles([-1, Number.NaN])).toEqual(EMPTY_CYCLE_TIME);
  });

  it("computeCycleTimeAggregate reads paired review_audit rows from D1", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES
        ('gd1', 'owner/repo', 'owner/repo#1', 'gate_decision', 'merge', 'test', '2026-06-10T10:00:00Z'),
        ('po1', 'owner/repo', 'owner/repo#1', 'pr_outcome', 'merged', 'test', '2026-06-10T10:10:00Z'),
        ('gd2', 'owner/repo', 'owner/repo#2', 'gate_decision', 'close', 'test', '2026-06-11T10:00:00Z'),
        ('po2', 'owner/repo', 'owner/repo#2', 'pr_outcome', 'closed', 'test', '2026-06-11T10:30:00Z')`,
    ).run();
    const { computeCycleTimeAggregate } = await import("../../src/review/stats");
    const agg = await computeCycleTimeAggregate(env, { days: 90, nowMs: NOW });
    expect(agg.sampleSize).toBe(2);
    expect(agg.p50Ms).toBe(600_000);
    expect(agg.distribution.length).toBeGreaterThan(0);
  });

  it("computeCycleTimeAggregate fails safe to EMPTY_CYCLE_TIME when the query rejects", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              throw new Error("d1 down");
            },
          }),
        }),
      },
    } as unknown as Env;
    const { computeCycleTimeAggregate } = await import("../../src/review/stats");
    expect(await computeCycleTimeAggregate(env, { days: 30, nowMs: NOW })).toEqual(EMPTY_CYCLE_TIME);
  });

  it("computeCycleTimeAggregate defaults non-finite/non-positive days to 90", async () => {
    let boundFrom: string | undefined;
    const env = {
      DB: {
        prepare: () => ({
          bind: (fromIso: string) => {
            boundFrom = fromIso;
            return { all: async () => ({ results: [] as Array<{ decided_at: string; outcome_at: string }> }) };
          },
        }),
      },
    } as unknown as Env;
    const { computeCycleTimeAggregate } = await import("../../src/review/stats");
    await computeCycleTimeAggregate(env, { days: Number.NaN, nowMs: NOW });
    expect(boundFrom).toBe(new Date(NOW - 90 * 86_400_000).toISOString().slice(0, 10));
  });

  it("computeCycleTimeAggregate clamps days to 730", async () => {
    let boundFrom: string | undefined;
    const env = {
      DB: {
        prepare: () => ({
          bind: (fromIso: string) => {
            boundFrom = fromIso;
            return { all: async () => ({ results: [] as Array<{ decided_at: string; outcome_at: string }> }) };
          },
        }),
      },
    } as unknown as Env;
    const { computeCycleTimeAggregate } = await import("../../src/review/stats");
    await computeCycleTimeAggregate(env, { days: 99_999, nowMs: NOW });
    expect(boundFrom).toBe(new Date(NOW - 730 * 86_400_000).toISOString().slice(0, 10));
  });

  it("computeCycleTimeAggregate tolerates missing D1 results and skips null cycle deltas", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({
              results: undefined,
            }),
          }),
        }),
      },
    } as unknown as Env;
    const envWithBadRows = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({
              results: [
                { decided_at: "2026-06-01T10:00:00Z", outcome_at: "2026-06-01T09:00:00Z" },
                { decided_at: "bad", outcome_at: "2026-06-01T09:00:00Z" },
              ],
            }),
          }),
        }),
      },
    } as unknown as Env;
    const { computeCycleTimeAggregate } = await import("../../src/review/stats");
    expect(await computeCycleTimeAggregate(env, { days: 30, nowMs: NOW })).toEqual(EMPTY_CYCLE_TIME);
    expect(await computeCycleTimeAggregate(envWithBadRows, { days: 30, nowMs: NOW })).toEqual(EMPTY_CYCLE_TIME);
  });
});

describe("finding acceptance rate (#1967)", () => {
  it("aggregateFindingAcceptance folds flagged-PR outcomes into the acceptance rate", () => {
    const agg = aggregateFindingAcceptance([{ merged: true }, { merged: true }, { merged: false }]);
    expect(agg).toEqual({ flagged: 3, addressed: 2, unaddressed: 1, acceptanceRate: 0.667 });
  });

  it("aggregateFindingAcceptance reports 1 / 0 acceptance at the extremes (both filter branches)", () => {
    expect(aggregateFindingAcceptance([{ merged: true }, { merged: true }])).toEqual({
      flagged: 2,
      addressed: 2,
      unaddressed: 0,
      acceptanceRate: 1,
    });
    expect(aggregateFindingAcceptance([{ merged: false }, { merged: false }])).toEqual({
      flagged: 2,
      addressed: 0,
      unaddressed: 2,
      acceptanceRate: 0,
    });
  });

  it("aggregateFindingAcceptance returns EMPTY_FINDING_ACCEPTANCE for no samples", () => {
    expect(aggregateFindingAcceptance([])).toEqual(EMPTY_FINDING_ACCEPTANCE);
  });

  it("computeFindingAcceptance joins EVER-flagged (hold|close) PRs to their latest outcome from real D1", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES
        ('gd1', 'owner/repo', 'owner/repo#1', 'gate_decision', 'close', 'test', '2026-06-10T10:00:00Z'),
        ('po1', 'owner/repo', 'owner/repo#1', 'pr_outcome', 'merged', 'test', '2026-06-10T12:00:00Z'),
        ('gd2', 'owner/repo', 'owner/repo#2', 'gate_decision', 'hold', 'test', '2026-06-11T10:00:00Z'),
        ('po2', 'owner/repo', 'owner/repo#2', 'pr_outcome', 'closed', 'test', '2026-06-11T12:00:00Z'),
        ('gd3a', 'owner/repo', 'owner/repo#3', 'gate_decision', 'hold', 'test', '2026-06-12T09:00:00Z'),
        ('gd3b', 'owner/repo', 'owner/repo#3', 'gate_decision', 'hold', 'test', '2026-06-12T10:00:00Z'),
        ('po3a', 'owner/repo', 'owner/repo#3', 'pr_outcome', 'closed', 'test', '2026-06-12T11:00:00Z'),
        ('po3b', 'owner/repo', 'owner/repo#3', 'pr_outcome', 'merged', 'test', '2026-06-12T12:00:00Z'),
        ('gd4', 'owner/repo', 'owner/repo#4', 'gate_decision', 'merge', 'test', '2026-06-13T10:00:00Z'),
        ('po4', 'owner/repo', 'owner/repo#4', 'pr_outcome', 'merged', 'test', '2026-06-13T12:00:00Z'),
        ('gd5', 'owner/repo', 'owner/repo#5', 'gate_decision', 'close', 'test', '2026-06-13T10:00:00Z')`,
    ).run();
    const agg = await computeFindingAcceptance(env, { days: 90, nowMs: NOW });
    // #1 close→merged (addressed) and #3 hold→(closed then MERGED, rn=1 latest) (addressed); #2 hold→closed
    // (unaddressed); #4 merge→merged is a CLEAN merge (not flagged); #5 close has no outcome yet (not counted).
    expect(agg).toEqual({ flagged: 3, addressed: 2, unaddressed: 1, acceptanceRate: 0.667 });
  });

  it("computeFindingAcceptance fails safe to EMPTY_FINDING_ACCEPTANCE when the query rejects", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              throw new Error("d1 down");
            },
          }),
        }),
      },
    } as unknown as Env;
    expect(await computeFindingAcceptance(env, { days: 30, nowMs: NOW })).toEqual(EMPTY_FINDING_ACCEPTANCE);
  });

  it("computeFindingAcceptance tolerates missing D1 results (the ?? [] fallback)", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ results: undefined }),
          }),
        }),
      },
    } as unknown as Env;
    expect(await computeFindingAcceptance(env, { days: 30, nowMs: NOW })).toEqual(EMPTY_FINDING_ACCEPTANCE);
  });

  it("computeFindingAcceptance defaults a non-finite / non-positive window to 90 days and clamps to 730", async () => {
    let boundFrom: string | undefined;
    const env = {
      DB: {
        prepare: () => ({
          bind: (fromIso: string) => {
            boundFrom = fromIso;
            return { all: async () => ({ results: [] as Array<{ truth: string }> }) };
          },
        }),
      },
    } as unknown as Env;
    await computeFindingAcceptance(env, { days: Number.NaN, nowMs: NOW });
    expect(boundFrom).toBe(new Date(NOW - 90 * 86_400_000).toISOString().slice(0, 10));
    await computeFindingAcceptance(env, { days: 0, nowMs: NOW });
    expect(boundFrom).toBe(new Date(NOW - 90 * 86_400_000).toISOString().slice(0, 10));
    await computeFindingAcceptance(env, { days: 99_999, nowMs: NOW });
    expect(boundFrom).toBe(new Date(NOW - 730 * 86_400_000).toISOString().slice(0, 10));
  });
});

describe("isParityCutoverReady — every gate condition", () => {
  const base: GateParityRow = {
    project: "p",
    pairedSamples: MIN_PARITY_SAMPLE,
    bothMerge: MIN_PARITY_SAMPLE,
    bothClose: 0,
    bothHold: 0,
    disagree: 0,
    agreementRate: PARITY_AGREEMENT_FLOOR,
    unsafeDisagreements: 0,
    byReasonCode: [],
  };

  it("is ready when all four conditions hold (enough samples, 0 unsafe, rate at the floor)", () => {
    expect(isParityCutoverReady(base)).toBe(true);
  });

  it("is NOT ready with too few paired samples", () => {
    expect(isParityCutoverReady({ ...base, pairedSamples: MIN_PARITY_SAMPLE - 1 })).toBe(false);
  });

  it("is NOT ready with any unsafe disagreement", () => {
    expect(isParityCutoverReady({ ...base, unsafeDisagreements: 1 })).toBe(false);
  });

  it("is NOT ready when agreementRate is null (the != null guard)", () => {
    expect(isParityCutoverReady({ ...base, agreementRate: null })).toBe(false);
  });

  it("is NOT ready when agreementRate is below the floor", () => {
    expect(isParityCutoverReady({ ...base, agreementRate: PARITY_AGREEMENT_FLOOR - 0.001 })).toBe(false);
  });
});
