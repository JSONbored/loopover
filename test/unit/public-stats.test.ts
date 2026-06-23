import { describe, expect, it } from "vitest";
import {
  getPublicStats,
  isPublicStatsEnabled,
  MINUTES_SAVED_PER_PR,
} from "../../src/review/public-stats";

type Row = Record<string, unknown>;

// Stub D1: route reads by SQL (FROM table + clause). Supports prepare(sql).all() and prepare(sql).bind(...).all().
function stubEnv(handler: (sql: string, args: unknown[]) => Row[]): Env {
  const make = (sql: string, args: unknown[]) => ({
    bind: (...a: unknown[]) => make(sql, a),
    all: async () => ({ results: handler(sql, args) }),
  });
  return {
    DB: { prepare: (sql: string) => make(sql, []) },
    GITTENSORY_REVIEW_REPOS:
      "JSONbored/gittensory,JSONbored/awesome-claude,JSONbored/metagraphed",
  } as unknown as Env;
}

const NOW = Date.parse("2026-06-22T00:00:00Z");

describe("isPublicStatsEnabled", () => {
  it("is truthy only for 1/true/yes/on (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"])
      expect(isPublicStatsEnabled({ GITTENSORY_PUBLIC_STATS: v })).toBe(true);
    for (const v of ["", "0", "false", "off", "no", undefined])
      expect(isPublicStatsEnabled({ GITTENSORY_PUBLIC_STATS: v })).toBe(false);
  });
});

describe("getPublicStats — live aggregate over the review ledger", () => {
  // Real prod proportions: merged 1392 + closed 724 + commented 514 + ignored 491 + manual 78 + error 34 = 3233;
  // reviewed = 1392+724+514+78 = 2708; reversed 33 over 2116 auto-actions.
  function ledger(sql: string): Row[] {
    if (
      sql.includes("FROM review_targets") &&
      sql.includes("GROUP BY project")
    ) {
      return [
        {
          project: "JSONbored/awesome-claude",
          handled: 2066,
          merged: 1231,
          closed: 524,
          commented: 200,
          ignored: 80,
          manual: 31,
          error: 0,
        },
        {
          project: "JSONbored/metagraphed",
          handled: 829,
          merged: 137,
          closed: 176,
          commented: 200,
          ignored: 300,
          manual: 16,
          error: 0,
        },
        {
          project: "JSONbored/gittensory",
          handled: 338,
          merged: 24,
          closed: 24,
          commented: 114,
          ignored: 111,
          manual: 31,
          error: 34,
        },
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

  it("publishes only projects from the reviewed-repo allowlist", async () => {
    const out = await getPublicStats(
      stubEnv((sql, args) => {
        if (sql.includes("FROM review_audit")) {
          return [
            { project: "JSONbored/gittensory", reversed: 1 },
            { project: "CustomerCo/stealth-product", reversed: 1 },
          ].filter((row) => args.includes(String(row.project).toLowerCase()));
        }
        if (sql.includes("created_at >= ?")) {
          const allowed = args.slice(1);
          const weeklyRows = [
            {
              project: "JSONbored/gittensory",
              merged: 1,
              closed: 1,
              commented: 0,
              manual: 0,
            },
            {
              project: "CustomerCo/stealth-product",
              merged: 3,
              closed: 0,
              commented: 0,
              manual: 0,
            },
          ].filter((row) =>
            allowed.includes(String(row.project).toLowerCase()),
          );
          return [
            weeklyRows.reduce(
              (acc, row) => ({
                merged: acc.merged + row.merged,
                closed: acc.closed + row.closed,
                commented: acc.commented + row.commented,
                manual: acc.manual + row.manual,
              }),
              { merged: 0, closed: 0, commented: 0, manual: 0 },
            ),
          ];
        }
        if (sql.includes("GROUP BY project")) {
          return [
            {
              project: "JSONbored/gittensory",
              handled: 2,
              merged: 1,
              closed: 1,
              commented: 0,
              ignored: 0,
              manual: 0,
              error: 0,
            },
            {
              project: "CustomerCo/stealth-product",
              handled: 3,
              merged: 3,
              closed: 0,
              commented: 0,
              ignored: 0,
              manual: 0,
              error: 0,
            },
          ].filter((row) => args.includes(String(row.project).toLowerCase()));
        }
        return [];
      }),
      NOW,
    );

    expect(out.totals.handled).toBe(2);
    expect(out.totals.reviewed).toBe(2);
    expect(out.totals.reversed).toBe(1);
    expect(out.weekly).toEqual({ reviewed: 2, merged: 1 });
    expect(out.byProject.map((p) => p.project)).toEqual([
      "JSONbored/gittensory",
    ]);
  });

  it("publishes no ledger data when the reviewed-repo allowlist is empty", async () => {
    const env = {
      DB: {
        prepare: () => {
          throw new Error("public stats must not query an unscoped ledger");
        },
      },
      GITTENSORY_REVIEW_REPOS: "",
    } as unknown as Env;
    const out = await getPublicStats(env, NOW);
    expect(out.totals.handled).toBe(0);
    expect(out.totals.reviewed).toBe(0);
    expect(out.weekly).toEqual({ reviewed: 0, merged: 0 });
    expect(out.byProject).toEqual([]);
  });

  it("returns zeroed totals with null derived metrics when the ledger is empty", async () => {
    const out = await getPublicStats(
      stubEnv(() => []),
      NOW,
    );
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
      if (sql.includes("GROUP BY project"))
        throw new Error("review_targets down");
      return [];
    });
    const out = await getPublicStats(env, NOW);
    expect(out.totals.handled).toBe(0);
    expect(out.totals.accuracyPct).toBeNull();
  });

  it("coerces null SUM/reversal/weekly fields to 0 (SUM over an empty set returns NULL in SQLite)", async () => {
    // Every numeric column comes back null (the nullish arm of each `?? 0`); p2 has no reversal row, exercising
    // the `reversedByProject.get(...) ?? 0` fallback; weekly[0] is present but its fields are null.
    const out = await getPublicStats(
      stubEnv((sql) => {
        if (sql.includes("FROM review_audit"))
          return [{ project: "p1", reversed: null }];
        if (sql.includes("created_at >= ?"))
          return [
            { merged: null, closed: null, commented: null, manual: null },
          ];
        if (sql.includes("GROUP BY project")) {
          return [
            {
              project: "p1",
              handled: null,
              merged: null,
              closed: null,
              commented: null,
              ignored: null,
              manual: null,
              error: null,
            },
            {
              project: "p2",
              handled: null,
              merged: null,
              closed: null,
              commented: null,
              ignored: null,
              manual: null,
              error: null,
            },
          ];
        }
        return [];
      }),
      NOW,
    );
    expect(out.totals).toMatchObject({
      handled: 0,
      merged: 0,
      closed: 0,
      reversed: 0,
    });
    expect(out.totals.accuracyPct).toBeNull();
    expect(out.totals.minutesSaved).toBe(0);
    expect(out.weekly).toEqual({ reviewed: 0, merged: 0 });
    expect(out.byProject).toEqual([]); // both projects have reviewed 0 → filtered out
  });

  it("degrades a no-results D1 response to [] (safeAll `res.results ?? []`)", async () => {
    // .all() returns an object with no `results` key (defensive arm), so every safeAll yields [].
    const env = {
      DB: {
        prepare: () => {
          const stmt = { bind: () => stmt, all: async () => ({}) };
          return stmt;
        },
      },
    } as unknown as Env;
    const out = await getPublicStats(env, NOW);
    expect(out.totals.handled).toBe(0);
    expect(out.byProject).toEqual([]);
    expect(out.weekly).toEqual({ reviewed: 0, merged: 0 });
  });
});
