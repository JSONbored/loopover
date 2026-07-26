import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";

// #8830: the adjudication operator surface. A label is calibration data — the routes must never let one be
// silently rewritten (409 on a second adjudication) and must reject malformed labels outright.
describe("decision-audit adjudication routes (/v1/internal/audit-labels)", () => {
  const app = createApp();
  const auth = { authorization: "Bearer dev-internal-token", "content-type": "application/json" };

  async function seedLabel(env: Env, id = "audit:o/r#1"): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO decision_audit_labels (id, project, target_id, verdict, outcome, stratum, rubric_version, sampled_at)
       VALUES (?, 'o/r', ?, 'merge', 'merged', 'merge_arm', '1', ?)`,
    )
      .bind(id, id.replace("audit:", ""), new Date().toISOString())
      .run();
  }

  it("requires the internal bearer", async () => {
    expect((await app.request("/v1/internal/audit-labels", {}, createTestEnv())).status).toBe(401);
  });

  it("lists labels, filterable by status", async () => {
    const env = createTestEnv();
    await seedLabel(env, "audit:o/r#1");
    await seedLabel(env, "audit:o/r#2");
    const all = (await (await app.request("/v1/internal/audit-labels", { headers: auth }, env)).json()) as { labels: Array<{ id: string; status: string }> };
    expect(all.labels).toHaveLength(2);
    const pending = (await (await app.request("/v1/internal/audit-labels?status=pending", { headers: auth }, env)).json()) as { labels: unknown[] };
    expect(pending.labels).toHaveLength(2);
    const done = (await (await app.request("/v1/internal/audit-labels?status=adjudicated", { headers: auth }, env)).json()) as { labels: unknown[] };
    expect(done.labels).toHaveLength(0);
  });

  it("adjudicates a pending label once; a second write 409s; unknown 404s; bad payloads 400", async () => {
    const env = createTestEnv();
    await seedLabel(env);
    const ok = await app.request(
      "/v1/internal/audit-labels/adjudicate",
      { method: "POST", headers: auth, body: JSON.stringify({ id: "audit:o/r#1", adjudication: "incorrect", reasonCategory: "missed_defect" }) },
      env,
    );
    expect(ok.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, adjudication, reason_category, adjudicated_at FROM decision_audit_labels WHERE id = 'audit:o/r#1'").first<{ status: string; adjudication: string; reason_category: string; adjudicated_at: string }>();
    expect(row).toMatchObject({ status: "adjudicated", adjudication: "incorrect", reason_category: "missed_defect" });
    expect(typeof row!.adjudicated_at).toBe("string");

    const again = await app.request("/v1/internal/audit-labels/adjudicate", { method: "POST", headers: auth, body: JSON.stringify({ id: "audit:o/r#1", adjudication: "correct" }) }, env);
    expect(again.status).toBe(409);

    expect((await app.request("/v1/internal/audit-labels/adjudicate", { method: "POST", headers: auth, body: JSON.stringify({ id: "audit:nope#1", adjudication: "correct" }) }, env)).status).toBe(404);
    expect((await app.request("/v1/internal/audit-labels/adjudicate", { method: "POST", headers: auth, body: JSON.stringify({ id: "audit:o/r#1", adjudication: "maybe" }) }, env)).status).toBe(400);
    expect((await app.request("/v1/internal/audit-labels/adjudicate", { method: "POST", headers: auth, body: "{not json" }, env)).status).toBe(400);
    // uncertain is a first-class label, not an error; reasonCategory stays optional.
    await seedLabel(env, "audit:o/r#2");
    const uncertain = await app.request("/v1/internal/audit-labels/adjudicate", { method: "POST", headers: auth, body: JSON.stringify({ id: "audit:o/r#2", adjudication: "uncertain" }) }, env);
    expect(uncertain.status).toBe(200);
  });
});
