import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { clearPublicStatsManifestOverrideCacheForTest } from "../../src/review/public-stats";
import { PUBLIC_ACCURACY_TREND_WEEKS } from "../../src/services/public-accuracy-trend";
import { PUBLIC_REUSE_RATE_TREND_WEEKS } from "../../src/services/public-reuse-rate-trend";
import { PUBLIC_REVIEW_VOLUME_TREND_WEEKS } from "../../src/services/public-review-volume-trend";

/** Seed the LIVE ledger: a published-review surface per reviewed PR (audit_events) + each PR's terminal
 *  disposition (pull_requests state/merged_at), plus one live reversal (an engine close on a now-reopened PR). */
async function seed(env: Env) {
  // [repo, number, state, mergedAt] — merged (merged_at set) / closed (state closed, no merge) / open (in review).
  const prs: Array<[string, number, string, string | null]> = [
    ["JSONbored/loopover", 1, "closed", "2026-06-20T00:00:00Z"], // merged
    ["JSONbored/loopover", 2, "closed", null], // closed without merge
    ["JSONbored/loopover", 3, "open", null], // still in review
    ["JSONbored/awesome-claude", 5, "closed", "2026-06-20T00:00:00Z"], // merged
    ["JSONbored/awesome-claude", 6, "closed", "2026-06-20T00:00:00Z"], // merged
  ];
  for (const [repo, number, state, mergedAt] of prs) {
    await env.DB.prepare(
      `INSERT INTO audit_events (id, event_type, target_key, outcome) VALUES (?, 'github_app.pr_public_surface_published', ?, 'completed')`,
    )
      .bind(`ae-${repo}-${number}`, `${repo}#${number}`)
      .run();
    await env.DB.prepare(
      `INSERT INTO pull_requests (id, repo_full_name, number, title, state, merged_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        `pr-${repo}-${number}`,
        repo,
        number,
        `PR ${number}`,
        state,
        mergedAt,
      )
      .run();
  }
  // One live reversal: the engine CLOSED loopover#3, and a contributor reopened it — a human overturned the
  // auto-action, recorded as a reversal_reopened event (outcomes-wire.ts's recordReversalSignals). awesome-claude
  // has none → exercises the per-project ?? 0 fallback.
  await env.DB.prepare(
    `INSERT INTO audit_events (id, event_type, target_key, outcome) VALUES ('rev1', 'agent.action.close', 'JSONbored/loopover#3', 'completed')`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO audit_events (id, event_type, target_key, outcome) VALUES ('rev1-reopened', 'reversal_reopened', 'JSONbored/loopover#3', 'completed')`,
  ).run();
}

describe("GET /v1/public/stats (#1059)", () => {
  beforeEach(() => {
    clearPublicStatsManifestOverrideCacheForTest();
  });

  it("404s when LOOPOVER_PUBLIC_STATS is off (default)", async () => {
    const env = createTestEnv();
    const res = await createApp().request("/v1/public/stats", {}, env);
    expect(res.status).toBe(404);
  });

  it("a present publicStats manifest override turns the endpoint ON even when LOOPOVER_PUBLIC_STATS is OFF (#6275)", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: "JSONbored/loopover" }); // flag unset → OFF
    await upsertRepoFocusManifest(env, "JSONbored/loopover", { publicStats: { enabled: true } });
    const res = await createApp().request("/v1/public/stats", {}, env);
    expect(res.status).toBe(200);
  });

  it("a present publicStats manifest override turns the endpoint OFF even when LOOPOVER_PUBLIC_STATS is ON (#6275)", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "1", LOOPOVER_DRIFT_ISSUE_REPO: "JSONbored/loopover" });
    await upsertRepoFocusManifest(env, "JSONbored/loopover", { publicStats: { enabled: false } });
    const res = await createApp().request("/v1/public/stats", {}, env);
    expect(res.status).toBe(404);
  });

  it("serves public-safe aggregates with no auth + a cache header when enabled", async () => {
    const env = createTestEnv({
      LOOPOVER_PUBLIC_STATS: "1",
      LOOPOVER_PUBLIC_STATS_REPOS: "JSONbored/loopover,JSONbored/awesome-claude",
    });
    await seed(env);
    const res = await createApp().request("/v1/public/stats", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=60");

    // #8230: the measured-accuracy block rides the same surface, same flag, same cache.
    const withPrecision = (await res.clone().json()) as {
      rulePrecision: { windowDays: number; rules: unknown[]; reversals: Record<string, number>; latestBacktestRun: unknown };
    };
    expect(withPrecision.rulePrecision.windowDays).toBe(90);
    // seed() records one reversal_reopened — the block reads the same ledger the totals do.
    expect(withPrecision.rulePrecision.reversals).toEqual({ reopened: 1, reverted: 0, superseded: 0 });
    expect(withPrecision.rulePrecision.latestBacktestRun).toBeNull();

    const body = (await res.json()) as {
      totals: Record<string, number | null>;
      weekly: { reviewed: number; merged: number };
      byProject: Array<{ project: string; reviewed: number }>;
      accuracyTrend: Array<{ weekStart: string; merged: number | null; closed: number | null; reversed: number | null; accuracyPct: number | null }>;
      reuseRateTrend: Array<{ weekStart: string; hits: number; misses: number; reuseRatePct: number | null }>;
      reviewVolumeTrend: Array<{ weekStart: string; reviewed: number; merged: number; filteredPct: number | null }>;
    };
    expect(body.totals.handled).toBe(5); // distinct reviewed PRs
    expect(body.totals.merged).toBe(3);
    expect(body.totals.closed).toBe(1);
    expect(body.totals.commented).toBe(1); // the still-open reviewed PR
    expect(body.totals.ignored).toBe(0);
    expect(body.totals.manual).toBe(0);
    expect(body.totals.error).toBe(0);
    expect(body.totals.reviewed).toBe(5); // merged 3 + closed 1 + in-review 1
    expect(body.totals.reversed).toBe(1);
    expect(body.totals.accuracyPct).toBe(75); // 1 - 1 / (3 + 1)
    // busiest repo first: loopover reviewed 3 (m1+c1+cm1) > awesome-claude 2 (m2+m3)
    expect(body.byProject[0]?.project).toBe("JSONbored/loopover");
    expect(body.byProject.map((p) => p.project)).toContain(
      "JSONbored/awesome-claude",
    );
    // #4447: the weekly accuracy trend rides along on the SAME response, one entry per trailing week.
    expect(body.accuracyTrend).toHaveLength(PUBLIC_ACCURACY_TREND_WEEKS);
    for (const week of body.accuracyTrend) expect(typeof week.weekStart).toBe("string");
    // #4448: the weekly AI-work reuse-rate trend rides along on the SAME response too.
    expect(body.reuseRateTrend).toHaveLength(PUBLIC_REUSE_RATE_TREND_WEEKS);
    for (const week of body.reuseRateTrend) expect(typeof week.weekStart).toBe("string");
    // #4445 follow-up: the weekly review-volume/filtered-rate trend rides along on the SAME response too.
    expect(body.reviewVolumeTrend).toHaveLength(PUBLIC_REVIEW_VOLUME_TREND_WEEKS);
    for (const week of body.reviewVolumeTrend) expect(typeof week.weekStart).toBe("string");
    // All 5 seeded PRs were published "now" (no explicit created_at in the seed), so the whole cohort lands in
    // the current week: reviewed 5, merged 3 -- the SAME totals as the lifetime totals.reviewed/merged above.
    const currentWeek = body.reviewVolumeTrend[body.reviewVolumeTrend.length - 1];
    expect(currentWeek?.reviewed).toBe(5);
    expect(currentWeek?.merged).toBe(3);
  });
});
