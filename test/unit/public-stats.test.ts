import { describe, expect, it } from "vitest";
import { getPublicStats, isPublicStatsEnabled, MINUTES_SAVED_PER_PR } from "../../src/review/public-stats";

type Row = Record<string, unknown>;

// Stub D1: route reads by SQL (FROM table + clause). Supports prepare(sql).all() and prepare(sql).bind(...).all().
function stubEnv(handler: (sql: string, args: unknown[]) => Row[]): Env {
  const make = (sql: string, args: unknown[]) => ({
    bind: (...a: unknown[]) => make(sql, a),
    all: async () => ({ results: handler(sql, args) }),
  });
  return { DB: { prepare: (sql: string) => make(sql, []) } } as unknown as Env;
}

const NOW = Date.parse("2026-06-22T00:00:00Z");

describe("isPublicStatsEnabled", () => {
  it("is truthy only for 1/true/yes/on (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) expect(isPublicStatsEnabled({ GITTENSORY_PUBLIC_STATS: v })).toBe(true);
    for (const v of ["", "0", "false", "off", "no", undefined]) expect(isPublicStatsEnabled({ GITTENSORY_PUBLIC_STATS: v })).toBe(false);
  });
});

describe("getPublicStats — live aggregate over the review ledger", () => {
  // Real prod proportions: merged 1392 + closed 724 + commented 514 + ignored 491 + manual 78 + error 34 = 3233;
  // reviewed = 1392+724+514+78 = 2708; reversed 33 over 2116 auto-actions.
  function ledger(sql: string): Row[] {
    if (sql.includes("FROM review_targets") && sql.includes("GROUP BY project")) {
      return [
        { project: "JSONbored/awesome-claude", handled: 2066, merged: 1231, closed: 524, commented: 200, ignored: 80, manual: 31, error: 0 },
        { project: "JSONbored/metagraphed", handled: 829, merged: 137, closed: 176, commented: 200, ignored: 300, manual: 16, error: 0 },
        { project: "JSONbored/gittensory", handled: 338, merged: 24, closed: 24, commented: 114, ignored: 111, manual: 31, error: 34 },
      ];
    }
    if (sql.includes("FROM review_audit")) {
      return [
        { project: "JSONbored/awesome-claude", reversed: 20 },
        { project: "JSONbored/metagraphed", reversed: 10 },
        { project: "JSONbored/gittensory", reversed: 3 },
      ];
    }
    if (sql.includes("created_at >= ?")) {
      return [{ merged: 900, closed: 300, commented: 200, manual: 20 }];
    }
    return [];
  }

  it("derives reviewed / filtered% / accuracy / time-saved from real-shaped data", async () => {
    const out = await getPublicStats(stubEnv(ledger), NOW);
    expect(out.totals.handled).toBe(3233);
    expect(out.totals.merged).toBe(1392);
    expect(out.totals.closed).toBe(724);
    expect(out.totals.commented).toBe(514);
    expect(out.totals.ignored).toBe(491);
    expect(out.totals.manual).toBe(78);
    expect(out.totals.error).toBe(34);
    expect(out.totals.reversed).toBe(33);
    // reviewed = merged + closed + commented + manual = 2708
    expect(out.totals.reviewed).toBe(2708);
    // filtered = (2708 - 1392) / 2708 = 48.6%
    expect(out.totals.filteredPct).toBe(48.6);
    // accuracy = 1 - 33 / (1392 + 724) = 98.4%
    expect(out.totals.accuracyPct).toBe(98.4);
    // time saved = 2708 * 15 min
    expect(out.totals.minutesSaved).toBe(2708 * MINUTES_SAVED_PER_PR);
    // weekly reviewed = 900 + 300 + 200 + 20 = 1420
    expect(out.weekly).toEqual({ reviewed: 1420, merged: 900 });
    expect(out.byProject.map((p) => p.project)).toEqual([
      "JSONbored/awesome-claude",
      "JSONbored/metagraphed",
      "JSONbored/gittensory",
    ]);
    expect(out.updatedAt).toBe(out.generatedAt);
  });

  it("returns zeroed totals with null derived metrics when the ledger is empty", async () => {
    const out = await getPublicStats(stubEnv(() => []), NOW);
    expect(out.totals.handled).toBe(0);
    expect(out.totals.reviewed).toBe(0);
    expect(out.totals.filteredPct).toBeNull();
    expect(out.totals.accuracyPct).toBeNull();
    expect(out.totals.minutesSaved).toBe(0);
    expect(out.byProject).toEqual([]);
    expect(out.weekly).toEqual({ reviewed: 0, merged: 0 });
  });

  it("is fail-safe: a throwing read degrades to zeros, not an error", async () => {
    const env = stubEnv((sql) => {
      if (sql.includes("GROUP BY project")) throw new Error("review_targets down");
      return [];
    });
    const out = await getPublicStats(env, NOW);
    expect(out.totals.handled).toBe(0);
    expect(out.totals.accuracyPct).toBeNull();
  });
});
