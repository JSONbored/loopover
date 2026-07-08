// Postgres-backed D1Database for the self-host Postgres backend (#977). Implements the same D1 surface the
// app + drizzle-orm/d1 use (prepare/bind/all/first/run/raw + batch + exec), translating each SQLite query to
// Postgres (pg-dialect.ts) and running it via node-postgres. A shared Postgres DB makes multi-instance
// self-host possible (vs the single-file SQLite default).
//
// `PgStatement` implements the shared `SelfHostD1PreparedStatement` contract (backend-contracts.ts, #4010) --
// the same one d1-adapter.ts's `Statement` implements -- and `createPgAdapter`'s own return value is typed
// `SelfHostD1Database` before the final `as unknown as D1Database` cast (unavoidable: D1Database is a
// `declare abstract class`, so only that cast can bridge a plain object to it).
import type { Pool, PoolClient } from "pg";
import type { SelfHostD1Database, SelfHostD1PreparedStatement } from "./backend-contracts";
import { translateDdl, translateSql } from "./pg-dialect";

type Row = Record<string, unknown>;
type Runner = Pool | PoolClient;

class PgStatement implements SelfHostD1PreparedStatement {
  constructor(
    private readonly pool: Pool,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): PgStatement {
    return new PgStatement(this.pool, this.sql, params);
  }

  private async exec(runner: Runner = this.pool): Promise<{ rows: Row[]; rowCount: number }> {
    const res = await runner.query(translateSql(this.sql), this.params as unknown[]);
    return { rows: res.rows as Row[], rowCount: res.rowCount ?? 0 };
  }

  async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const { rows, rowCount } = await this.exec();
    return { results: rows as T[], success: true, meta: { rows_read: rowCount, changes: rowCount } };
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const { rows } = await this.exec();
    const row = rows[0];
    if (!row) return null;
    return (colName ? row[colName] : row) as T;
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    const { rowCount } = await this.exec();
    return { success: true, meta: { changes: rowCount, last_row_id: 0, rows_written: rowCount } };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const { rows } = await this.exec();
    return rows.map((r) => Object.values(r)) as T[];
  }

  /** Run this statement on a specific client (used by batch's transaction). */
  async runOn(client: PoolClient): Promise<{ results: Row[]; success: true; meta: Record<string, unknown> }> {
    const { rows, rowCount } = await this.exec(client);
    return { results: rows, success: true, meta: { changes: rowCount } };
  }
}

export function createPgAdapter(pool: Pool): D1Database {
  const adapter: SelfHostD1Database = {
    prepare: (sql: string) => new PgStatement(pool, sql),
    async batch(statements: PgStatement[]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out: Array<{ results: Row[]; success: true; meta: Record<string, unknown> }> = [];
        for (const st of statements) out.push(await st.runOn(client));
        await client.query("COMMIT");
        return out;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async exec(sql: string) {
      // Migrations: no placeholders; translate the DDL functions and run (node-postgres runs the multi-statement
      // string in one simple query).
      await pool.query(translateDdl(sql));
      return { count: (sql.match(/;/g) ?? []).length || 1, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0); // unused; present for D1 surface completeness
    },
  };
  return adapter as unknown as D1Database;
}

// #2543: github_rate_limit_observations receives one INSERT per outbound GitHub API response and is pruned in
// daily bulk deletes by the retention job (pruneExpiredRecords) -- an insert-then-bulk-delete pattern that is
// exactly the shape that causes dead-tuple bloat under Postgres's stock autovacuum settings (scale_factor 0.2,
// i.e. autovacuum waits for 20% of the table to be dead before vacuuming -- fine for a slowly-growing table,
// too lax for one that gets emptied in one daily burst). Lowering the scale factor makes autovacuum reclaim
// space promptly after each day's bulk delete instead of letting dead tuples accumulate across cycles. A
// storage-parameter ALTER is idempotent (re-applying the same value is a no-op), so this runs unconditionally
// on every Postgres boot rather than needing its own migration-ledger tracking. SQLite has no autovacuum
// concept at all, so this must never run there -- callers gate it behind the Postgres backend check, matching
// PGPOOL_MAX/resolvePostgresPoolMax's own "server.ts wiring, tested logic elsewhere" split (src/selfhost/
// queue-common.ts), since server.ts itself has no test harness (top-level main(), Codecov-ignored).
export const GITHUB_RATE_LIMIT_OBSERVATIONS_AUTOVACUUM_SQL =
  "ALTER TABLE github_rate_limit_observations SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 50)";

/** Apply the autovacuum tuning above via the SAME D1Database.exec() surface runSelfHostMigrations already uses
 *  for migrations -- so this reuses translateDdl's existing SQL path rather than a second raw-pool query
 *  mechanism. Must be called AFTER migrations (the table has to exist first); best-effort by design (a
 *  storage-parameter tweak is an optimization, never a correctness dependency -- a failure here must not stop
 *  the self-host from booting). */
export async function tuneGithubRateLimitObservationsAutovacuum(db: D1Database): Promise<void> {
  await db.exec(GITHUB_RATE_LIMIT_OBSERVATIONS_AUTOVACUUM_SQL).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "selfhost_autovacuum_tune_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}
