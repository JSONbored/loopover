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

  // #9138 core regression: N predictions before one real decision must yield EXACTLY ONE paired sample --
  // previously every one of them paired against the same eventual decision, inflating pairedSamples (and
  // agreementRate) by a factor of N. Only the LATEST predicted call (the one closest to, and agreeing with,
  // the real merge) is kept; the earlier "hold" guess is dropped from the aggregate, not double-counted as a
  // second disagreement.
  it("#9138: collapses MULTIPLE predicted calls before one real decision down to exactly ONE paired sample (the latest call)", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "hold", createdAt: T0 });
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: hoursAfter(T0, 1) });
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 3) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    const row = report.rows.find((r) => r.project === "owner/repo");
    // Exactly one paired sample: the latest call ("merge") agrees with the real "merge" -- the earlier
    // ("hold") call is dropped entirely from the aggregate, not counted as its own disagreement.
    expect(row).toMatchObject({ pairedSamples: 1, bothMerge: 1, bothHold: 0, disagree: 0, agreementRate: 1 });
  });

  it("#9138: collapses N (many more than 2) predictions before one real decision down to exactly ONE paired sample", async () => {
    const env = createTestEnv();
    const N = 50; // representative of the issue's "500 calls in ~5 min" trigger; kept smaller here for test speed
    for (let i = 0; i < N; i++) {
      await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: hoursAfter(T0, i / 3600) });
    }
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 1) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    const row = report.rows.find((r) => r.project === "owner/repo");
    // Without the dedup this would report pairedSamples: N, bothMerge: N, agreementRate: 1 -- a contributor
    // flooding predict_gate could not, by itself, manufacture N samples of "signal".
    expect(row).toMatchObject({ pairedSamples: 1, bothMerge: 1, agreementRate: 1 });
  });

  it("#9138: keeps the chronologically-latest predicted call as the pairing even when it isn't the last one READ from the DB", async () => {
    const env = createTestEnv();
    // predicted_gate_calls carries no ORDER BY on the read side, so the read order is not guaranteed to match
    // insertion (chronological) order -- insert the LATER-timestamped call first, so a naive "last one wins"
    // read-order assumption would keep the WRONG (earlier) one. The dedup must compare `created_at`, not rely
    // on read/array order, to correctly keep the chronologically-latest call either way.
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: hoursAfter(T0, 5) }); // later, inserted first
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "hold", createdAt: hoursAfter(T0, 1) }); // earlier, inserted second
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 6) });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    const row = report.rows.find((r) => r.project === "owner/repo");
    // The chronologically-latest call ("merge" at +5h) is kept -- not overwritten by the earlier ("hold" at
    // +1h) call even if that one happens to be read/iterated after it.
    expect(row).toMatchObject({ pairedSamples: 1, bothMerge: 1, bothHold: 0, disagree: 0 });
  });

  it("#9138: two separate real decisions for the same login each get their own paired sample, still deduped independently", async () => {
    const env = createTestEnv();
    // First round: two predictions, then a real 'hold'.
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: T0 });
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "hold", createdAt: hoursAfter(T0, 1) });
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "hold", createdAt: hoursAfter(T0, 2), pullNumber: 1 });
    // Second round, later: two more predictions, then a real 'merge'.
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "hold", createdAt: hoursAfter(T0, 10) });
    await seedPredicted(env, { login: "octocat", project: "owner/repo", action: "merge", createdAt: hoursAfter(T0, 11) });
    await seedReal(env, { login: "octocat", project: "owner/repo", decision: "merge", createdAt: hoursAfter(T0, 12), pullNumber: 2 });

    const report = await computePredictedGateAgreement(env, { days: 90, nowMs: NOW });
    const row = report.rows.find((r) => r.project === "owner/repo");
    // Two real decisions -> two paired samples (one per real decision, each deduped to its own latest call),
    // both agreeing (latest call before the hold was "hold"; latest call before the merge was "merge").
    expect(row).toMatchObject({ pairedSamples: 2, bothHold: 1, bothMerge: 1, disagree: 0 });
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
    const env = createTestEnv({ LOOPOVER_REVIEW_PARITY_AUDIT: "true" });
    expect((await app.request("/v1/internal/predicted-agreement", {}, env)).status).toBe(401);
  });

  it("404s when LOOPOVER_REVIEW_PARITY_AUDIT is OFF — the endpoint does not exist", async () => {
    const app = createApp();
    const env = createTestEnv(); // flag unset → OFF
    const res = await app.request("/v1/internal/predicted-agreement", { headers: bearer(env) }, env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  it("200s with the predicted-agreement report when ON and authorized", async () => {
    const app = createApp();
    const env = createTestEnv({ LOOPOVER_REVIEW_PARITY_AUDIT: "true" });
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
