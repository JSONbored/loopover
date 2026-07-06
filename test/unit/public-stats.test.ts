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
    GITTENSORY_PUBLIC_STATS_REPOS:
      "JSONbored/gittensory,JSONbored/awesome-claude,JSONbored/metagraphed",
  } as unknown as Env;
}

const NOW = Date.parse("2026-06-22T00:00:00Z");

function isWeekly(sql: string): boolean {
  return sql.includes("first_seen");
}
// The effort-minutes read is the only one that extracts reviewEffortMinutes from metadata_json (#1955).
function isEffort(sql: string): boolean {
  return sql.includes("reviewEffortMinutes");
}
function isDispositions(sql: string): boolean {
  return (
    sql.includes("github_app.pr_public_surface_published") &&
    !isWeekly(sql) &&
    !isEffort(sql)
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

  // #1955: minutesSaved now averages the REAL per-PR estimate (estimateReviewEffort's minutes, persisted at
  // publish time) instead of unconditionally multiplying by the flat MINUTES_SAVED_PER_PR constant. Proves the
  // new estimate is actually used when the ledger has it — the regression case for the flat-constant replacement.
  it("uses the real average review-effort minutes when the ledger has them, instead of the flat constant", async () => {
    const withEffort = (sql: string): Row[] => {
      if (isEffort(sql)) return [{ avgMinutes: 7.4 }];
      return ledger(sql);
    };
    const out = await getPublicStats(stubEnv(withEffort), NOW);
    // reviewed = 2742 (same ledger as the base test) * 7.4 = 20290.8 -> rounded.
    expect(out.totals.minutesSaved).toBe(Math.round(2742 * 7.4));
    expect(out.totals.minutesSaved).not.toBe(2742 * MINUTES_SAVED_PER_PR);
  });

  // The nullish arm of `effortRows[0]?.avgMinutes ?? MINUTES_SAVED_PER_PR`: a ledger whose published rows all
  // predate this feature (or an empty allowlist) yields a NULL average (SQLite's AVG skips missing json_extract
  // keys entirely) rather than a row missing outright — both must degrade to the flat constant, not NaN/0.
  it("falls back to the flat MINUTES_SAVED_PER_PR constant when the effort average is SQL NULL", async () => {
    const nullEffort = (sql: string): Row[] => {
      if (isEffort(sql)) return [{ avgMinutes: null }];
      return ledger(sql);
    };
    const out = await getPublicStats(stubEnv(nullEffort), NOW);
    expect(out.totals.minutesSaved).toBe(2742 * MINUTES_SAVED_PER_PR);
  });

  it("implements the #2070 ROI contract: real estimate, flat fallback, empty ledger → 0", async () => {
    const estimate = await getPublicStats(
      stubEnv((sql) => {
        if (isEffort(sql)) return [{ avgMinutes: 12 }];
        return ledger(sql);
      }),
      NOW,
    );
    expect(estimate.totals.minutesSaved).toBe(Math.round(2742 * 12));
    expect(estimate.totals.minutesSaved).not.toBe(2742 * MINUTES_SAVED_PER_PR);

    const fallback = await getPublicStats(
      stubEnv((sql) => {
        if (isEffort(sql)) return [{ avgMinutes: null }];
        return ledger(sql);
      }),
      NOW,
    );
    expect(fallback.totals.minutesSaved).toBe(2742 * MINUTES_SAVED_PER_PR);

    const empty = await getPublicStats(stubEnv(() => []), NOW);
    expect(empty.totals.minutesSaved).toBe(0);
  });

  it("breaks byProject ties on project name so equal-reviewed repos keep a deterministic order", async () => {
    // Two repos share reviewed=10, fed in reverse-alphabetical input order; the busier repo
    // still leads and the tied pair must come out alphabetically, not in arbitrary SQL order.
    const tied = (sql: string): Row[] => {
      if (isDispositions(sql)) {
        return [
          { project: "JSONbored/zed", reviewed: 10, merged: 5, closed: 3, inReview: 2 },
          { project: "JSONbored/alpha", reviewed: 10, merged: 5, closed: 3, inReview: 2 },
          { project: "JSONbored/beta", reviewed: 50, merged: 30, closed: 10, inReview: 10 },
        ];
      }
      return [];
    };
    const out = await getPublicStats(stubEnv(tied), NOW);
    expect(out.byProject.map((p) => p.project)).toEqual(["JSONbored/beta", "JSONbored/alpha", "JSONbored/zed"]);
  });

  it("folds Orb installs into the global totals on top of the own-ledger totals", async () => {
    const withOrb = (sql: string): Row[] =>
      sql.includes("orb_pr_outcomes") ? [{ merged: 50, closed: 30, total: 80 }] : ledger(sql);
    const out = await getPublicStats(stubEnv(withOrb), NOW);
    expect(out.totals.merged).toBe(1392 + 50); // own-ledger + Orb
    expect(out.totals.closed).toBe(724 + 30);
    expect(out.totals.handled).toBe(2742 + 80);
    expect(out.totals.reviewed).toBe(1442 + 754 + 626); // reviewedOf = merged + closed + commented + manual
  });

  it("does not exclude any account from the Orb aggregate (own-ledger side is a frozen snapshot, not live-overlapping)", async () => {
    let excludeBindArg: unknown;
    const captureExclude = (sql: string, args: unknown[]): Row[] => {
      if (sql.includes("orb_pr_outcomes")) {
        excludeBindArg = args[0];
        return [{ merged: 0, closed: 0, total: 0 }];
      }
      return ledger(sql);
    };
    await getPublicStats(stubEnv(captureExclude), NOW);
    expect(excludeBindArg).toBe("");
  });

  it("clamps review accuracy to 0 when reopened auto-closes push reversals above the decided count", async () => {
    // JSONbored/gittensory: 1 auto-merge that held, plus 2 auto-closes that were reopened (now open, so out
    // of merged+closed but still counted as reversals). decided=1, reversed=2 → an unclamped 1 - 2/1 = -100%.
    const handler = (sql: string): Row[] => {
      if (isDispositions(sql)) return [{ project: "JSONbored/gittensory", reviewed: 3, merged: 1, closed: 0, inReview: 2 }];
      if (isReversal(sql)) return [{ project: "JSONbored/gittensory", reversed: 2 }];
      return [];
    };
    const out = await getPublicStats(stubEnv(handler), NOW);
    expect(out.byProject[0]!.accuracyPct).toBe(0);
    expect(out.totals.accuracyPct).toBe(0);
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
    const env = createTestEnv({ GITTENSORY_PUBLIC_STATS_REPOS: "JSONbored/gittensory" });
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

  // #1955: end-to-end over REAL D1/SQLite (not the stub) — a published row's `metadata_json.reviewEffortMinutes`
  // (the exact shape processors.ts writes at publish time) round-trips through json_extract/AVG into
  // minutesSaved, proving the SQL itself (not just the mocked shape) computes the real per-PR average.
  it("averages a real reviewEffortMinutes value out of metadata_json via json_extract (real D1)", async () => {
    const env = createTestEnv({ GITTENSORY_PUBLIC_STATS_REPOS: "JSONbored/gittensory" });
    const db = env.DB;

    await db
      .prepare(
        `INSERT INTO pull_requests (id, repo_full_name, number, title, state, merged_at)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "pr-a",
        "JSONbored/gittensory",
        10,
        "small fix",
        "closed",
        "2026-06-01T00:00:00.000Z",
        "pr-b",
        "JSONbored/gittensory",
        11,
        "bigger change",
        "closed",
        "2026-06-01T00:00:00.000Z",
      )
      .run();
    await db
      .prepare(
        `INSERT INTO audit_events (id, event_type, target_key, outcome, metadata_json)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .bind(
        "published-a",
        "github_app.pr_public_surface_published",
        "JSONbored/gittensory#10",
        "completed",
        JSON.stringify({ reviewEffortMinutes: 4 }),
        "published-b",
        "github_app.pr_public_surface_published",
        "JSONbored/gittensory#11",
        "completed",
        JSON.stringify({ reviewEffortMinutes: 96 }),
      )
      .run();

    const out = await getPublicStats(env, NOW);

    // avg(4, 96) = 50; reviewed = 2 -> minutesSaved = 100 (not 2 * MINUTES_SAVED_PER_PR = 40).
    expect(out.totals.reviewed).toBe(2);
    expect(out.totals.minutesSaved).toBe(100);
    expect(out.totals.minutesSaved).not.toBe(2 * MINUTES_SAVED_PER_PR);
  });

  it("skips the own-ledger queries but still queries the Orb aggregate when the allowlist is empty", async () => {
    const env = {
      DB: {
        prepare: (sql: string) => {
          if (sql.includes("orb_pr_outcomes")) {
            return {
              bind: () => ({ first: async () => ({ merged: 0, closed: 0, total: 0 }) }),
            };
          }
          throw new Error("public stats must not query an unscoped own-ledger");
        },
      },
      GITTENSORY_PUBLIC_STATS_REPOS: "",
    } as unknown as Env;
    const out = await getPublicStats(env, NOW);
    expect(out.totals.handled).toBe(0);
    expect(out.totals.reviewed).toBe(0);
    expect(out.weekly).toEqual({ reviewed: 0, merged: 0 });
    expect(out.byProject).toEqual([]);
  });

  it("reports Orb-only totals when the own-ledger allowlist is empty but Orb has data", async () => {
    const env = {
      DB: {
        prepare: (sql: string) => {
          if (sql.includes("orb_pr_outcomes")) {
            return {
              bind: () => ({ first: async () => ({ merged: 12, closed: 8, total: 20 }) }),
            };
          }
          throw new Error("public stats must not query an unscoped own-ledger");
        },
      },
      GITTENSORY_PUBLIC_STATS_REPOS: "",
    } as unknown as Env;
    const out = await getPublicStats(env, NOW);
    expect(out.totals.merged).toBe(12);
    expect(out.totals.closed).toBe(8);
    expect(out.totals.handled).toBe(20);
    expect(out.totals.reviewed).toBe(20);
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
    // .first() (the Orb aggregate's own no-results shape) likewise returns undefined.
    const env = {
      DB: {
        prepare: () => {
          const stmt = { bind: () => stmt, all: async () => ({}), first: async () => undefined };
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
