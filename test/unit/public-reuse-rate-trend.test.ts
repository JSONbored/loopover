import { describe, expect, it } from "vitest";
import {
  MIN_REUSE_RATE_TREND_SAMPLE,
  PUBLIC_REUSE_RATE_TREND_WEEKS,
  buildPublicReuseRateTrend,
  loadPublicReuseRateTrend,
} from "../../src/services/public-reuse-rate-trend";
import { isoWeekStart } from "../../src/services/public-quality-metrics";
import { recordAuditEvent } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const NOW = Date.parse("2026-06-22T12:00:00.000Z");

describe("buildPublicReuseRateTrend", () => {
  it("buckets day rows into weekly totals and computes hits / (hits + misses)", () => {
    const currentMonday = isoWeekStart(NOW);
    const priorMonday = isoWeekStart(NOW - 7 * 86_400_000);
    const trend = buildPublicReuseRateTrend(
      [
        { day: priorMonday, hits: 8, misses: 2 },
        { day: priorMonday, hits: 1, misses: 0 }, // a second day in the SAME week -- must accumulate
        { day: currentMonday, hits: 5, misses: 5 },
      ],
      NOW,
      2,
    );
    expect(trend).toHaveLength(2);
    expect(trend[0]).toEqual({ weekStart: priorMonday, hits: 9, misses: 2, reuseRatePct: 81.8 });
    expect(trend[1]).toEqual({ weekStart: currentMonday, hits: 5, misses: 5, reuseRatePct: 50 });
  });

  it("REGRESSION: ignores day rows outside the trailing window instead of letting them corrupt the oldest bucket", () => {
    const currentMonday = isoWeekStart(NOW);
    const tooOld = isoWeekStart(NOW - 30 * 86_400_000);
    const trend = buildPublicReuseRateTrend([{ day: tooOld, hits: 999, misses: 999 }, { day: currentMonday, hits: MIN_REUSE_RATE_TREND_SAMPLE, misses: 0 }], NOW, 2);
    expect(trend[0]).toMatchObject({ hits: 0, misses: 0 });
    expect(trend[1]).toMatchObject({ hits: MIN_REUSE_RATE_TREND_SAMPLE, misses: 0 });
  });

  it("ignores an unparseable day string rather than throwing or corrupting a bucket", () => {
    const currentMonday = isoWeekStart(NOW);
    const trend = buildPublicReuseRateTrend([{ day: "not-a-date", hits: 5, misses: 5 }, { day: currentMonday, hits: MIN_REUSE_RATE_TREND_SAMPLE, misses: 0 }], NOW, 1);
    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({ hits: MIN_REUSE_RATE_TREND_SAMPLE, misses: 0 });
  });

  it("returns null reuseRatePct (not a misleading 0% or 100%) below MIN_REUSE_RATE_TREND_SAMPLE total attempts", () => {
    const week = isoWeekStart(NOW);
    const trend = buildPublicReuseRateTrend([{ day: week, hits: MIN_REUSE_RATE_TREND_SAMPLE - 1, misses: 0 }], NOW, 1);
    expect(trend[0]?.reuseRatePct).toBeNull();
  });

  it("returns a real percentage at exactly MIN_REUSE_RATE_TREND_SAMPLE total attempts", () => {
    const week = isoWeekStart(NOW);
    const trend = buildPublicReuseRateTrend([{ day: week, hits: MIN_REUSE_RATE_TREND_SAMPLE, misses: 0 }], NOW, 1);
    expect(trend[0]?.reuseRatePct).toBe(100);
  });

  it("defaults to PUBLIC_REUSE_RATE_TREND_WEEKS trailing weeks when weeks is omitted", () => {
    const trend = buildPublicReuseRateTrend([], NOW);
    expect(trend).toHaveLength(PUBLIC_REUSE_RATE_TREND_WEEKS);
  });

  it("returns all-zero, null-rate buckets for an empty input (a brand-new / not-yet-enabled deployment)", () => {
    const trend = buildPublicReuseRateTrend([], NOW, 3);
    expect(trend).toHaveLength(3);
    for (const week of trend) expect(week).toMatchObject({ hits: 0, misses: 0, reuseRatePct: null });
  });
});

describe("loadPublicReuseRateTrend — end-to-end over the real live audit_events ledger", () => {
  it("counts every github_app.*_cache_hit / *_cache_miss event, plus ai_review's three non-suffix reuse variants, as hits/misses", async () => {
    const env = createTestEnv();
    const thisMonday = isoWeekStart(NOW);
    const thisWeekIso = `${thisMonday}T09:00:00.000Z`;

    // Two genuinely different instrumented capabilities' hits.
    await recordAuditEvent(env, { eventType: "github_app.grounding_cache_hit", targetKey: "owner/repo", outcome: "completed", createdAt: thisWeekIso });
    await recordAuditEvent(env, { eventType: "github_app.impact_map_cache_hit", targetKey: "owner/repo", outcome: "completed", createdAt: thisWeekIso });
    // A miss from a third capability.
    await recordAuditEvent(env, { eventType: "github_app.review_memory_cache_miss", targetKey: "owner/repo", outcome: "completed", createdAt: thisWeekIso });
    // All three ai_review reuse variants -- each counts as a "hit" (avoided a redundant AI call).
    await recordAuditEvent(env, { eventType: "github_app.ai_review_frozen_reuse", targetKey: "owner/repo#1", outcome: "completed", createdAt: thisWeekIso });
    await recordAuditEvent(env, { eventType: "github_app.ai_review_paused_reuse", targetKey: "owner/repo#2", outcome: "completed", createdAt: thisWeekIso });
    await recordAuditEvent(env, { eventType: "github_app.ai_review_one_shot_reuse", targetKey: "owner/repo#3", outcome: "completed", createdAt: thisWeekIso });
    // An unrelated event type must NOT be counted at all.
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: "owner/repo#4", outcome: "completed", createdAt: thisWeekIso });

    const trend = await loadPublicReuseRateTrend(env, NOW);
    const currentWeek = trend[trend.length - 1];
    expect(currentWeek?.weekStart).toBe(thisMonday);
    expect(currentWeek?.hits).toBe(5); // grounding_hit + impact_map_hit + 3 ai_review reuse variants
    expect(currentWeek?.misses).toBe(1); // review_memory_miss only
  });

  it("returns all-zero buckets when no instrumented events exist yet", async () => {
    const env = createTestEnv();
    const trend = await loadPublicReuseRateTrend(env, NOW);
    for (const week of trend) expect(week).toMatchObject({ hits: 0, misses: 0, reuseRatePct: null });
  });
});
