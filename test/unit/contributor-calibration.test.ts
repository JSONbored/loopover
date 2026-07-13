import { describe, expect, it, vi } from "vitest";
import { recordContributorGateDecision } from "../../src/review/contributor-calibration";
import { createTestEnv } from "../helpers/d1";

// ── Direct D1 helpers over the real migrated schema (0126 contributor_gate_history) ─────────────────────────

async function rawAll(env: Env, sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { all: <T>() => Promise<{ results: T[] }> } } })
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();
  return res.results;
}

describe("recordContributorGateDecision — write-only per-contributor gate history (0126 round-trip, #2349 PR 1)", () => {
  it("SELF-HOSTED instances record ONE row keyed by login (createTestEnv's default self-host signal)", async () => {
    const env = createTestEnv(); // flag unset → OFF, but SELFHOST_TRANSIENT_CACHE present → self-hosted
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo", pullNumber: 7, headSha: "abc123", decision: "merge" });

    const rows = await rawAll(env, "SELECT * FROM contributor_gate_history");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      login: "octocat",
      source: "gittensory-native",
      project: "owner/repo",
      target_id: "owner/repo#7",
      decision: "merge",
      head_sha: "abc123",
    });
    expect(typeof rows[0]!.created_at).toBe("string");
  });

  it("a re-run at the SAME (login, source, project, pr, sha) REPLACES the prior row (no duplicate)", async () => {
    const env = createTestEnv();
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo", pullNumber: 7, headSha: "abc123", decision: "merge" });
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo", pullNumber: 7, headSha: "abc123", decision: "hold" });

    const rows = await rawAll(env, "SELECT * FROM contributor_gate_history");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ decision: "hold" });
  });

  it("a new commit gets its OWN row", async () => {
    const env = createTestEnv();
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo", pullNumber: 7, headSha: "sha1", decision: "merge" });
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo", pullNumber: 7, headSha: "sha2", decision: "close" });
    expect((await rawAll(env, "SELECT * FROM contributor_gate_history")).length).toBe(2);
  });

  it("a different login on the SAME PR/commit gets its own row (keyed by login too)", async () => {
    const env = createTestEnv();
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo", pullNumber: 7, headSha: "abc123", decision: "merge" });
    await recordContributorGateDecision(env, { login: "hubot", project: "owner/repo", pullNumber: 7, headSha: "abc123", decision: "merge" });
    expect((await rawAll(env, "SELECT * FROM contributor_gate_history")).length).toBe(2);
  });

  it("does NOT record when the login is missing, null, or blank (no meaningful per-actor row to write)", async () => {
    const env = createTestEnv();
    await recordContributorGateDecision(env, { login: undefined, project: "owner/repo", pullNumber: 1, headSha: "sha", decision: "merge" });
    await recordContributorGateDecision(env, { login: null, project: "owner/repo", pullNumber: 2, headSha: "sha", decision: "merge" });
    await recordContributorGateDecision(env, { login: "   ", project: "owner/repo", pullNumber: 3, headSha: "sha", decision: "merge" });
    expect((await rawAll(env, "SELECT * FROM contributor_gate_history")).length).toBe(0);
  });

  it("records even with a null head_sha (unlike recordNativeGateDecision, this has no parity self-join to protect)", async () => {
    const env = createTestEnv();
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo", pullNumber: 4, headSha: null, decision: "close" });
    const rows = await rawAll(env, "SELECT * FROM contributor_gate_history");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ head_sha: null, decision: "close" });
  });

  it("flag-OFF records NOTHING on the CLOUD WORKER — no D1 write (byte-identical, same gate as recordNativeGateDecision)", async () => {
    const env = createTestEnv();
    delete env.SELFHOST_TRANSIENT_CACHE; // simulate the cloud worker (no self-host binding)
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo", pullNumber: 7, headSha: "abc123", decision: "merge" });
    expect((await rawAll(env, "SELECT * FROM contributor_gate_history")).length).toBe(0);

    const envFalse = createTestEnv({ LOOPOVER_REVIEW_PARITY_AUDIT: "false" });
    delete envFalse.SELFHOST_TRANSIENT_CACHE;
    await recordContributorGateDecision(envFalse, { login: "octocat", project: "owner/repo", pullNumber: 7, headSha: "abc123", decision: "close" });
    expect((await rawAll(envFalse, "SELECT * FROM contributor_gate_history")).length).toBe(0);
  });

  it("the cloud worker records when LOOPOVER_REVIEW_PARITY_AUDIT is explicitly ON", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_PARITY_AUDIT: "true" });
    delete env.SELFHOST_TRANSIENT_CACHE;
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo", pullNumber: 7, headSha: "abc123", decision: "merge" });
    expect((await rawAll(env, "SELECT * FROM contributor_gate_history")).length).toBe(1);
  });

  it("fails safe: a D1 write error is swallowed + logged (telemetry never breaks finalization)", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/contributor_gate_history/i.test(sql)) throw new Error("poisoned write");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      recordContributorGateDecision(env, { login: "octocat", project: "owner/repo", pullNumber: 7, headSha: "abc123", decision: "merge" }),
    ).resolves.toBeUndefined();

    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("contributor_gate_history_record_error"))).toBe(true);
    warn.mockRestore();
  });
});
