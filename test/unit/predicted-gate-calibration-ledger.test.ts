import { describe, expect, it, vi } from "vitest";
import { recordPredictedGateCalibration } from "../../src/review/predicted-gate-calibration-ledger";
import { createTestEnv } from "../helpers/d1";

async function rawAll(env: Env, sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { all: <T>() => Promise<{ results: T[] }> } } })
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();
  return res.results;
}

async function seedPredicted(env: Env, opts: { login: string; project: string; action: string; createdAt: string }) {
  await env.DB.prepare(`INSERT INTO predicted_gate_calls (id, login, project, predicted_action, conclusion, reason_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), opts.login, opts.project, opts.action, opts.action === "merge" ? "success" : "failure", null, opts.createdAt)
    .run();
}

const repoFullName = "owner/repo";

describe("recordPredictedGateCalibration — login-keyed predict-vs-live calibration ledger (#4517)", () => {
  it("pairs a real 'merge' decision with a recent predicted 'merge' call as agreed=1", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: repoFullName, action: "merge", createdAt: new Date(Date.now() - 60_000).toISOString() });

    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "merge" });

    const rows = await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ login: "octocat", project: repoFullName, target_id: "owner/repo#7", predicted_action: "merge", real_decision: "merge", agreed: 1 });
  });

  it("pairs a real 'hold' decision with a recent predicted 'merge' call as agreed=0 (a disagreement)", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: repoFullName, action: "merge", createdAt: new Date(Date.now() - 60_000).toISOString() });

    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "hold" });

    const rows = await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger");
    expect(rows[0]).toMatchObject({ predicted_action: "merge", real_decision: "hold", agreed: 0 });
  });

  it("cold start: records nothing when there is no prior predicted_gate_calls row for this (login, project)", async () => {
    const env = createTestEnv();
    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "merge" });
    expect(await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger")).toHaveLength(0);
  });

  it("does not pair a predicted call that falls outside the correlation window", async () => {
    const env = createTestEnv();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await seedPredicted(env, { login: "octocat", project: repoFullName, action: "merge", createdAt: eightDaysAgo });

    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "merge" });

    expect(await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger")).toHaveLength(0);
  });

  it("does not pair across DIFFERENT repos for the same login", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: "owner/other-repo", action: "merge", createdAt: new Date(Date.now() - 60_000).toISOString() });

    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "merge" });

    expect(await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger")).toHaveLength(0);
  });

  it("does not record a non-binary real decision (e.g. an autonomous 'close') -- not comparable to a prediction", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: repoFullName, action: "merge", createdAt: new Date(Date.now() - 60_000).toISOString() });

    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "close" });

    expect(await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger")).toHaveLength(0);
  });

  it("defensively ignores a non-binary predicted_action (never written in practice, but the read must not crash)", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: repoFullName, action: "bogus", createdAt: new Date(Date.now() - 60_000).toISOString() });

    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "merge" });

    expect(await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger")).toHaveLength(0);
  });

  it("does not record when the login is missing, null, or blank", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: repoFullName, action: "merge", createdAt: new Date(Date.now() - 60_000).toISOString() });
    await recordPredictedGateCalibration(env, { login: undefined, project: repoFullName, pullNumber: 1, headSha: "sha", decision: "merge" });
    await recordPredictedGateCalibration(env, { login: null, project: repoFullName, pullNumber: 2, headSha: "sha", decision: "merge" });
    await recordPredictedGateCalibration(env, { login: "   ", project: repoFullName, pullNumber: 3, headSha: "sha", decision: "merge" });
    expect(await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger")).toHaveLength(0);
  });

  it("IMMUTABILITY: a replay at the SAME (login, project, pr, commit) is a no-op -- never overwrites the original pairing", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: repoFullName, action: "merge", createdAt: new Date(Date.now() - 60_000).toISOString() });

    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "merge" });
    // A second call at the identical commit, even with a DIFFERENT (spoofed/incorrect) decision, must not
    // change the already-recorded row -- this is the tamper-resistance guarantee the ledger exists for.
    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "hold" });

    const rows = await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ real_decision: "merge", agreed: 1 });
  });

  it("a new commit for the same PR gets its OWN ledger row", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: repoFullName, action: "merge", createdAt: new Date(Date.now() - 60_000).toISOString() });

    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "merge" });
    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha2", decision: "hold" });

    expect(await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger")).toHaveLength(2);
  });

  it("records even with a null head_sha (distinct id bucket, does not collide with a real sha)", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: repoFullName, action: "merge", createdAt: new Date(Date.now() - 60_000).toISOString() });
    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: null, decision: "merge" });
    expect(await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger")).toHaveLength(1);
  });

  it("flag-OFF records NOTHING on the CLOUD WORKER — no D1 write (byte-identical, same gate family as recordContributorGateDecision)", async () => {
    const env = createTestEnv();
    delete env.SELFHOST_TRANSIENT_CACHE;
    await seedPredicted(env, { login: "octocat", project: repoFullName, action: "merge", createdAt: new Date(Date.now() - 60_000).toISOString() });
    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "merge" });
    expect(await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger")).toHaveLength(0);
  });

  it("the cloud worker records when GITTENSORY_REVIEW_PARITY_AUDIT is explicitly ON", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    delete env.SELFHOST_TRANSIENT_CACHE;
    await seedPredicted(env, { login: "octocat", project: repoFullName, action: "merge", createdAt: new Date(Date.now() - 60_000).toISOString() });
    await recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "merge" });
    expect(await rawAll(env, "SELECT * FROM predicted_gate_calibration_ledger")).toHaveLength(1);
  });

  it("fails safe: a read error is swallowed (logs, never throws)", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/SELECT.*FROM.*predicted_gate_calls/i.test(sql)) throw new Error("d1 down");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "merge" })).resolves.toBeUndefined();

    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("predicted_gate_calibration_read_error"))).toBe(true);
    warn.mockRestore();
  });

  it("fails safe: a write error is swallowed (logs, never throws)", async () => {
    const env = createTestEnv();
    await seedPredicted(env, { login: "octocat", project: repoFullName, action: "merge", createdAt: new Date(Date.now() - 60_000).toISOString() });
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/INSERT INTO.*predicted_gate_calibration_ledger/i.test(sql)) throw new Error("d1 down");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(recordPredictedGateCalibration(env, { login: "octocat", project: repoFullName, pullNumber: 7, headSha: "sha1", decision: "merge" })).resolves.toBeUndefined();

    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("predicted_gate_calibration_write_error"))).toBe(true);
    warn.mockRestore();
  });
});
