import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";

// The `/v1/internal/decision` + `/v1/internal/calibration` operator read endpoints wire the ops.ts handlers
// (handleInternalDecision / handleInternalCalibration) into real routes. Bearer-gated by the `/v1/internal/*`
// middleware (INTERNAL_JOB_TOKEN); the handlers re-check that same token via their own requireInternalAuth.
const bearer = (env: Env) => ({ authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` });

describe("GET /v1/internal/decision — operator decision-trail endpoint", () => {
  it("401s without the internal token (the /v1/internal/* middleware gate)", async () => {
    const app = createApp();
    const env = createTestEnv();
    expect((await app.request("/v1/internal/decision?repo=owner/repo&number=5", {}, env)).status).toBe(401);
    expect((await app.request("/v1/internal/decision?repo=owner/repo&number=5", { headers: { authorization: "Bearer nope" } }, env)).status).toBe(401);
  });

  it("400s on a missing/invalid repo+number", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/internal/decision?repo=bad", { headers: bearer(env) }, env);
    expect(res.status).toBe(400);
  });

  it("404s when the target does not exist", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/internal/decision?repo=owner/repo&number=999", { headers: bearer(env) }, env);
    expect(res.status).toBe(404);
  });

  it("200s with the decision trail for a seeded target, scoped to the app slug", async () => {
    const app = createApp();
    const env = createTestEnv(); // GITHUB_APP_SLUG defaults to "gittensory"
    // review_targets is raw-SQL-only (migration 0050) — seed the row the endpoint reads back. Its id is the
    // project-namespaced natural key `${slug}:${kind}:${repo}#${number}` (rowId).
    await env.DB.prepare(
      `INSERT INTO review_targets (id, project, kind, repo, number, status, verdict, head_sha, decided_sha, attempt_count, terminal_at, decision_json)
       VALUES (?, ?, 'pull_request', ?, ?, 'merged', 'merge', 'abc123', 'abc123', 1, '2026-07-01T00:00:00Z', ?)`,
    )
      .bind("gittensory:pull_request:owner/repo#5", "gittensory", "owner/repo", 5, JSON.stringify({ action: "merge", confidence: 0.9 }))
      .run();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, summary, created_at)
       VALUES ('a1', 'gittensory', ?, 'reviewed', 'merge', 'looks good', '2026-07-01T00:00:00Z')`,
    )
      .bind("gittensory:pull_request:owner/repo#5")
      .run();
    const res = await app.request("/v1/internal/decision?repo=owner/repo&number=5", { headers: bearer(env) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: string; target: { number: number; status: string }; decision: unknown; audit: Array<{ event: string }> };
    expect(body.project).toBe("gittensory");
    expect(body.target.number).toBe(5);
    expect(body.target.status).toBe("merged");
    expect(body.decision).toEqual({ action: "merge", confidence: 0.9 });
    expect(body.audit.map((a) => a.event)).toContain("reviewed");
    // Privacy: aggregate review state only — never actor logins / trust internals.
    expect(JSON.stringify(body)).not.toMatch(/login|actor|reward|payout|trust|wallet|hotkey/i);
  });
});

describe("GET /v1/internal/calibration — operator calibration endpoint", () => {
  it("401s without the internal token (the /v1/internal/* middleware gate)", async () => {
    const app = createApp();
    const env = createTestEnv();
    expect((await app.request("/v1/internal/calibration", {}, env)).status).toBe(401);
  });

  it("200s with the calibration report (fail-safe empty), scoped to the app slug", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/internal/calibration", { headers: bearer(env) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: string; calibration: { currentFloor: number; note: string } };
    expect(body.project).toBe("gittensory");
    expect(typeof body.calibration.currentFloor).toBe("number");
    expect(typeof body.calibration.note).toBe("string");
  });

  it("falls back to the 'loopover' project slug when GITHUB_APP_SLUG is unset (the || default branch)", async () => {
    const app = createApp();
    const env = createTestEnv({ GITHUB_APP_SLUG: "" });
    const res = await app.request("/v1/internal/calibration", { headers: bearer(env) }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { project: string }).project).toBe("loopover");
  });
});
