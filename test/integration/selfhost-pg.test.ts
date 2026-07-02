// Real-Postgres integration test for the self-host PG backend (#977). Skipped unless PG_TEST_URL is set, so
// CI (no Postgres) skips it; run locally against a real PG:
//   docker run -d -e POSTGRES_PASSWORD=devpw -e POSTGRES_DB=gittensory -p 55432:5432 postgres:16
//   PG_TEST_URL=postgres://postgres:devpw@localhost:55432/gittensory npx vitest run test/integration/selfhost-pg.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runSelfHostMigrations } from "../../src/selfhost/migrate";
import { createPgAdapter } from "../../src/selfhost/pg-adapter";
import { pruneExpiredRecords } from "../../src/db/retention";
import { processJob } from "../../src/queue/processors";

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
});
