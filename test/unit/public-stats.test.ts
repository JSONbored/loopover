import { describe, expect, it } from "vitest";
import { createTestEnv } from "../helpers/d1";
import {
  getPublicStats,
  isPublicStatsEnabled,
  MINUTES_SAVED_PER_PR,
} from "../../src/review/public-stats";

type Row = Record<string, unknown>;

// Stub D1: route reads by SQL signature. The three reads are distinguished by:
//   - weekly:       contains `first_seen`
//   - dispositions: contains `github_app.pr_public_surface_published` (and is NOT the weekly read)
//   - reversals:    inspects engine auto-actions (`agent.action.close`)
function stubEnv(handler: (sql: string, args: unknown[]) => Row[]): Env {
  const make = (sql: string, args: unknown[]) => ({
    bind: (...a: unknown[]) => make(sql, a),
    all: async () => ({ results: handler(sql, args) }),
    first: async () => handler(sql, args)[0] ?? null,
  });
  return {
    DB: { prepare: (sql: string) => make(sql, []) },
    GITTENSORY_REVIEW_REPOS:
      "JSONbored/gittensory,JSONbored/awesome-claude,JSONbored/metagraphed",
  } as unknown as Env;
}

const NOW = Date.parse("2026-06-22T00:00:00Z");

function isWeekly(sql: string): boolean {
  return sql.includes("first_seen");
}
function isDispositions(sql: string): boolean {
  return (
    sql.includes("github_app.pr_public_surface_published") && !isWeekly(sql)
  );
}
// The reversal read is the only one that inspects engine auto-actions (close/merge) against pull_requests state.
function isReversal(sql: string): boolean {
  return sql.includes("agent.action.close");
}

describe("isPublicStatsEnabled", () => {
  it("is truthy only for 1/true/yes/on (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"])
      expect(isPublicStatsEnabled({ GITTENSORY_PUBLIC_STATS: v })).toBe(true);
    for (const v of ["", "0", "false", "off", "no", undefined])
      expect(isPublicStatsEnabled({ GITTENSORY_PUBLIC_STATS: v })).toBe(false);
  });
});

describe("getPublicStats — live aggregate over the review ledger", () => {
  // Live shape: distinct reviewed PRs (audit_events) per repo, split by terminal disposition from pull_requests
  // (merged / closed-without-merge / still-open-in-review). reviewed = merged + closed + inReview.
  function ledger(sql: string): Row[] {
    if (isWeekly(sql)) {
      return [{ reviewed: 1420, merged: 900 }];
    }
    if (isDispositions(sql)) {
      return [
        {
          project: "JSONbored/awesome-claude",
          reviewed: 2034,
          merged: 1231,
          closed: 524,
          inReview: 279,
        },
        {
          project: "JSONbored/metagraphed",
          reviewed: 393,
          merged: 137,
          closed: 176,
          inReview: 80,
        },
        {
          project: "JSONbored/gittensory",
          reviewed: 315,
          merged: 24,
          closed: 24,
          inReview: 267,
        },
      ];
    }
    if (isReversal(sql)) {
      return [
        { project: "JSONbored/awesome-claude", reversed: 20 },
        { project: "JSONbored/metagraphed", reversed: 10 },
        { project: "JSONbored/gittensory", reversed: 3 },
      ];
    }
    return [];
  }

  it("derives reviewed / filtered% / accuracy / time-saved from real-shaped data", async () => {
    const out = await getPublicStats(stubEnv(ledger), NOW);
    // handled = reviewed = 2034 + 393 + 315 = 2742
    expect(out.totals.handled).toBe(2742);
    expect(out.totals.merged).toBe(1392); // 1231 + 137 + 24
    expect(out.totals.closed).toBe(724); // 524 + 176 + 24
    expect(out.totals.commented).toBe(626); // still-open reviewed PRs: 279 + 80 + 267
    expect(out.totals.ignored).toBe(0);
    expect(out.totals.manual).toBe(0);
    expect(out.totals.error).toBe(0);
    expect(out.totals.reversed).toBe(33); // 20 + 10 + 3
    expect(out.totals.reviewed).toBe(2742);
    // filtered = (2742 - 1392) / 2742 = 49.2%
    expect(out.totals.filteredPct).toBe(49.2);
    // accuracy = 1 - 33 / (1392 + 724) = 98.4%
    expect(out.totals.accuracyPct).toBe(98.4);
    expect(out.totals.minutesSaved).toBe(2742 * MINUTES_SAVED_PER_PR);
    expect(out.weekly).toEqual({ reviewed: 1420, merged: 900 });
    expect(out.byProject.map((p) => p.project)).toEqual([
      "JSONbored/awesome-claude",
      "JSONbored/metagraphed",
      "JSONbored/gittensory",
    ]);
    expect(out.updatedAt).toBe(out.generatedAt);
  });

  it("folds external Orb installs into the global totals (cloud + Orb, de-duped)", async () => {
    const withOrb = (sql: string): Row[] =>
      sql.includes("orb_pr_outcomes") ? [{ merged: 50, closed: 30, total: 80 }] : ledger(sql);
    const out = await getPublicStats(stubEnv(withOrb), NOW);
    expect(out.totals.merged).toBe(1392 + 50); // cloud + external Orb
    expect(out.totals.closed).toBe(724 + 30);
    expect(out.totals.handled).toBe(2742 + 80);
    expect(out.totals.reviewed).toBe(1442 + 754 + 626); // reviewedOf = merged + closed + commented + manual
  });

  it("publishes only projects from the reviewed-repo allowlist", async () => {
    const out = await getPublicStats(
      stubEnv((sql, args) => {
        if (isReversal(sql)) {
          return [
            { project: "JSONbored/gittensory", reversed: 1 },
            { project: "CustomerCo/stealth-product", reversed: 1 },
          ].filter((row) => args.includes(String(row.project).toLowerCase()));
        }
        if (isWeekly(sql)) {
          const allowed = args.slice(2); // [sinceIso, sinceIso, ...projects]
          const weeklyRows = [
            { project: "JSONbored/gittensory", reviewed: 2, merged: 1 },
            { project: "CustomerCo/stealth-product", reviewed: 3, merged: 3 },
          ].filter((row) =>
            allowed.includes(String(row.project).toLowerCase()),
          );
          return [
            weeklyRows.reduce(
              (acc, row) => ({
                reviewed: acc.reviewed + row.reviewed,
                merged: acc.merged + row.merged,
              }),
              { reviewed: 0, merged: 0 },
            ),
          ];
        }
        if (isDispositions(sql)) {
          return [
            {
              project: "JSONbored/gittensory",
              reviewed: 2,
              merged: 1,
              closed: 1,
              inReview: 0,
            },
            {
              project: "CustomerCo/stealth-product",
              reviewed: 3,
              merged: 3,
              closed: 0,
              inReview: 0,
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

  it("excludes dry-run terminal actions from live reversal counts", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory" });
    const db = env.DB;

    await db
      .prepare(
        `INSERT INTO pull_requests (id, repo_full_name, number, title, state, merged_at)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "pr-real",
        "JSONbored/gittensory",
        1,
        "real auto-closed PR",
        "closed",
        null,
        "pr-dry-run",
        "JSONbored/gittensory",
        2,
        "dry-run close shadow",
        "open",
        null,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO audit_events (id, event_type, target_key, outcome, metadata_json)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .bind(
        "published-real",
        "github_app.pr_public_surface_published",
        "JSONbored/gittensory#1",
        "completed",
        "{}",
        "published-dry-run",
        "github_app.pr_public_surface_published",
        "JSONbored/gittensory#2",
        "completed",
        "{}",
        "live-close",
        "agent.action.close",
        "JSONbored/gittensory#1",
        "completed",
        JSON.stringify({ mode: "live" }),
        "dry-run-close",
        "agent.action.close",
        "JSONbored/gittensory#2",
        "completed",
        JSON.stringify({ mode: "dry_run" }),
      )
      .run();

    const out = await getPublicStats(env, NOW);

    expect(out.totals.closed).toBe(1);
    expect(out.totals.commented).toBe(1);
    expect(out.totals.reversed).toBe(0);
    expect(out.totals.accuracyPct).toBe(100);
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
      if (isDispositions(sql)) throw new Error("audit_events down");
      return [];
    });
    const out = await getPublicStats(env, NOW);
    expect(out.totals.handled).toBe(0);
    expect(out.totals.accuracyPct).toBeNull();
  });

  it("coerces null SUM/reversal/weekly fields to 0 (SUM over an empty set returns NULL in SQLite)", async () => {
    // Every numeric column comes back null (the nullish arm of each `?? 0`); p2 has no reversal row, exercising
    // the `reversedByProject.get(...) ?? 0` fallback; the weekly row is present but its fields are null.
    const out = await getPublicStats(
      stubEnv((sql) => {
        if (isReversal(sql)) return [{ project: "p1", reversed: null }];
        if (isWeekly(sql)) return [{ reviewed: null, merged: null }];
        if (isDispositions(sql)) {
          return [
            {
              project: "p1",
              reviewed: null,
              merged: null,
              closed: null,
              inReview: null,
            },
            {
              project: "p2",
              reviewed: null,
              merged: null,
              closed: null,
              inReview: null,
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
