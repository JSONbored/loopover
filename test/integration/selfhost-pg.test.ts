// Real-Postgres integration test for the self-host PG backend (#977). Skipped unless PG_TEST_URL is set, so
// CI (no Postgres) skips it; run locally against a real PG:
//   docker run -d -e POSTGRES_PASSWORD=devpw -e POSTGRES_DB=loopover -p 55432:5432 postgres:16
//   PG_TEST_URL=postgres://postgres:devpw@localhost:55432/loopover npx vitest run test/integration/selfhost-pg.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runSelfHostMigrations } from "../../src/selfhost/migrate";
import { createPgAdapter, tuneGithubRateLimitObservationsAutovacuum } from "../../src/selfhost/pg-adapter";
import { pruneExpiredRecords } from "../../src/db/retention";
import { processJob } from "../../src/queue/processors";
import { getGateBlockOutcome, markGateOutcomeOverridden, recordGateBlockOutcome } from "../../src/db/repositories";
import { backfillContributorGateHistory } from "../../src/review/contributor-gate-history-backfill";
import { computeContributorGateEval } from "../../src/review/contributor-gate-eval";
import { computeGateEval, computeGateParity } from "../../src/review/parity";

const URL = process.env.PG_TEST_URL;
const suite = URL ? describe : describe.skip;

suite("Postgres backend (#977) — real Postgres", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10)); // int8 (COUNT) → number, like D1
    pool = new pg.Pool({ connectionString: URL });
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("applies every migration, idempotently", async () => {
    const db = createPgAdapter(pool);
    const n = await runSelfHostMigrations(db, "migrations");
    expect(n).toBeGreaterThan(50);
    expect(await runSelfHostMigrations(db, "migrations")).toBe(0); // idempotent
  });

  it("runs the translated query paths (INSERT OR REPLACE, datetime, json, COUNT→number)", async () => {
    const db = createPgAdapter(pool);
    // INSERT OR REPLACE → ON CONFLICT upsert (run twice; second must not error)
    await db.prepare("INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES (?, '1', CURRENT_TIMESTAMP)").bind("rag_enabled").run();
    await db.prepare("INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES (?, '0', CURRENT_TIMESTAMP)").bind("rag_enabled").run();
    const flag = await db.prepare("SELECT value FROM system_flags WHERE key=?").bind("rag_enabled").first<{ value: string }>();
    expect(flag?.value).toBe("0"); // upserted

    // datetime('now', ?) compared against a TEXT timestamp column; COUNT(*) must come back as a number
    const row = await db.prepare("SELECT COUNT(*) AS n FROM system_flags WHERE updated_at > datetime('now', ?)").bind("-30 days").first<{ n: number }>();
    expect(typeof row?.n).toBe("number");
    expect(row?.n).toBeGreaterThanOrEqual(1);
  });

  it("REGRESSION: backfillContributorGateHistory's instr()/substr() target_id parsing works against real Postgres (Postgres has no `instr` builtin -- SELECT instr(...) is a hard 'function instr(...) does not exist' error, previously swallowed silently by every fail-safe read path using it)", async () => {
    const db = createPgAdapter(pool);
    await db.prepare(`INSERT INTO pull_requests (id, repo_full_name, number, title, state, author_login) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind("pr-instr-1", "owner/instr-repo", 42, "pg instr regression", "open", "octocat")
      .run();
    await db.prepare(`INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES (?, ?, ?, 'gate_decision', 'merge', 'gittensory-native', ?)`)
      .bind("gd-instr-1", "owner/instr-repo", "owner/instr-repo#42", new Date().toISOString())
      .run();

    const result = await backfillContributorGateHistory({ DB: db } as unknown as Env);
    expect(result).toEqual({ scanned: 1, inserted: 1, skippedNoAuthor: 0, hasMore: false });

    const row = await db.prepare(`SELECT login, project, target_id FROM contributor_gate_history WHERE target_id = ?`).bind("owner/instr-repo#42").first<{ login: string; project: string; target_id: string }>();
    expect(row).toEqual({ login: "octocat", project: "owner/instr-repo", target_id: "owner/instr-repo#42" });
  });

  it("REGRESSION: computeContributorGateEval's ROW_NUMBER()-based 'latest row per key' query runs against real Postgres and picks the CORRECT latest decision (SQLite's bare-column-with-MAX() trick this replaced is not just non-portable -- it can pick an arbitrary row's project/decision within a tied group, not necessarily the max-created_at row's own)", async () => {
    const db = createPgAdapter(pool);
    const env = { DB: db } as unknown as Env;

    // A contributor's PR gets re-reviewed after a force-push: the EARLIER headSha was predicted "close",
    // the LATER (higher created_at) headSha was predicted "merge". Only the latest should count.
    await db.prepare(`INSERT INTO contributor_gate_history (id, login, source, project, target_id, decision, head_sha, created_at) VALUES (?, 'pg-latest-row', 'gittensory-native', 'owner/latest-row', 'owner/latest-row#7', 'close', 'sha-old', ?)`)
      .bind("cgh-latest-1", "2026-01-01T00:00:00.000Z")
      .run();
    await db.prepare(`INSERT INTO contributor_gate_history (id, login, source, project, target_id, decision, head_sha, created_at) VALUES (?, 'pg-latest-row', 'gittensory-native', 'owner/latest-row', 'owner/latest-row#7', 'merge', 'sha-new', ?)`)
      .bind("cgh-latest-2", "2026-01-02T00:00:00.000Z")
      .run();
    await db.prepare(`INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES (?, 'owner/latest-row', 'owner/latest-row#7', 'pr_outcome', 'merged', 'github', ?)`)
      .bind("po-latest-1", "2026-01-03T00:00:00.000Z")
      .run();

    const report = await computeContributorGateEval(env, { days: 730, nowMs: Date.parse("2026-01-10T00:00:00.000Z"), login: "pg-latest-row" });
    expect(report.rows).toEqual([
      expect.objectContaining({ login: "pg-latest-row", project: "owner/latest-row", wouldMerge: 1, mergeConfirmed: 1, wouldClose: 0 }),
    ]);
  });

  it("REGRESSION: computeGateEval's identical ROW_NUMBER()-based query (parity.ts) runs against real Postgres and picks the latest gate_decision/pr_outcome per target", async () => {
    const db = createPgAdapter(pool);
    const env = { DB: db } as unknown as Env;

    await db.prepare(`INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES (?, 'owner/gate-eval-pg', 'owner/gate-eval-pg#1', 'gate_decision', 'close', 'gittensory-native', ?)`)
      .bind("gd-eval-old", "2026-01-01T00:00:00.000Z")
      .run();
    await db.prepare(`INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES (?, 'owner/gate-eval-pg', 'owner/gate-eval-pg#1', 'gate_decision', 'merge', 'gittensory-native', ?)`)
      .bind("gd-eval-new", "2026-01-02T00:00:00.000Z")
      .run();
    await db.prepare(`INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES (?, 'owner/gate-eval-pg', 'owner/gate-eval-pg#1', 'pr_outcome', 'merged', 'github', ?)`)
      .bind("po-eval-1", "2026-01-03T00:00:00.000Z")
      .run();

    const report = await computeGateEval(env, { days: 730, nowMs: Date.parse("2026-01-10T00:00:00.000Z") });
    expect(report.rows).toEqual([expect.objectContaining({ project: "owner/gate-eval-pg", wouldMerge: 1, mergeConfirmed: 1, wouldClose: 0 })]);
  });

  it("REGRESSION: computeGateParity's identical ROW_NUMBER()-based self-join (parity.ts) runs against real Postgres and picks the latest per-source decision per commit", async () => {
    const db = createPgAdapter(pool);
    const env = { DB: db } as unknown as Env;

    const insertGd = (id: string, source: string, decision: string, createdAt: string) =>
      db.prepare(`INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, created_at) VALUES (?, 'owner/gate-parity-pg', 'owner/gate-parity-pg#1', 'gate_decision', ?, ?, 'sha-1', ?)`)
        .bind(id, decision, source, createdAt)
        .run();
    // authoritative source re-decided at a later created_at (same head_sha) -- only the latest should count.
    await insertGd("gd-parity-auth-old", "reviewbot", "close", "2026-01-01T00:00:00.000Z");
    await insertGd("gd-parity-auth-new", "reviewbot", "merge", "2026-01-02T00:00:00.000Z");
    await insertGd("gd-parity-shadow", "loopover", "merge", "2026-01-01T12:00:00.000Z");

    const report = await computeGateParity(env, { days: 730, nowMs: Date.parse("2026-01-10T00:00:00.000Z") });
    expect(report.rows).toEqual([expect.objectContaining({ project: "owner/gate-parity-pg", pairedSamples: 1, bothMerge: 1 })]);
  });

  it("batch is transactional (rolls back on error)", async () => {
    const db = createPgAdapter(pool);
    await db.prepare("INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES (?, 'x', CURRENT_TIMESTAMP)").bind("batch_probe").run();
    await expect(
      db.batch([
        db.prepare("DELETE FROM system_flags WHERE key=?").bind("batch_probe"),
        db.prepare("INSERT INTO system_flags (key, value) VALUES (?, ?) , bad-sql").bind("z", "1"), // syntax error → rollback
      ]),
    ).rejects.toThrow();
    const still = await db.prepare("SELECT COUNT(*) AS n FROM system_flags WHERE key=?").bind("batch_probe").first<{ n: number }>();
    expect(still?.n).toBe(1); // the DELETE rolled back
  });

  it("regression: a rollback failure never masks the original batch error (#6282)", async () => {
    // Force the ROLLBACK itself to throw, simulating the exact scenario (a connection failure) where the
    // original error and a subsequent rollback failure would otherwise race to be the thrown error. Only
    // ROLLBACK is intercepted -- every other query still runs for real against the live Postgres instance.
    const realClient = await pool.connect();
    const originalQuery = realClient.query.bind(realClient);
    let rollbackAttempted = false;
    try {
      // @ts-expect-error -- intentionally narrowing pg's overloaded query() signature for this simulation
      realClient.query = async (...args: Parameters<typeof originalQuery>) => {
        if (args[0] === "ROLLBACK") {
          rollbackAttempted = true;
          throw new Error("simulated rollback failure");
        }
        return originalQuery(...args);
      };
      const fakePool = { connect: async () => realClient } as unknown as pg.Pool;
      const db = createPgAdapter(fakePool);

      await expect(
        db.batch([
          db.prepare("INSERT INTO system_flags (key, value) VALUES (?, ?) , bad-sql").bind("z", "1"), // syntax error
        ]),
      ).rejects.toThrow(/bad-sql|syntax/i); // the ORIGINAL error surfaces, not "simulated rollback failure"
      expect(rollbackAttempted).toBe(true);
    } finally {
      // batch()'s own `finally` already released this client back to the pool -- just restore the
      // query override so the shared pool's client isn't left poisoned for later tests.
      realClient.query = originalQuery;
    }
  });

  it("prunes rows past the retention window and processJob('prune-retention') does not dead-letter (regression for the live self-host incident: job _selfhost_jobs.id=61132 failed with 'column \"rowid\" does not exist')", async () => {
    const db = createPgAdapter(pool);
    const env = { DB: db } as unknown as Env;
    const oldIso = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const recentIso = new Date(Date.now() - 1 * 86_400_000).toISOString();
    for (const [id, createdAt] of [
      ["pg-old-1", oldIso],
      ["pg-old-2", oldIso],
      ["pg-recent", recentIso],
    ] as const) {
      await db
        .prepare("INSERT INTO ai_usage_events (id, feature, model, status, estimated_neurons, created_at) VALUES (?, 'f', 'm', 'ok', 1, ?)")
        .bind(id, createdAt)
        .run();
    }

    const results = await pruneExpiredRecords(env, { policy: [{ table: "ai_usage_events", column: "created_at", days: 90 }] });
    expect(results[0]?.deleted).toBe(2); // the two old rows, bounded-batch deleted via ctid (not rowid)
    const remaining = await db.prepare("SELECT COUNT(*) AS n FROM ai_usage_events").first<{ n: number }>();
    expect(remaining?.n).toBe(1);

    // The exact live incident: the job queue's processJob("prune-retention") dispatch must not throw.
    await expect(processJob(env, { type: "prune-retention", requestedBy: "schedule" })).resolves.toBeUndefined();
    const audit = await db.prepare("SELECT outcome FROM audit_events WHERE event_type = ?").bind("retention.prune").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("success");
  });

  it("recordGateBlockOutcome upserts on Postgres and preserves/clears `overridden` null-safely (regression: the SQLite-only `head_sha IS <value>` operator was a hard Postgres parse error, so the swallowed upsert silently dropped every gate_outcomes row and the draft-dodge enforcement it drives)", async () => {
    const db = createPgAdapter(pool);
    const env = { DB: db } as unknown as Env;

    // (1) Core regression: the ON CONFLICT upsert must not throw on Postgres. Before the fix its `overridden`
    // clause emitted `head_sha IS $1`, which Postgres rejects at parse time, so this INSERT threw and — via the
    // caller's best-effort `.catch(() => undefined)` — no gate_outcomes row was ever persisted on this backend.
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 42, headSha: "sha-a", blockerCodes: ["slop_risk"] });
    expect(await getGateBlockOutcome(env, "owner/repo", 42)).toMatchObject({ headSha: "sha-a", overridden: false, blockerCodes: ["slop_risk"] });

    // (2) A re-block on the SAME head preserves a maintainer override (the `=` branch of the null-safe compare).
    await markGateOutcomeOverridden(env, "owner/repo", 42);
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 42, headSha: "sha-a", blockerCodes: ["slop_risk", "missing_linked_issue"] });
    expect(await getGateBlockOutcome(env, "owner/repo", 42)).toMatchObject({ overridden: true, blockerCodes: ["slop_risk", "missing_linked_issue"] });

    // (3) A re-block on a NEW head clears the override — it binds to the exact commit it was granted on (#audit-3.14).
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 42, headSha: "sha-b", blockerCodes: ["slop_risk"] });
    expect(await getGateBlockOutcome(env, "owner/repo", 42)).toMatchObject({ headSha: "sha-b", overridden: false });

    // (4) Null-safe branch: two blocks that both record NO head SHA still match, preserving the override.
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 43, blockerCodes: ["x"] });
    await markGateOutcomeOverridden(env, "owner/repo", 43);
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 43, blockerCodes: ["x", "y"] });
    expect(await getGateBlockOutcome(env, "owner/repo", 43)).toMatchObject({ overridden: true });
  });

  it("tunes github_rate_limit_observations autovacuum below Postgres's default, idempotently (#2543)", async () => {
    const db = createPgAdapter(pool);

    await tuneGithubRateLimitObservationsAutovacuum(db);
    await tuneGithubRateLimitObservationsAutovacuum(db); // idempotent -- a second apply must not throw

    const row = await pool.query<{ reloptions: string[] | null }>(
      "SELECT reloptions FROM pg_class WHERE relname = 'github_rate_limit_observations'",
    );
    const options = row.rows[0]?.reloptions ?? [];
    expect(options).toContain("autovacuum_vacuum_scale_factor=0.05");
    expect(options).toContain("autovacuum_vacuum_threshold=50");
  });
});
