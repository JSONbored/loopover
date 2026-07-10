import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { computePredictedGateAgreement } from "../../src/review/predicted-gate-agreement";
import { createTestEnv } from "../helpers/d1";

async function seedPredicted(env: Env, opts: { login: string; project: string; action: "merge" | "hold" | string; createdAt: string }) {
  await env.DB.prepare(`INSERT INTO predicted_gate_calls (id, login, project, predicted_action, conclusion, reason_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), opts.login, opts.project, opts.action, opts.action === "merge" ? "success" : "failure", null, opts.createdAt)
    .run();
}

async function seedReal(env: Env, opts: { login: string; project: string; decision: "merge" | "hold" | "close" | string; createdAt: string; pullNumber?: number }) {
  const pr = opts.pullNumber ?? 1;
  await env.DB.prepare(`INSERT INTO contributor_gate_history (id, login, source, project, target_id, decision, head_sha, created_at) VALUES (?, ?, 'gittensory-native', ?, ?, ?, 'sha', ?)`)
    .bind(crypto.randomUUID(), opts.login, opts.project, `${opts.project}#${pr}`, opts.decision, opts.createdAt)
    .run();
}

function hoursAfter(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 60 * 60 * 1000).toISOString();
}

const T0 = "2026-05-01T00:00:00.000Z";
const NOW = new Date("2026-06-01T00:00:00.000Z").getTime();

describe("computePredictedGateAgreement — predicted-vs-live gate agreement (#predicted-live-gate-agreement)", () => {
  it("pairs a predicted 'merge' with a real 'merge' as bothMerge, full agreement", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: T0 });
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 2) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    const row = report.rows.find((r) => r.project === "owner/repo");
    expect(row).toMatchObject({ pairedSamples: 1, bothMerge: 1, bothHold: 0, disagree: 0, unsafeDisagreements: 0, agreementRate: 1 });
  });

  it("pairs a predicted 'hold' with a real 'hold' as bothHold, full agreement", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "hold", createdAt: T0 });
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "hold", createdAt: hoursAfter(T0, 2) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    const row = report.rows.find((r) => r.project === "owner/repo");
    expect(row).toMatchObject({ pairedSamples: 1, bothMerge: 0, bothHold: 1, agreementRate: 1 });
  });

  it("flags predicted 'merge' vs real 'hold' as an UNSAFE disagreement (the misleading direction)", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: T0 });
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "hold", createdAt: hoursAfter(T0, 2) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    const row = report.rows.find((r) => r.project === "owner/repo");
    expect(row).toMatchObject({ pairedSamples: 1, disagree: 1, unsafeDisagreements: 1, agreementRate: 0 });
  });

  it("does NOT flag predicted 'hold' vs real 'merge' as unsafe (a wasted double-check, not a false all-clear)", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "hold", createdAt: T0 });
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 2) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    const row = report.rows.find((r) => r.project === "owner/repo");
    expect(row).toMatchObject({ pairedSamples: 1, disagree: 1, unsafeDisagreements: 0 });
  });

  it("pairs MULTIPLE predicted calls (a contributor iterating) against the SAME eventual real decision", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "hold", createdAt: T0 });
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: hoursAfter(T0, 1) });
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 3) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    const row = report.rows.find((r) => r.project === "owner/repo");
    // Both predicted calls pair to the one real decision: the first (hold) disagrees, the second (merge) agrees.
    expect(row).toMatchObject({ pairedSamples: 2, bothMerge: 1, disagree: 1 });
  });

  it("does not pair a predicted call with no real decision at all (project absent from the report)", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: T0 });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    expect(report.rows.find((r) => r.project === "owner/repo")).toBeUndefined();
  });

  it("does not pair across DIFFERENT logins in the same repo", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: T0 });
    await seedReal(env, { login: "someone-else", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 2) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    expect(report.rows.find((r) => r.project === "owner/repo")).toBeUndefined();
  });

  it("does not pair across DIFFERENT projects for the same login", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: T0 });
    await seedReal(env, { login: "octocat", project: "owner/other-repo", decision: "merge", createdAt: hoursAfter(T0, 2) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    expect(report.rows).toHaveLength(0);
  });

  it("skips a non-binary real decision (e.g. an autonomous 'close') and pairs the NEXT binary one in the window", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: T0 });
    // An unrelated earlier PR from the same contributor auto-closed (e.g. CI failure) -- not a comparable
    // gate verdict, so pairing must skip past it rather than giving up on the whole window.
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "close", createdAt: hoursAfter(T0, 1), pullNumber: 1 });
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 2), pullNumber: 2 });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    const row = report.rows.find((r) => r.project === "owner/repo");
    expect(row).toMatchObject({ pairedSamples: 1, bothMerge: 1 });
  });

  it("respects a custom correlationWindowMs — pairs exactly AT the boundary, excludes just past it", async () => {
    const env = createTestEnv();
    const oneHourMs = 60 * 60 * 1000;
    await seedPredicted(env, { login: "at-edge", project: "owner/repo", action: "merge", createdAt: T0 });
    await seedReal(env, { login: "at-edge", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 1) }); // exactly at the edge

    await seedPredicted(env, { login: "past-edge", project: "owner/repo", action: "merge", createdAt: T0 });
    await seedReal(env, { login: "past-edge", project: "owner/repo", decision: "merge", createdAt: new Date(new Date(T0).getTime() + oneHourMs + 1).toISOString() }); // 1ms past

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW, correlationWindowMs: oneHourMs });
    const row = report.rows.find((r) => r.project === "owner/repo");
    // Only the at-edge pair counts; the past-edge pair is excluded.
    expect(row?.pairedSamples).toBe(1);
  });

  it("scopes to ONE project when opts.project is supplied, even with other projects' data present", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo-a", action: "merge", createdAt: T0 });
    await seedReal(env, { login: "octocat", project: "owner/repo-a", decision: "merge", createdAt: hoursAfter(T0, 1) });
    await seedPredicted(env, { login: "octocat", project: "owner/repo-b", action: "merge", createdAt: T0 });
    await seedReal(env, { login: "octocat", project: "owner/repo-b", decision: "merge", createdAt: hoursAfter(T0, 1) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW, project: "owner/repo-a" });
    expect(report.rows.map((r) => r.project)).toEqual(["owner/repo-a"]);
  });

  it("aggregates multiple projects independently, sorted by project name", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/zzz", action: "merge", createdAt: T0 });
    await seedReal(env, { login: "octocat", project: "owner/zzz", decision: "merge", createdAt: hoursAfter(T0, 1) });
    await seedPredicted(env, { login: "octocat", project: "owner/aaa", action: "hold", createdAt: T0 });
    await seedReal(env, { login: "octocat", project: "owner/aaa", decision: "merge", createdAt: hoursAfter(T0, 1) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    expect(report.rows.map((r) => r.project)).toEqual(["owner/aaa", "owner/zzz"]);
    expect(report.rows.find((r) => r.project === "owner/zzz")).toMatchObject({ bothMerge: 1 });
    expect(report.rows.find((r) => r.project === "owner/aaa")).toMatchObject({ disagree: 1 });
  });

  it("ignores a non-binary predicted_action defensively (never written in practice, but the read must not crash)", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "bogus", createdAt: T0 });
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 1) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    expect(report.rows.find((r) => r.project === "owner/repo")).toBeUndefined();
  });

  it("hasSignal flips true once a project reaches 30 paired samples, false below it", async () => {
    const env = createTestEnv();
    for (let i = 0; i < 29; i++) {
      await seedPredicted(env, { login: `c${i}`, project: "owner/repo", action: "merge", createdAt: T0 });
      await seedReal(env, { login: `c${i}`, project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 1) });
    }
    const below = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    expect(below.rows.find((r) => r.project === "owner/repo")?.pairedSamples).toBe(29);
    expect(below.hasSignal).toBe(false);

    await seedPredicted(env, { login: "c29", project: "owner/repo", action: "merge", createdAt: T0 });
    await seedReal(env, { login: "c29", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 1) });
    const atThreshold = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    expect(atThreshold.rows.find((r) => r.project === "owner/repo")?.pairedSamples).toBe(30);
    expect(atThreshold.hasSignal).toBe(true);
  });

  it("fails safe (empty report, never throws) when the predicted_gate_calls read errors", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/predicted_gate_calls/i.test(sql)) throw new Error("d1 down");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(computePredictedGateAgreement(env, { days: 90, nowMs: NOW })).resolves.toEqual({ rows: [], hasSignal: false });
    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("predicted_gate_agreement_read_error"))).toBe(true);
    warn.mockRestore();
  });

  it("fails safe (empty report, never throws) when the contributor_gate_history read errors", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/contributor_gate_history/i.test(sql)) throw new Error("d1 down");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;

    await expect(computePredictedGateAgreement(env, { days: 90, nowMs: NOW })).resolves.toEqual({ rows: [], hasSignal: false });
  });

  it("defaults `days` to 90 when invalid (0/negative/non-finite), mirroring parity.ts's own convention", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: hoursAfter(T0, 24 * 20) });
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 24 * 20 + 1) });

    const report = await computePredictedGateAgreement(env, { days: 0, nowMs: NOW });
    expect(report.rows.find((r) => r.project === "owner/repo")?.pairedSamples).toBe(1);
  });
});

describe("GET /v1/internal/predicted-agreement — bearer-gated, flag-gated endpoint", () => {
  const bearer = (env: Env) => ({ authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` });

  it("401s without the internal token", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    expect((await app.request("/v1/internal/predicted-agreement", {}, env)).status).toBe(401);
  });

  it("404s when GITTENSORY_REVIEW_PARITY_AUDIT is OFF — the endpoint does not exist", async () => {
    const app = createApp();
    const env = createTestEnv(); // flag unset → OFF
    const res = await app.request("/v1/internal/predicted-agreement", { headers: bearer(env) }, env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  it("200s with the predicted-agreement report when ON and authorized", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    // The route hardcodes nowMs: Date.now() (no query-param override yet), so seed data relative to the
    // ACTUAL current time rather than a fixed calendar date -- a fixed T0 would silently fall outside the
    // 90-day window once enough real time has passed since this test was written.
    const nowIso = new Date().toISOString();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: nowIso });
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "merge", createdAt: hoursAfter(nowIso, 1) });

    const res = await app.request("/v1/internal/predicted-agreement", { headers: bearer(env) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasSignal: boolean; rows: Array<{ project: string; pairedSamples: number }> };
    expect(body.rows.find((r) => r.project === "owner/repo")?.pairedSamples).toBe(1);
    // Privacy: aggregate only — never actor logins / trust internals.
    expect(JSON.stringify(body)).not.toMatch(/octocat|login|actor|reward|payout|trust|wallet|hotkey/i);
  });
});
