import { describe, expect, it, vi } from "vitest";
import { backfillContributorGateHistory } from "../../src/review/contributor-gate-history-backfill";
import { recordContributorGateDecision } from "../../src/review/contributor-calibration";
import { createTestEnv } from "../helpers/d1";

async function rawAll(env: Env, sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { all: <T>() => Promise<{ results: T[] }> } } })
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();
  return res.results;
}

async function insertGateDecision(env: Env, opts: { project: string; targetId: string; decision: string; headSha?: string | null; source?: string; createdAt?: string }): Promise<void> {
  await env.DB.prepare(`INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, created_at) VALUES (?, ?, ?, 'gate_decision', ?, ?, ?, ?)`)
    .bind(`gd:${opts.targetId}:${opts.headSha ?? "none"}`, opts.project, opts.targetId, opts.decision, opts.source ?? "gittensory-native", opts.headSha ?? null, opts.createdAt ?? new Date().toISOString())
    .run();
}

async function insertPullRequest(env: Env, repoFullName: string, number: number, authorLogin: string | null): Promise<void> {
  await env.DB.prepare(`INSERT INTO pull_requests (id, repo_full_name, number, title, state, author_login) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(`pr-${repoFullName}-${number}`, repoFullName, number, "some pr", "open", authorLogin)
    .run();
}

describe("backfillContributorGateHistory (#fairness-analytics)", () => {
  it("reconstructs a missing contributor_gate_history row from review_audit + pull_requests.author_login", async () => {
    const env = createTestEnv();
    await insertPullRequest(env, "owner/repo", 7, "octocat");
    await insertGateDecision(env, { project: "owner/repo", targetId: "owner/repo#7", decision: "merge", headSha: "sha1" });

    const result = await backfillContributorGateHistory(env);

    expect(result).toEqual({ scanned: 1, inserted: 1, skippedNoAuthor: 0, hasMore: false });
    const rows = await rawAll(env, "SELECT * FROM contributor_gate_history");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ login: "octocat", project: "owner/repo", target_id: "owner/repo#7", decision: "merge", head_sha: "sha1", source: "gittensory-native" });
  });

  it("REGRESSION: stamps the reconstructed row with the ORIGINAL review_audit created_at, not the time the backfill ran", async () => {
    const env = createTestEnv();
    await insertPullRequest(env, "owner/repo", 40, "octocat");
    const originalCreatedAt = "2026-06-25T12:00:00.000Z"; // well before "now" (mocked D1 helper uses real Date)
    await insertGateDecision(env, { project: "owner/repo", targetId: "owner/repo#40", decision: "merge", headSha: "sha40", createdAt: originalCreatedAt });

    const before = Date.now();
    const result = await backfillContributorGateHistory(env);
    expect(result).toEqual({ scanned: 1, inserted: 1, skippedNoAuthor: 0, hasMore: false });

    const rows = await rawAll(env, "SELECT * FROM contributor_gate_history");
    expect(rows[0]!.created_at).toBe(originalCreatedAt);
    // Sanity: the original timestamp really is far in the past relative to "now", so this assertion couldn't
    // pass by coincidence if the bug (binding nowIso() instead) were reintroduced.
    expect(Date.parse(originalCreatedAt)).toBeLessThan(before - 1000);
  });

  it("backfills a candidate with a null head_sha (unlike recordContributorGateDecision, no parity self-join to protect)", async () => {
    const env = createTestEnv();
    await insertPullRequest(env, "owner/repo", 30, "octocat");
    await insertGateDecision(env, { project: "owner/repo", targetId: "owner/repo#30", decision: "close", headSha: null });

    const result = await backfillContributorGateHistory(env);
    expect(result).toEqual({ scanned: 1, inserted: 1, skippedNoAuthor: 0, hasMore: false });
    const rows = await rawAll(env, "SELECT * FROM contributor_gate_history");
    expect(rows[0]).toMatchObject({ head_sha: null, decision: "close" });
  });

  it("skips a candidate whose PR has no author_login", async () => {
    const env = createTestEnv();
    await insertPullRequest(env, "owner/repo", 8, null);
    await insertGateDecision(env, { project: "owner/repo", targetId: "owner/repo#8", decision: "close" });

    const result = await backfillContributorGateHistory(env);
    expect(result).toEqual({ scanned: 1, inserted: 0, skippedNoAuthor: 1, hasMore: false });
  });

  it("skips a candidate whose PR was never synced at all (no matching pull_requests row)", async () => {
    const env = createTestEnv();
    await insertGateDecision(env, { project: "owner/repo", targetId: "owner/repo#9", decision: "merge" });

    const result = await backfillContributorGateHistory(env);
    expect(result).toEqual({ scanned: 1, inserted: 0, skippedNoAuthor: 1, hasMore: false });
  });

  it("is idempotent: a decision the LIVE write path already recorded is never re-backfilled", async () => {
    const env = createTestEnv();
    await insertPullRequest(env, "owner/repo", 10, "octocat");
    await insertGateDecision(env, { project: "owner/repo", targetId: "owner/repo#10", decision: "merge", headSha: "sha10" });
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo", pullNumber: 10, headSha: "sha10", decision: "merge" });

    const result = await backfillContributorGateHistory(env);
    expect(result).toEqual({ scanned: 0, inserted: 0, skippedNoAuthor: 0, hasMore: false });
    expect(await rawAll(env, "SELECT * FROM contributor_gate_history")).toHaveLength(1); // still just the live-recorded row
  });

  it("is idempotent: running the backfill twice never double-inserts", async () => {
    const env = createTestEnv();
    await insertPullRequest(env, "owner/repo", 11, "octocat");
    await insertGateDecision(env, { project: "owner/repo", targetId: "owner/repo#11", decision: "merge", headSha: "sha11" });

    await backfillContributorGateHistory(env);
    const second = await backfillContributorGateHistory(env);
    expect(second).toEqual({ scanned: 0, inserted: 0, skippedNoAuthor: 0, hasMore: false });
    expect(await rawAll(env, "SELECT * FROM contributor_gate_history")).toHaveLength(1);
  });

  it("sets hasMore true and processes exactly `limit` rows when more candidates remain", async () => {
    const env = createTestEnv();
    for (let i = 0; i < 3; i++) {
      await insertPullRequest(env, "owner/repo", i, "octocat");
      await insertGateDecision(env, { project: "owner/repo", targetId: `owner/repo#${i}`, decision: "merge", headSha: `sha${i}` });
    }

    const result = await backfillContributorGateHistory(env, { limit: 2 });
    expect(result.scanned).toBe(2);
    expect(result.inserted).toBe(2);
    expect(result.hasMore).toBe(true);

    const second = await backfillContributorGateHistory(env, { limit: 2 });
    expect(second).toEqual({ scanned: 1, inserted: 1, skippedNoAuthor: 0, hasMore: false });
  });

  it("clamps a non-positive/non-finite limit to the default, and an over-large limit to the max", async () => {
    const env = createTestEnv();
    const capture: { binds?: unknown[] } = {};
    const cap = (): Env =>
      ({ DB: { prepare: () => ({ bind: (...a: unknown[]) => { capture.binds = a; return { all: async () => ({ results: [] }) }; } }) } }) as unknown as Env;

    await backfillContributorGateHistory(cap(), { limit: -5 });
    expect(capture.binds?.[0]).toBe(501); // DEFAULT_BATCH_LIMIT(500) + 1

    await backfillContributorGateHistory(cap(), { limit: Number.NaN });
    expect(capture.binds?.[0]).toBe(501);

    await backfillContributorGateHistory(cap(), { limit: 999_999 });
    expect(capture.binds?.[0]).toBe(5001); // MAX_BATCH_LIMIT(5000) + 1

    // unused real env import guard -- keeps createTestEnv imported for the other real-D1 cases in this file
    expect(env).toBeTruthy();
  });

  it("is fail-safe: a throwing D1 read degrades to an all-zero result, not an error", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("d1 down"); } }) }) } } as unknown as Env;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await backfillContributorGateHistory(env);
    expect(result).toEqual({ scanned: 0, inserted: 0, skippedNoAuthor: 0, hasMore: false });
    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("contributor_gate_history_backfill_read_error"))).toBe(true);
    warn.mockRestore();
  });

  it("REGRESSION: does not count an ON CONFLICT DO NOTHING no-op toward inserted", async () => {
    const candidate = {
      project: "owner/repo",
      targetId: "owner/repo#50",
      decision: "merge",
      headSha: "sha50",
      source: "gittensory-native",
      authorLogin: "octocat",
      createdAt: "2026-06-25T12:00:00.000Z",
    };
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (..._args: unknown[]) => {
            if (/FROM review_audit/.test(sql)) {
              return { all: async () => ({ results: [candidate] }) };
            }
            if (/INSERT INTO contributor_gate_history/.test(sql)) {
              return { run: async () => ({ meta: { changes: 0 } }) };
            }
            throw new Error(`unexpected sql: ${sql}`);
          },
        }),
      },
    } as unknown as Env;

    const result = await backfillContributorGateHistory(env);
    expect(result).toEqual({ scanned: 1, inserted: 0, skippedNoAuthor: 0, hasMore: false });
  });

  it("is best-effort per row: a write failure on one candidate is logged and does not stop the rest of the batch", async () => {
    const env = createTestEnv();
    await insertPullRequest(env, "owner/repo", 20, "octocat");
    await insertGateDecision(env, { project: "owner/repo", targetId: "owner/repo#20", decision: "merge", headSha: "sha20" });
    await insertPullRequest(env, "owner/repo", 21, "hubot");
    await insertGateDecision(env, { project: "owner/repo", targetId: "owner/repo#21", decision: "close", headSha: "sha21" });

    const realPrepare = env.DB.prepare.bind(env.DB);
    let insertCount = 0;
    env.DB.prepare = ((sql: string) => {
      if (/INSERT INTO contributor_gate_history/.test(sql)) {
        insertCount += 1;
        if (insertCount === 1) throw new Error("poisoned write");
      }
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await backfillContributorGateHistory(env);
    expect(result.scanned).toBe(2);
    expect(result.inserted).toBe(1); // the second row still made it in
    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("contributor_gate_history_backfill_write_error"))).toBe(true);
    warn.mockRestore();
  });

  it("defaults to [] when the driver returns no `results` field (nullish fallback)", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({}) }) }) } } as unknown as Env;
    const result = await backfillContributorGateHistory(env);
    expect(result).toEqual({ scanned: 0, inserted: 0, skippedNoAuthor: 0, hasMore: false });
  });
});
