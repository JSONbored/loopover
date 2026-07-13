import { describe, expect, it, vi } from "vitest";
import { recordPredictedGateCall } from "../../src/review/predicted-gate-calls";
import { createTestEnv } from "../helpers/d1";

// ── Direct D1 helpers over the real migrated schema (0132 predicted_gate_calls) ───────────────────────────────

async function rawAll(env: Env, sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { all: <T>() => Promise<{ results: T[] }> } } })
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();
  return res.results;
}

function verdict(overrides: Partial<{ conclusion: string; blockers: Array<{ code: string }> }> = {}) {
  return { conclusion: "success", blockers: [], ...overrides } as { conclusion: "success" | "failure" | "action_required" | "neutral" | "skipped"; blockers: Array<{ code: string }> };
}

describe("recordPredictedGateCall — write-only predicted-gate call history (0132, #predicted-live-gate-agreement)", () => {
  it("SELF-HOSTED instances record ONE row keyed by login (createTestEnv's default self-host signal)", async () => {
    const env = createTestEnv(); // flag unset → OFF, but SELFHOST_TRANSIENT_CACHE present → self-hosted
    await recordPredictedGateCall(env, { login: "octocat", project: "owner/repo", verdict: verdict() });

    const rows = await rawAll(env, "SELECT * FROM predicted_gate_calls");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ login: "octocat", project: "owner/repo", predicted_action: "merge", conclusion: "success", reason_code: "success" });
    expect(typeof rows[0]!.created_at).toBe("string");
  });

  it("EVERY call gets its own row — no dedup, unlike recordContributorGateDecision's per-commit replace", async () => {
    const env = createTestEnv();
    await recordPredictedGateCall(env, { login: "octocat", project: "owner/repo", verdict: verdict() });
    await recordPredictedGateCall(env, { login: "octocat", project: "owner/repo", verdict: verdict() });
    expect((await rawAll(env, "SELECT * FROM predicted_gate_calls")).length).toBe(2);
  });

  it("maps 'failure' to predicted_action 'hold' and uses the first blocker's code as reason_code", async () => {
    const env = createTestEnv();
    await recordPredictedGateCall(env, { login: "octocat", project: "owner/repo", verdict: verdict({ conclusion: "failure", blockers: [{ code: "missing_linked_issue" }, { code: "oversized_pr" }] }) });
    const rows = await rawAll(env, "SELECT * FROM predicted_gate_calls");
    expect(rows[0]).toMatchObject({ predicted_action: "hold", conclusion: "failure", reason_code: "missing_linked_issue" });
  });

  it("falls back to the bare conclusion string as reason_code when 'failure' has no blockers", async () => {
    const env = createTestEnv();
    await recordPredictedGateCall(env, { login: "octocat", project: "owner/repo", verdict: verdict({ conclusion: "failure", blockers: [] }) });
    const rows = await rawAll(env, "SELECT * FROM predicted_gate_calls");
    expect(rows[0]).toMatchObject({ predicted_action: "hold", reason_code: "failure" });
  });

  it("maps 'action_required' and 'neutral' to predicted_action 'hold', reason_code the bare conclusion", async () => {
    const env = createTestEnv();
    await recordPredictedGateCall(env, { login: "octocat", project: "owner/repo", verdict: verdict({ conclusion: "action_required" }) });
    await recordPredictedGateCall(env, { login: "octocat", project: "owner/repo", verdict: verdict({ conclusion: "neutral" }) });
    const rows = await rawAll(env, "SELECT * FROM predicted_gate_calls ORDER BY rowid ASC");
    expect(rows[0]).toMatchObject({ predicted_action: "hold", conclusion: "action_required", reason_code: "action_required" });
    expect(rows[1]).toMatchObject({ predicted_action: "hold", conclusion: "neutral", reason_code: "neutral" });
  });

  it("does NOT record a 'skipped' conclusion — not a comparable prediction (mirrors recordNativeGateDecision)", async () => {
    const env = createTestEnv();
    await recordPredictedGateCall(env, { login: "octocat", project: "owner/repo", verdict: verdict({ conclusion: "skipped" }) });
    expect((await rawAll(env, "SELECT * FROM predicted_gate_calls")).length).toBe(0);
  });

  it("does NOT record when the login is missing, null, or blank", async () => {
    const env = createTestEnv();
    await recordPredictedGateCall(env, { login: undefined, project: "owner/repo", verdict: verdict() });
    await recordPredictedGateCall(env, { login: null, project: "owner/repo", verdict: verdict() });
    await recordPredictedGateCall(env, { login: "   ", project: "owner/repo", verdict: verdict() });
    expect((await rawAll(env, "SELECT * FROM predicted_gate_calls")).length).toBe(0);
  });

  it("flag-OFF records NOTHING on the CLOUD WORKER — no D1 write (byte-identical, same gate family as recordNativeGateDecision)", async () => {
    const env = createTestEnv();
    delete env.SELFHOST_TRANSIENT_CACHE; // simulate the cloud worker (no self-host binding)
    await recordPredictedGateCall(env, { login: "octocat", project: "owner/repo", verdict: verdict() });
    expect((await rawAll(env, "SELECT * FROM predicted_gate_calls")).length).toBe(0);

    const envFalse = createTestEnv({ LOOPOVER_REVIEW_PARITY_AUDIT: "false" });
    delete envFalse.SELFHOST_TRANSIENT_CACHE;
    await recordPredictedGateCall(envFalse, { login: "octocat", project: "owner/repo", verdict: verdict() });
    expect((await rawAll(envFalse, "SELECT * FROM predicted_gate_calls")).length).toBe(0);
  });

  it("the cloud worker records when LOOPOVER_REVIEW_PARITY_AUDIT is explicitly ON", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_PARITY_AUDIT: "true" });
    delete env.SELFHOST_TRANSIENT_CACHE;
    await recordPredictedGateCall(env, { login: "octocat", project: "owner/repo", verdict: verdict() });
    expect((await rawAll(env, "SELECT * FROM predicted_gate_calls")).length).toBe(1);
  });

  it("fails safe: a D1 write error is swallowed + logged (telemetry never breaks the MCP tool response)", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/predicted_gate_calls/i.test(sql)) throw new Error("poisoned write");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(recordPredictedGateCall(env, { login: "octocat", project: "owner/repo", verdict: verdict() })).resolves.toBeUndefined();

    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("predicted_gate_calls_record_error"))).toBe(true);
    warn.mockRestore();
  });
});
