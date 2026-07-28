import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import {
  clearPublicStatsManifestOverrideCacheForTest,
  getPublicStats,
  isPublicStatsEnabled,
  MINUTES_SAVED_PER_PR,
  resolvePublicStatsManifestOverride,
} from "../../src/review/public-stats";

const SELF_REPO = "JSONbored/loopover";

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
    LOOPOVER_PUBLIC_STATS_REPOS:
      "JSONbored/loopover,JSONbored/awesome-claude,JSONbored/metagraphed",
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
// getOrbGlobalStats's own-ledger anti-join also references `github_app.pr_public_surface_published` (to skip
// PRs the disposition query already counted) — exclude it here the same way isWeekly/isEffort already are, or
// every stub that doesn't special-case `orb_pr_outcomes` would wrongly route the orb read through here too.
function isOrbGlobal(sql: string): boolean {
  return sql.includes("orb_pr_outcomes");
}
function isDispositions(sql: string): boolean {
  return (
    sql.includes("github_app.pr_public_surface_published") &&
    !isWeekly(sql) &&
    !isEffort(sql) &&
    !isOrbGlobal(sql)
  );
}
// The reversal read is the only one that reads the recorded reversal_reopened/reversal_reverted events.
function isReversal(sql: string): boolean {
  return sql.includes("reversal_reopened");
}

describe("isPublicStatsEnabled", () => {
  it("is truthy only for 1/true/yes/on (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"])
      expect(isPublicStatsEnabled({ LOOPOVER_PUBLIC_STATS: v })).toBe(true);
    for (const v of ["", "0", "false", "off", "no", undefined])
      expect(isPublicStatsEnabled({ LOOPOVER_PUBLIC_STATS: v })).toBe(false);
  });

  it("a present manifest override wins outright over the env flag, in both directions (#6275)", () => {
    expect(isPublicStatsEnabled({ LOOPOVER_PUBLIC_STATS: "false" }, { present: true, enabled: true })).toBe(true);
    expect(isPublicStatsEnabled({ LOOPOVER_PUBLIC_STATS: "true" }, { present: true, enabled: false })).toBe(false);
  });

  it("falls back to the env flag when the manifest override is not present", () => {
    expect(isPublicStatsEnabled({ LOOPOVER_PUBLIC_STATS: "true" }, { present: false, enabled: false })).toBe(true);
    expect(isPublicStatsEnabled({ LOOPOVER_PUBLIC_STATS: "false" }, undefined)).toBe(false);
  });
});

describe("resolvePublicStatsManifestOverride — config-as-code lookup (#6275)", () => {
  beforeEach(() => {
    clearPublicStatsManifestOverrideCacheForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the self-repo's configured publicStats block when present", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { publicStats: { enabled: true } });

    expect(await resolvePublicStatsManifestOverride(env)).toEqual({ present: true, enabled: true });
  });

  it("returns present: false when the self-repo has no publicStats block configured", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { wantedPaths: ["src/"] });

    expect(await resolvePublicStatsManifestOverride(env)).toEqual({ present: false, enabled: false });
  });

  it("degrades to present: false (never throws) when the manifest load itself fails", async () => {
    const env = createTestEnv();
    // loadRepoFocusManifest reads signal_snapshots (the persisted-record cache) before any live fetch fallback.
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/"signal_snapshots"|signal_snapshots/i.test(sql)) throw new Error("poisoned query");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await resolvePublicStatsManifestOverride(env)).toEqual({ present: false, enabled: false });
    expect(warnings.mock.calls.map((c) => String(c[0])).some((line) => line.includes("public_stats_manifest_override_error"))).toBe(true);
  });

  it("within the 60s TTL, reuses the cached override instead of re-reading the manifest (#6372 perf)", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { publicStats: { enabled: true } });
    const t0 = Date.parse("2026-07-16T00:00:00Z");
    expect(await resolvePublicStatsManifestOverride(env, t0)).toEqual({ present: true, enabled: true });

    // A poisoned DB proves the second call never re-reads -- it must serve the cached value.
    env.DB.prepare = (() => {
      throw new Error("should not be queried on a cache hit");
    }) as typeof env.DB.prepare;
    expect(await resolvePublicStatsManifestOverride(env, t0 + 30_000)).toEqual({ present: true, enabled: true });
  });

  it("re-reads the manifest once the 60s TTL has elapsed", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { publicStats: { enabled: true } });
    const t0 = Date.parse("2026-07-16T00:00:00Z");
    expect(await resolvePublicStatsManifestOverride(env, t0)).toEqual({ present: true, enabled: true });

    await upsertRepoFocusManifest(env, SELF_REPO, { publicStats: { enabled: false } });
    expect(await resolvePublicStatsManifestOverride(env, t0 + 60_001)).toEqual({ present: true, enabled: false });
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
          project: "JSONbored/loopover",
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
        { project: "JSONbored/loopover", reversed: 3 },
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
      "JSONbored/loopover",
    ]);
    expect(out.updatedAt).toBe(out.generatedAt);
    // No registered self-hosted instances in this fixture -- fleetAccuracy degrades to the "not eligible yet" shape.
    expect(out.fleetAccuracy).toEqual({
      accuracyPct: null,
      accuracyCiPct: null,
      mergePrecisionPct: null,
      mergePrecisionCiPct: null,
      closePrecisionPct: null,
      closePrecisionCiPct: null,
      coveragePct: null,
      decidedCount: 0,
      instanceCount: 0,
      windowDays: 90,
      gamingFlagsCaught: null, // #9068: fewer than GAMING_MIN_ELIGIBLE eligible instances -- detector didn't run
      guaranteed: { close: null, merge: null },
    });
  });

  // #1955/#2070: minutesSaved sums per-PR estimates (with MINUTES_SAVED_PER_PR fallback for missing rows)
  // instead of multiplying reviewed by a global average.
  it("sums the real per-PR review-effort minutes when the ledger has them, instead of the flat constant", async () => {
    const withEffort = (sql: string): Row[] => {
      if (isEffort(sql)) return [{ totalMinutes: 2742 * 7.4 }];
      return ledger(sql);
    };
    const out = await getPublicStats(stubEnv(withEffort), NOW);
    expect(out.totals.minutesSaved).toBe(Math.round(2742 * 7.4));
    expect(out.totals.minutesSaved).not.toBe(2742 * MINUTES_SAVED_PER_PR);
  });

  // The nullish arm when the effort subquery returns SQL NULL (no published rows in scope).
  it("falls back to the flat MINUTES_SAVED_PER_PR constant when the effort sum is SQL NULL", async () => {
    const nullEffort = (sql: string): Row[] => {
      if (isEffort(sql)) return [{ totalMinutes: null }];
      return ledger(sql);
    };
    const out = await getPublicStats(stubEnv(nullEffort), NOW);
    expect(out.totals.minutesSaved).toBe(2742 * MINUTES_SAVED_PER_PR);
  });

  // #2070: mixed ledgers must COALESCE missing per-PR estimates to MINUTES_SAVED_PER_PR, not AVG-skip them.
  it("sums mixed per-PR effort with fallback when one published PR lacks reviewEffortMinutes", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "JSONbored/loopover" });
    const db = env.DB;

    await db
      .prepare(
        `INSERT INTO pull_requests (id, repo_full_name, number, title, state, merged_at)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "pr-a",
        "JSONbored/loopover",
        10,
        "small fix",
        "closed",
        "2026-06-01T00:00:00.000Z",
        "pr-b",
        "JSONbored/loopover",
        11,
        "legacy publish",
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
        "JSONbored/loopover#10",
        "completed",
        JSON.stringify({ reviewEffortMinutes: 4 }),
        "published-b",
        "github_app.pr_public_surface_published",
        "JSONbored/loopover#11",
        "completed",
        "{}",
      )
      .run();

    const out = await getPublicStats(env, NOW);

    expect(out.totals.reviewed).toBe(2);
    expect(out.totals.minutesSaved).toBe(4 + MINUTES_SAVED_PER_PR);
    // Old AVG-based path skipped the missing row and under-reported: reviewed * avg(4) = 8.
    expect(out.totals.minutesSaved).not.toBe(8);
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
    // Own-ledger flat fallback + Orb fleet flat credit (Orb has no per-PR effort metadata in this module).
    expect(out.totals.minutesSaved).toBe(2742 * MINUTES_SAVED_PER_PR + 80 * MINUTES_SAVED_PER_PR);
  });

  it("REGRESSION (#7449): global accuracyPct reflects the own-ledger population, not the Orb-fleet-inflated merged/closed denominator", async () => {
    // Own-ledger: 100 decided (all merged), 10 real reversals -> a true 90% accuracy. A huge registered Orb fleet
    // (6000 merged + 4000 closed, with no reversal data at all) must NOT dilute the denominator toward 100.
    const handler = (sql: string): Row[] => {
      if (isDispositions(sql)) return [{ project: "JSONbored/loopover", reviewed: 100, merged: 100, closed: 0, inReview: 0 }];
      if (isReversal(sql)) return [{ project: "JSONbored/loopover", reversed: 10 }];
      if (sql.includes("orb_pr_outcomes")) return [{ merged: 6000, closed: 4000, total: 10000 }];
      return [];
    };
    const out = await getPublicStats(stubEnv(handler), NOW);
    // The fleet fold still (correctly) inflates the raw aggregate counts...
    expect(out.totals.merged).toBe(100 + 6000);
    expect(out.totals.closed).toBe(0 + 4000);
    expect(out.totals.handled).toBe(100 + 10000);
    // ...but accuracy is computed from own-ledger only: 1 - 10/(100 + 0) = 90.0%.
    expect(out.totals.accuracyPct).toBe(90);
    // The pre-fix fleet-inflated denominator would have produced 1 - 10/(6100 + 4000) = 99.0% -- guard against it.
    expect(out.totals.accuracyPct).not.toBe(99);
    // Per-project accuracy is already same-scope and stays unchanged: 1 - 10/100 = 90.
    expect(out.byProject[0]!.accuracyPct).toBe(90);
  });

  it("keeps own-ledger per-PR effort sum separate from Orb fleet flat credit", async () => {
    const withOrbAndEffort = (sql: string): Row[] => {
      if (sql.includes("orb_pr_outcomes")) return [{ merged: 10, closed: 5, total: 15 }];
      if (isEffort(sql)) return [{ totalMinutes: 100 }];
      return ledger(sql);
    };
    const out = await getPublicStats(stubEnv(withOrbAndEffort), NOW);
    expect(out.totals.minutesSaved).toBe(100 + 15 * MINUTES_SAVED_PER_PR);
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
    // JSONbored/loopover: 1 auto-merge that held, plus 2 auto-closes that were reopened (now open, so out
    // of merged+closed but still counted as reversals). decided=1, reversed=2 → an unclamped 1 - 2/1 = -100%.
    const handler = (sql: string): Row[] => {
      if (isDispositions(sql)) return [{ project: "JSONbored/loopover", reviewed: 3, merged: 1, closed: 0, inReview: 2 }];
      if (isReversal(sql)) return [{ project: "JSONbored/loopover", reversed: 2 }];
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
            { project: "JSONbored/loopover", reversed: 1 },
            { project: "CustomerCo/stealth-product", reversed: 1 },
          ].filter((row) => args.includes(String(row.project).toLowerCase()));
        }
        if (isWeekly(sql)) {
          const allowed = args.slice(2); // [sinceIso, sinceIso, ...projects]
          const weeklyRows = [
            { project: "JSONbored/loopover", reviewed: 2, merged: 1 },
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
              project: "JSONbored/loopover",
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
      "JSONbored/loopover",
    ]);
  });

  it("REGRESSION (#fairness-analytics): counts a merged PR reverted via a separate revert PR, previously undetectable via PR state alone", async () => {
    // A bad merge is undone by a SEPARATE "Reverts #N" PR -- the original PR's own state stays 'closed' with
    // merged_at set (a merged PR's state can never read as 'open' again on GitHub), which is exactly the case the
    // old pr.state-based reversal query could never detect. Reading the recorded reversal_reverted event directly
    // (as outcomes-wire.ts's recordReversalSignals already writes it) must catch it.
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "JSONbored/loopover" });
    const db = env.DB;

    await db
      .prepare(
        `INSERT INTO pull_requests (id, repo_full_name, number, title, state, merged_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind("pr-merged", "JSONbored/loopover", 1, "merged then reverted", "closed", "2026-06-01T00:00:00.000Z")
      .run();
    await db
      .prepare(
        `INSERT INTO audit_events (id, event_type, target_key, outcome, metadata_json)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .bind(
        "published",
        "github_app.pr_public_surface_published",
        "JSONbored/loopover#1",
        "completed",
        "{}",
        "reverted",
        "reversal_reverted",
        "JSONbored/loopover#1",
        "completed",
        JSON.stringify({ repoFullName: "JSONbored/loopover", revertedPullNumber: 1, revertPullNumber: 2 }),
      )
      .run();

    const out = await getPublicStats(env, NOW);

    expect(out.totals.merged).toBe(1);
    expect(out.totals.reversed).toBe(1);
    expect(out.totals.accuracyPct).toBe(0); // 1 - 1/1
  });

  it("REGRESSION (#fairness-analytics): the headline accuracy prefers live fleet data once a registered instance clears the volume bar", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "" });
    const db = env.DB;

    await db.prepare("INSERT INTO orb_instances (instance_id, registered) VALUES (?, 1)").bind("inst-1").run();
    for (let i = 0; i < 4; i++) {
      await db
        .prepare(
          `INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag)
           VALUES (?, ?, ?, 'merge', 'merged', 'none')`,
        )
        .bind("inst-1", "repo-hash", `pr-hash-${i}`)
        .run();
    }
    await db
      .prepare(
        `INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag)
         VALUES (?, ?, ?, 'merge', 'merged', 'reverted')`,
      )
      .bind("inst-1", "repo-hash", "pr-hash-reverted")
      .run();

    const out = await getPublicStats(env, NOW);

    // 5 merge verdicts, 4 confirmed (the 5th was reverted) -> decisionAccuracy 4/5 -> 80%.
    // Only 1 eligible instance -- below GAMING_MIN_ELIGIBLE (3), so gamingFlagsCaught is null (#9068).
    expect(out.fleetAccuracy).toMatchObject({ accuracyPct: 80, instanceCount: 1, windowDays: 90, gamingFlagsCaught: null });
    // #8829: per-arm split, coverage, sample size, and a Wilson interval ride every published figure.
    expect(out.fleetAccuracy.mergePrecisionPct).toBe(80);
    expect(out.fleetAccuracy.closePrecisionPct).toBeNull(); // no close verdicts in this fixture
    expect(out.fleetAccuracy.closePrecisionCiPct).toBeNull();
    expect(out.fleetAccuracy.coveragePct).toBe(100); // no holds in this fixture
    expect(out.fleetAccuracy.decidedCount).toBe(5);
    const ci = out.fleetAccuracy.accuracyCiPct!;
    // Wilson at 4/5 is WIDE (n=5) -- the interval is the honesty the bare 80 lacks.
    expect(ci.lo).toBeGreaterThan(30);
    expect(ci.lo).toBeLessThan(80);
    expect(ci.hi).toBeGreaterThan(80);
    expect(ci.hi).toBeLessThanOrEqual(100);
  });

  it("REGRESSION (#8820): the published fleet accuracy scores DECISIONS — holds are excluded and marker-less mispredictions count", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "" });
    const db = env.DB;
    await db.prepare("INSERT INTO orb_instances (instance_id, registered) VALUES (?, 1)").bind("inst-1").run();
    const signal = async (n: number, verdict: string, outcome: string, tag: string) => {
      for (let i = 0; i < n; i++) {
        await db
          .prepare(`INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag) VALUES (?, 'repo-hash', ?, ?, ?, 'none')`)
          .bind("inst-1", `pr-${tag}-${i}`, verdict, outcome)
          .run();
      }
    };
    await signal(6, "merge", "merged", "ok"); // confirmed
    await signal(2, "merge", "closed", "bad"); // WRONG, and carries no reversal marker
    await signal(3, "close", "closed", "cok"); // confirmed closes
    await signal(1, "close", "merged", "cbad"); // wrong close
    await signal(40, "hold", "merged", "hold"); // deferrals — must not enter the denominator

    const out = await getPublicStats(env, NOW);
    // 12 real decisions, 9 confirmed -> 75%. The retired `1 - reversalRate` formula would have published
    // 100% here: zero reversal markers, and 40 holds swamping its denominator.
    expect(out.fleetAccuracy.accuracyPct).toBe(75);
    // #8829: per-arm split + the coverage this figure was earned at (12 verdicts over 52 scorable signals).
    expect(out.fleetAccuracy.mergePrecisionPct).toBe(75);
    expect(out.fleetAccuracy.closePrecisionPct).toBe(75);
    expect(out.fleetAccuracy.coveragePct).toBeCloseTo(23.1, 1);
    expect(out.fleetAccuracy.decidedCount).toBe(12);
  });

  it("REGRESSION (#fairness-analytics): surfaces gamingFlagsCaught from computeFleetAnalytics's anti-farming detector", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "" });
    const db = env.DB;

    // Three baseline instances: 5 decided each, 4 merged (1 later reverted) -> mergePrecision 0.6, reversalRate 0.2.
    for (const inst of ["baseline-1", "baseline-2", "baseline-3"]) {
      await db.prepare("INSERT INTO orb_instances (instance_id, registered) VALUES (?, 1)").bind(inst).run();
      for (let i = 0; i < 3; i++) {
        await db
          .prepare(`INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag) VALUES (?, ?, ?, 'merge', 'merged', 'none')`)
          .bind(inst, "repo-hash", `${inst}-pr-${i}`)
          .run();
      }
      await db
        .prepare(`INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag) VALUES (?, ?, ?, 'merge', 'merged', 'reverted')`)
        .bind(inst, "repo-hash", `${inst}-pr-reverted`)
        .run();
      await db
        .prepare(`INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag) VALUES (?, ?, ?, 'merge', 'closed', 'none')`)
        .bind(inst, "repo-hash", `${inst}-pr-mergefalse`)
        .run();
    }

    // Gaming instance: 30 decided, ALL merged with no reversal -> high volume (>2x fleet median 5), high precision
    // (1.0 vs fleet median 0.6), low reversal (0 vs fleet median 0.2) -- the exact #2350 farming signature.
    await db.prepare("INSERT INTO orb_instances (instance_id, registered) VALUES (?, 1)").bind("gaming-1").run();
    for (let i = 0; i < 30; i++) {
      await db
        .prepare(`INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag) VALUES (?, ?, ?, 'merge', 'merged', 'none')`)
        .bind("gaming-1", "repo-hash", `gaming-pr-${i}`)
        .run();
    }

    const out = await getPublicStats(env, NOW);

    expect(out.fleetAccuracy.gamingFlagsCaught).toBe(1);
  });

  // #1955/#2070: end-to-end over REAL D1/SQLite — published reviewEffortMinutes round-trip through
  // json_extract/SUM(COALESCE(...)) into minutesSaved.
  it("averages a real reviewEffortMinutes value out of metadata_json via json_extract (real D1)", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "JSONbored/loopover" });
    const db = env.DB;

    await db
      .prepare(
        `INSERT INTO pull_requests (id, repo_full_name, number, title, state, merged_at)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "pr-a",
        "JSONbored/loopover",
        10,
        "small fix",
        "closed",
        "2026-06-01T00:00:00.000Z",
        "pr-b",
        "JSONbored/loopover",
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
        "JSONbored/loopover#10",
        "completed",
        JSON.stringify({ reviewEffortMinutes: 4 }),
        "published-b",
        "github_app.pr_public_surface_published",
        "JSONbored/loopover#11",
        "completed",
        JSON.stringify({ reviewEffortMinutes: 96 }),
      )
      .run();

    const out = await getPublicStats(env, NOW);

    // sum(4, 96) = 100; reviewed = 2 -> minutesSaved = 100 (not 2 * MINUTES_SAVED_PER_PR = 40).
    expect(out.totals.reviewed).toBe(2);
    expect(out.totals.minutesSaved).toBe(100);
    expect(out.totals.minutesSaved).not.toBe(2 * MINUTES_SAVED_PER_PR);
  });

  it("deduplicates repeated public-surface publishes before averaging reviewEffortMinutes (real D1)", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "JSONbored/loopover" });
    const db = env.DB;

    await db
      .prepare(
        `INSERT INTO pull_requests (id, repo_full_name, number, title, state, merged_at)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "pr-republished",
        "JSONbored/loopover",
        20,
        "republished large review",
        "closed",
        "2026-06-01T00:00:00.000Z",
        "pr-single",
        "JSONbored/loopover",
        21,
        "single tiny review",
        "closed",
        "2026-06-01T00:00:00.000Z",
      )
      .run();
    await db
      .prepare(
        `INSERT INTO audit_events (id, event_type, target_key, outcome, metadata_json)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .bind(
        "published-republished-a",
        "github_app.pr_public_surface_published",
        "JSONbored/loopover#20",
        "completed",
        JSON.stringify({ reviewEffortMinutes: 100 }),
        "published-republished-b",
        "github_app.pr_public_surface_published",
        "JSONbored/loopover#20",
        "completed",
        JSON.stringify({ reviewEffortMinutes: 100 }),
        "published-republished-c",
        "github_app.pr_public_surface_published",
        "JSONbored/loopover#20",
        "completed",
        JSON.stringify({ reviewEffortMinutes: 100 }),
        "published-single",
        "github_app.pr_public_surface_published",
        "JSONbored/loopover#21",
        "completed",
        JSON.stringify({ reviewEffortMinutes: 1 }),
      )
      .run();

    const out = await getPublicStats(env, NOW);

    expect(out.totals.reviewed).toBe(2);
    // Per-PR sum: 100 + 1 = 101 (deduped republish events averaged per PR first).
    // A raw event-level average would skew this to round(2 * avg(100, 100, 100, 1)) = 151.
    expect(out.totals.minutesSaved).toBe(101);
  });

  it("skips the own-ledger queries but still queries the Orb aggregate when the allowlist is empty", async () => {
    const env = {
      DB: {
        prepare: (sql: string) => {
          // #9474: getOrbGlobalStats now ALSO reads the durable orb_outcome_rollups fold (empty here).
          if (sql.includes("orb_pr_outcomes") || sql.includes("orb_outcome_rollups")) {
            return {
              bind: () => ({ first: async () => ({ merged: 0, closed: 0, total: 0 }) }),
            };
          }
          throw new Error("public stats must not query an unscoped own-ledger");
        },
      },
      LOOPOVER_PUBLIC_STATS_REPOS: "",
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
          // #9474: the rollup read must return the no-rows aggregate shape (all-NULL SUMs), so this test
          // also pins that live-scan totals are NOT double-counted through the rollup arm.
          if (sql.includes("orb_outcome_rollups")) {
            return {
              bind: () => ({ first: async () => ({ merged: null, closed: null, total: null }) }),
            };
          }
          if (sql.includes("orb_pr_outcomes")) {
            return {
              bind: () => ({ first: async () => ({ merged: 12, closed: 8, total: 20 }) }),
            };
          }
          throw new Error("public stats must not query an unscoped own-ledger");
        },
      },
      LOOPOVER_PUBLIC_STATS_REPOS: "",
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

describe("fleetAccuracy.guaranteed (#8835/#9121/#9050/#9068)", () => {
  // minimumCalibrationLabels(0.015, 0.05) = 199 -- every valid fixture below clears it with margin.
  const calibrated = (overrides: Record<string, unknown> = {}) => ({
    status: "calibrated",
    alpha: 0.015,
    lambda: 0.94,
    coverageAtLambda: 0.82,
    nAtLambda: 240,
    delta: 0.05,
    ...overrides,
  });

  it("publishes a live per-arm guarantee from a REGISTERED instance's orb_risk_control_arms row; malformed, unregistered, or absent rows read null (fail-open)", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "" });
    await env.DB.prepare(`INSERT INTO orb_instances (instance_id, registered) VALUES ('inst-a', 1)`).run();
    await env.DB.prepare(`INSERT INTO orb_risk_control_arms (instance_id, arm, payload_json) VALUES ('inst-a', 'close', ?)`)
      .bind(JSON.stringify(calibrated()))
      .run();
    await env.DB.prepare(`INSERT INTO orb_risk_control_arms (instance_id, arm, payload_json) VALUES ('inst-a', 'merge', '{broken')`).run();
    const out = await getPublicStats(env, NOW);
    expect(out.fleetAccuracy.guaranteed.close).toEqual({ alpha: 0.015, lambda: 0.94, aiJudgedCoveragePct: 82, n: 240, backfilledPct: null });
    expect(out.fleetAccuracy.guaranteed.merge).toBeNull();
    // A structurally-wrong row (missing fields) also reads null rather than publishing garbage.
    await env.DB.prepare(`UPDATE orb_risk_control_arms SET payload_json = '{"alpha":"high"}' WHERE instance_id = 'inst-a' AND arm = 'close'`).run();
    const again = await getPublicStats(env, NOW);
    expect(again.fleetAccuracy.guaranteed.close).toBeNull();
  });

  it("#9050: surfaces the backfilled-vs-live split when the stored calibration carries totalPairs/backfilledPairs", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "" });
    await env.DB.prepare(`INSERT INTO orb_instances (instance_id, registered) VALUES ('inst-a', 1)`).run();
    await env.DB.prepare(`INSERT INTO orb_risk_control_arms (instance_id, arm, payload_json) VALUES ('inst-a', 'close', ?)`)
      .bind(JSON.stringify(calibrated({ totalPairs: 234, backfilledPairs: 231 })))
      .run();
    const out = await getPublicStats(env, NOW);
    expect(out.fleetAccuracy.guaranteed.close).toEqual({ alpha: 0.015, lambda: 0.94, aiJudgedCoveragePct: 82, n: 240, backfilledPct: 98.7 });
  });

  it("#9068: rejects a stored row whose status is not 'calibrated' (defense in depth against a pre-#9068 write)", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "" });
    await env.DB.prepare(`INSERT INTO orb_instances (instance_id, registered) VALUES ('inst-a', 1)`).run();
    await env.DB.prepare(`INSERT INTO orb_risk_control_arms (instance_id, arm, payload_json) VALUES ('inst-a', 'close', ?)`)
      .bind(JSON.stringify(calibrated({ status: "insufficient_labels" })))
      .run();
    const out = await getPublicStats(env, NOW);
    expect(out.fleetAccuracy.guaranteed.close).toBeNull();
  });

  it("#9121: an UNREGISTERED instance's row never publishes (the same open-ingest-can't-plant-a-guarantee invariant, now enforced at read time too)", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "" });
    await env.DB.prepare(`INSERT INTO orb_instances (instance_id, registered) VALUES ('inst-b', 0)`).run();
    await env.DB.prepare(`INSERT INTO orb_risk_control_arms (instance_id, arm, payload_json) VALUES ('inst-b', 'close', ?)`)
      .bind(JSON.stringify(calibrated()))
      .run();
    const out = await getPublicStats(env, NOW);
    expect(out.fleetAccuracy.guaranteed.close).toBeNull();
  });

  it("#9121: aggregates across multiple registered instances, preferring the larger sample size (nAtLambda)", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "" });
    await env.DB.prepare(`INSERT INTO orb_instances (instance_id, registered) VALUES ('small-n', 1), ('big-n', 1)`).run();
    await env.DB.prepare(`INSERT INTO orb_risk_control_arms (instance_id, arm, payload_json) VALUES ('small-n', 'close', ?)`)
      .bind(JSON.stringify(calibrated({ lambda: 0.9, coverageAtLambda: 0.7, nAtLambda: 210 })))
      .run();
    await env.DB.prepare(`INSERT INTO orb_risk_control_arms (instance_id, arm, payload_json) VALUES ('big-n', 'close', ?)`)
      .bind(JSON.stringify(calibrated({ lambda: 0.97, coverageAtLambda: 0.9, nAtLambda: 5000 })))
      .run();
    const out = await getPublicStats(env, NOW);
    expect(out.fleetAccuracy.guaranteed.close).toEqual({ alpha: 0.015, lambda: 0.97, aiJudgedCoveragePct: 90, n: 5000, backfilledPct: null });
  });

  it("#9068: a top (largest-nAtLambda) row that fails validation no longer hides a smaller VALID row behind it", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "" });
    await env.DB.prepare(`INSERT INTO orb_instances (instance_id, registered) VALUES ('bad-n', 1), ('good-n', 1)`).run();
    // Largest nAtLambda, but alpha is out of range -- must be skipped, not returned as null outright.
    await env.DB.prepare(`INSERT INTO orb_risk_control_arms (instance_id, arm, payload_json) VALUES ('bad-n', 'close', ?)`)
      .bind(JSON.stringify(calibrated({ alpha: 0.2, nAtLambda: 9000 })))
      .run();
    await env.DB.prepare(`INSERT INTO orb_risk_control_arms (instance_id, arm, payload_json) VALUES ('good-n', 'close', ?)`)
      .bind(JSON.stringify(calibrated({ nAtLambda: 300 })))
      .run();
    const out = await getPublicStats(env, NOW);
    expect(out.fleetAccuracy.guaranteed.close).toEqual({ alpha: 0.015, lambda: 0.94, aiJudgedCoveragePct: 82, n: 300, backfilledPct: null });
  });
});
