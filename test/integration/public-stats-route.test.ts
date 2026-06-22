import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";

/** Seed a handful of terminal review dispositions (+ one reversal) into review_targets / review_audit. */
async function seed(env: Env) {
  const rows: Array<[string, string, number, string]> = [
    ["t-m1", "JSONbored/gittensory", 1, "merged"],
    ["t-c1", "JSONbored/gittensory", 2, "closed"],
    ["t-cm1", "JSONbored/gittensory", 3, "commented"],
    ["t-ig1", "JSONbored/gittensory", 4, "ignored"], // excluded from "reviewed"
    ["t-m2", "JSONbored/awesome-claude", 5, "merged"],
    ["t-m3", "JSONbored/awesome-claude", 6, "merged"],
  ];
  for (const [id, project, number, status] of rows) {
    await env.DB.prepare(
      `INSERT INTO review_targets (id, project, kind, repo, number, status) VALUES (?, ?, 'pr', ?, ?, ?)`,
    )
      .bind(id, project, project, number, status)
      .run();
  }
  // One human reversal of a gittensory auto-merge (awesome-claude has none → exercises the per-project ?? 0).
  await env.DB.prepare(
    `INSERT INTO review_audit (id, project, target_id, event_type, decision) VALUES ('rev1', 'JSONbored/gittensory', 't-m1', 'reversal_reverted', 'merge')`,
  ).run();
}

describe("GET /v1/public/stats (#1059)", () => {
  it("404s when GITTENSORY_PUBLIC_STATS is off (default)", async () => {
    const env = createTestEnv();
    const res = await createApp().request("/v1/public/stats", {}, env);
    expect(res.status).toBe(404);
  });

  it("serves public-safe aggregates with no auth + a cache header when enabled", async () => {
    const env = createTestEnv({ GITTENSORY_PUBLIC_STATS: "1" });
    await seed(env);
    const res = await createApp().request("/v1/public/stats", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=60");

    const body = (await res.json()) as {
      totals: Record<string, number | null>;
      weekly: { reviewed: number; merged: number };
      byProject: Array<{ project: string; reviewed: number }>;
    };
    expect(body.totals.handled).toBe(6);
    expect(body.totals.merged).toBe(3);
    expect(body.totals.closed).toBe(1);
    expect(body.totals.commented).toBe(1);
    expect(body.totals.ignored).toBe(1);
    expect(body.totals.manual).toBe(0);
    expect(body.totals.error).toBe(0);
    expect(body.totals.reviewed).toBe(5); // merged 3 + closed 1 + commented 1 (ignored excluded)
    expect(body.totals.reversed).toBe(1);
    expect(body.totals.accuracyPct).toBe(75); // 1 - 1 / (3 + 1)
    // busiest repo first: gittensory reviewed 3 (m1+c1+cm1) > awesome-claude 2 (m2+m3)
    expect(body.byProject[0]?.project).toBe("JSONbored/gittensory");
    expect(body.byProject.map((p) => p.project)).toContain(
      "JSONbored/awesome-claude",
    );
  });
});
