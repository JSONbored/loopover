import { describe, expect, it } from "vitest";
import type { GateOutcomeRecord, PullRequestRecord } from "../../src/types";
import {
  PUBLIC_QUALITY_TREND_WEEKS,
  buildPublicQualityMetricsFromRecords,
  buildPublicQualityTrend,
  gatePrecisionPct,
  isoWeekStart,
  loadPublicQualityMetrics,
  mergeRatioPct,
} from "../../src/services/public-quality-metrics";
import { recordGateBlockOutcome, upsertPullRequestFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const NOW = Date.parse("2026-06-22T12:00:00.000Z");
const GENERATED = "2026-06-22T12:00:00.000Z";

function pr(
  number: number,
  outcome: "merged" | "closed" | "open",
  opts: { mergedAt?: string; updatedAt?: string; slopBand?: string; slopRisk?: number } = {},
): PullRequestRecord {
  return {
    repoFullName: "owner/repo",
    number,
    title: `PR ${number}`,
    state: outcome === "open" ? "open" : "closed",
    mergedAt: opts.mergedAt ?? (outcome === "merged" ? "2026-06-20T00:00:00.000Z" : null),
    updatedAt: opts.updatedAt ?? "2026-06-20T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    slopBand: opts.slopBand,
    slopRisk: opts.slopRisk,
    labels: [],
    linkedIssues: [],
  };
}

function block(
  pullNumber: number,
  code: string,
  blockedAt: string,
  overridden = false,
): GateOutcomeRecord {
  return { repoFullName: "owner/repo", pullNumber, blockerCodes: [code], overridden, blockedAt };
}

describe("gatePrecisionPct", () => {
  it("returns the precision complement when a false-positive rate is known", () => {
    expect(gatePrecisionPct(0.2)).toBe(80);
    expect(gatePrecisionPct(0)).toBe(100);
  });
  it("returns null when the false-positive rate is unknown", () => {
    expect(gatePrecisionPct(null)).toBeNull();
  });
});

describe("mergeRatioPct", () => {
  it("returns the merged share of terminal outcomes", () => {
    expect(mergeRatioPct(3, 1)).toBe(75);
  });
  it("returns null when nothing is decided", () => {
    expect(mergeRatioPct(0, 0)).toBeNull();
  });
});

describe("isoWeekStart", () => {
  it("returns the UTC Monday for a mid-week timestamp", () => {
    expect(isoWeekStart(Date.parse("2026-06-18T15:00:00.000Z"))).toBe("2026-06-15");
  });
  it("rolls Sunday back to the prior Monday", () => {
    expect(isoWeekStart(Date.parse("2026-06-21T15:00:00.000Z"))).toBe("2026-06-15");
  });
});

describe("buildPublicQualityTrend", () => {
  it("buckets gate blocks and terminal outcomes into weekly public-safe counts", () => {
    const currentMonday = isoWeekStart(NOW);
    const priorMonday = isoWeekStart(NOW - 7 * 86_400_000);
    const trend = buildPublicQualityTrend(
      [
        block(1, "slop_risk", `${currentMonday}T10:00:00.000Z`),
        block(2, "slop_risk", `${priorMonday}T10:00:00.000Z`),
        block(3, "slop_risk", `${priorMonday}T11:00:00.000Z`),
        block(4, "slop_risk", `${priorMonday}T12:00:00.000Z`),
        { repoFullName: "owner/repo", pullNumber: 99, blockerCodes: ["x"], overridden: false },
      ],
      [
        pr(1, "merged", { mergedAt: `${currentMonday}T12:00:00.000Z` }),
        pr(2, "merged", { mergedAt: `${priorMonday}T13:00:00.000Z` }),
        pr(3, "closed", { updatedAt: `${priorMonday}T14:00:00.000Z` }),
        pr(4, "closed", { updatedAt: `${priorMonday}T15:00:00.000Z` }),
        pr(5, "closed", { updatedAt: `${priorMonday}T16:00:00.000Z` }),
        pr(6, "open"),
      ],
      NOW,
      2,
    );
    expect(trend).toHaveLength(2);
    expect(trend[0]?.weekStart).toBe(priorMonday);
    expect(trend[0]).toMatchObject({
      gateBlocked: 3,
      gateBlockedThenMerged: 1,
      gateFalsePositiveRate: 0.333,
      outcomesMerged: 1,
      outcomesClosed: 3,
      mergeRatioPct: 25,
    });
    expect(trend[1]).toMatchObject({
      weekStart: currentMonday,
      gateBlocked: 1,
      gateBlockedThenMerged: 1,
      gateFalsePositiveRate: null,
      outcomesMerged: 1,
      outcomesClosed: 0,
      mergeRatioPct: 100,
    });
  });

  it("ignores events outside the trailing window and rows without timestamps", () => {
    const trend = buildPublicQualityTrend(
      [block(1, "x", "2020-01-01T00:00:00.000Z")],
      [pr(1, "merged", { mergedAt: "2020-01-02T00:00:00.000Z" })],
      NOW,
      PUBLIC_QUALITY_TREND_WEEKS,
    );
    expect(trend.every((row) => row.gateBlocked === 0 && row.outcomesMerged === 0)).toBe(true);
  });
});

describe("buildPublicQualityMetricsFromRecords", () => {
  it("assembles gate precision, outcomes, slop calibration, and trend from existing telemetry", () => {
    const blocks: GateOutcomeRecord[] = [];
    const pullRequests: PullRequestRecord[] = [];
    for (let i = 1; i <= 6; i += 1) {
      blocks.push(block(i, "missing_linked_issue", "2026-06-10T00:00:00.000Z"));
      pullRequests.push(
        pr(i, i <= 2 ? "merged" : "closed", {
          slopBand: "clean",
          slopRisk: 0.1,
          ...(i <= 2 ? { mergedAt: "2026-06-11T00:00:00.000Z" } : {}),
          updatedAt: "2026-06-11T00:00:00.000Z",
        }),
      );
    }
    const payload = buildPublicQualityMetricsFromRecords("owner/repo", blocks, pullRequests, GENERATED, NOW);
    expect(payload.repoFullName).toBe("owner/repo");
    expect(payload.gate).toMatchObject({
      blocked: 6,
      blockedThenMerged: 2,
      falsePositiveRate: 0.333,
      precisionPct: 66.7,
    });
    expect(payload.gate.topGateTypes[0]).toMatchObject({
      gateType: "missing_linked_issue",
      blocked: 6,
      blockedThenMerged: 2,
      precisionPct: 66.7,
    });
    expect(payload.outcomes).toMatchObject({ merged: 2, closed: 4, mergeRatioPct: 33.3 });
    expect(payload.slop.totalResolved).toBe(6);
    expect(payload.trend).toHaveLength(PUBLIC_QUALITY_TREND_WEEKS);
  });

  it("nulls slop merge rate when there is no resolved slop sample", () => {
    const payload = buildPublicQualityMetricsFromRecords(
      "owner/repo",
      [],
      [pr(1, "open")],
      GENERATED,
      NOW,
    );
    expect(payload.slop).toMatchObject({
      totalResolved: 0,
      overallMergeRate: null,
      discriminates: null,
    });
    expect(payload.outcomes.mergeRatioPct).toBeNull();
  });
});

describe("loadPublicQualityMetrics (env loader)", () => {
  it("loads gate/outcome telemetry and assembles the public-safe payload", async () => {
    const env = createTestEnv();
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 1, blockerCodes: ["slop_risk"] });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "merged", state: "closed", merged_at: "2026-06-01T00:00:00.000Z" });
    const payload = await loadPublicQualityMetrics(env, "owner/repo");
    expect(payload.repoFullName).toBe("owner/repo");
    expect(payload.gate.blocked).toBe(1);
    expect(JSON.stringify(payload)).not.toMatch(/reward|payout|trust score|wallet|hotkey|login|actor/i);
  });
});
