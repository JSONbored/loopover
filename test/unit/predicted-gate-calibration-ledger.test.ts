import { describe, expect, it, vi } from "vitest";
import { computeContributorCalibration, recordPredictedGateCalibration } from "../../src/review/predicted-gate-calibration-ledger";
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

/** Inserts directly into predicted_gate_calibration_ledger, bypassing recordPredictedGateCalibration's
 *  correlation-window pairing logic -- gives computeContributorCalibration's tests full control over how many
 *  agreed/disagreed rows a login has, regardless of timing. */
async function seedLedgerRow(env: Env, opts: { login: string; project?: string; pullNumber: number; agreed: boolean }) {
  const project = opts.project ?? repoFullName;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO predicted_gate_calibration_ledger (id, login, project, target_id, predicted_action, real_decision, agreed, predicted_at, decided_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), opts.login, project, `${project}#${opts.pullNumber}`, "merge", opts.agreed ? "merge" : "hold", opts.agreed ? 1 : 0, now, now, now)
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

  it("the cloud worker records when LOOPOVER_REVIEW_PARITY_AUDIT is explicitly ON", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_PARITY_AUDIT: "true" });
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

describe("computeContributorCalibration — per-login calibration read (#2349)", () => {
  it("cold start: a login with no ledger rows gets sampleSize 0 / agreementRate 0, not null", async () => {
    const env = createTestEnv();
    expect(await computeContributorCalibration(env, "octocat")).toEqual({ sampleSize: 0, agreementRate: 0 });
  });

  it("aggregates a mix of agreed/disagreed rows into an accurate sampleSize and agreementRate", async () => {
    const env = createTestEnv();
    await seedLedgerRow(env, { login: "octocat", pullNumber: 1, agreed: true });
    await seedLedgerRow(env, { login: "octocat", pullNumber: 2, agreed: true });
    await seedLedgerRow(env, { login: "octocat", pullNumber: 3, agreed: true });
    await seedLedgerRow(env, { login: "octocat", pullNumber: 4, agreed: false });
    await seedLedgerRow(env, { login: "octocat", pullNumber: 5, agreed: false });

    const result = await computeContributorCalibration(env, "octocat");
    expect(result).toEqual({ sampleSize: 5, agreementRate: 0.6 });
  });

  it("a perfect track record aggregates to agreementRate 1", async () => {
    const env = createTestEnv();
    await seedLedgerRow(env, { login: "octocat", pullNumber: 1, agreed: true });
    await seedLedgerRow(env, { login: "octocat", pullNumber: 2, agreed: true });
    expect(await computeContributorCalibration(env, "octocat")).toEqual({ sampleSize: 2, agreementRate: 1 });
  });

  it("scopes strictly per-login — a different login's history never leaks in", async () => {
    const env = createTestEnv();
    await seedLedgerRow(env, { login: "octocat", pullNumber: 1, agreed: false });
    await seedLedgerRow(env, { login: "octocat", pullNumber: 2, agreed: false });
    await seedLedgerRow(env, { login: "someone-else", pullNumber: 1, agreed: true });

    expect(await computeContributorCalibration(env, "octocat")).toEqual({ sampleSize: 2, agreementRate: 0 });
    expect(await computeContributorCalibration(env, "someone-else")).toEqual({ sampleSize: 1, agreementRate: 1 });
  });

  it("canonicalizes GitHub login casing so case variants cannot bypass or infer calibration", async () => {
    const env = createTestEnv();
    await seedLedgerRow(env, { login: "OctoCat", pullNumber: 1, agreed: false });
    await seedLedgerRow(env, { login: "octocat", pullNumber: 2, agreed: false });
    await seedLedgerRow(env, { login: "OCTOCAT", pullNumber: 3, agreed: true });
    await seedLedgerRow(env, { login: "someone-else", pullNumber: 1, agreed: true });

    const expected = { sampleSize: 3, agreementRate: 1 / 3 };
    expect(await computeContributorCalibration(env, "OctoCat")).toEqual(expected);
    expect(await computeContributorCalibration(env, " octocat ")).toEqual(expected);
    expect(await computeContributorCalibration(env, "OCTOCAT")).toEqual(expected);
    expect(await computeContributorCalibration(env, "someone-else")).toEqual({ sampleSize: 1, agreementRate: 1 });
  });

  it("uses the matching lower(login) expression index for canonicalized calibration lookups", async () => {
    const env = createTestEnv();

    const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
      .bind("predicted_gate_calibration_ledger_login_lower_idx")
      .first<{ name: string }>();
    expect(idx?.name).toBe("predicted_gate_calibration_ledger_login_lower_idx");

    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) AS sampleSize, COALESCE(AVG(agreed), 0) AS agreementRate
         FROM predicted_gate_calibration_ledger
        WHERE lower(login) = ?`,
    )
      .bind("octocat")
      .all<{ detail: string }>();
    const detail = (plan.results ?? []).map((row) => row.detail).join(" ");
    expect(detail).toContain("predicted_gate_calibration_ledger_login_lower_idx");
    expect(detail).not.toContain("SCAN predicted_gate_calibration_ledger");
  });

  it("aggregates across ALL of a login's history regardless of which repo each pairing came from", async () => {
    const env = createTestEnv();
    await seedLedgerRow(env, { login: "octocat", project: "owner/repo-a", pullNumber: 1, agreed: true });
    await seedLedgerRow(env, { login: "octocat", project: "owner/repo-b", pullNumber: 1, agreed: false });
    expect(await computeContributorCalibration(env, "octocat")).toEqual({ sampleSize: 2, agreementRate: 0.5 });
  });

  it("returns null for a missing, null, or blank login — nothing meaningful to look up", async () => {
    const env = createTestEnv();
    await seedLedgerRow(env, { login: "octocat", pullNumber: 1, agreed: true });
    expect(await computeContributorCalibration(env, undefined)).toBeNull();
    expect(await computeContributorCalibration(env, null)).toBeNull();
    expect(await computeContributorCalibration(env, "   ")).toBeNull();
  });

  it("reads regardless of the self-hosted/parity-audit flag — unlike the writer, the read is not flag-gated", async () => {
    const env = createTestEnv();
    delete env.SELFHOST_TRANSIENT_CACHE; // simulates the cloud worker, where the WRITER would have been skipped
    await seedLedgerRow(env, { login: "octocat", pullNumber: 1, agreed: true });
    expect(await computeContributorCalibration(env, "octocat")).toEqual({ sampleSize: 1, agreementRate: 1 });
  });

  it("fails safe: a read error resolves to null (logs, never throws)", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/SELECT[\s\S]*FROM[\s\S]*predicted_gate_calibration_ledger/i.test(sql)) throw new Error("d1 down");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(computeContributorCalibration(env, "octocat")).resolves.toBeNull();

    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("contributor_calibration_read_error"))).toBe(true);
    warn.mockRestore();
  });
});
