import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";
import { PUBLIC_ACCURACY_TREND_WEEKS } from "../../src/services/public-accuracy-trend";
import { PUBLIC_REUSE_RATE_TREND_WEEKS } from "../../src/services/public-reuse-rate-trend";
import { PUBLIC_REVIEW_VOLUME_TREND_WEEKS } from "../../src/services/public-review-volume-trend";

/** Seed the LIVE ledger: a published-review surface per reviewed PR (audit_events) + each PR's terminal
 *  disposition (pull_requests state/merged_at), plus one live reversal (an engine close on a now-reopened PR). */
async function seed(env: Env) {
  // [repo, number, state, mergedAt] — merged (merged_at set) / closed (state closed, no merge) / open (in review).
  const prs: Array<[string, number, string, string | null]> = [
    ["JSONbored/gittensory", 1, "closed", "2026-06-20T00:00:00Z"], // merged
    ["JSONbored/gittensory", 2, "closed", null], // closed without merge
    ["JSONbored/gittensory", 3, "open", null], // still in review
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
  // One live reversal: the engine CLOSED gittensory#3, but it is now reopened (state 'open') — a human overturned
  // the auto-action. awesome-claude has none → exercises the per-project ?? 0 fallback.
  await env.DB.prepare(
    `INSERT INTO audit_events (id, event_type, target_key, outcome) VALUES ('rev1', 'agent.action.close', 'JSONbored/gittensory#3', 'completed')`,
  ).run();
}

describe("GET /v1/public/stats (#1059)", () => {
  it("404s when GITTENSORY_PUBLIC_STATS is off (default)", async () => {
    const env = createTestEnv();
    const res = await createApp().request("/v1/public/stats", {}, env);
    expect(res.status).toBe(404);
  });

  it("serves public-safe aggregates with no auth + a cache header when enabled", async () => {
    const env = createTestEnv({
      GITTENSORY_PUBLIC_STATS: "1",
      GITTENSORY_PUBLIC_STATS_REPOS: "JSONbored/gittensory,JSONbored/awesome-claude",
    });
    await seed(env);
    const res = await createApp().request("/v1/public/stats", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=60");

    const body = (await res.json()) as {
      totals: Record<string, number | null>;
      weekly: { reviewed: number; merged: number };
      byProject: Array<{ project: string; reviewed: number }>;
      accuracyTrend: Array<{ weekStart: string; merged: number; closed: number; reversed: number; accuracyPct: number | null }>;
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
    // busiest repo first: gittensory reviewed 3 (m1+c1+cm1) > awesome-claude 2 (m2+m3)
    expect(body.byProject[0]?.project).toBe("JSONbored/gittensory");
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
