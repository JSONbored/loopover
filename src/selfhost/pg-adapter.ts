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

// #selfhost-github-id-overflow: every migrations/*.sql column below stores a raw GitHub-native numeric ID
// (installation id, account/user id, check-run id, or comment id) as bare `INTEGER` -- correct on SQLite/D1,
// where INTEGER is only a type-affinity hint and already stores any 64-bit value without truncation, but a
// real, enforced 4-byte column on Postgres. GitHub's own ids are a single global counter shared across all of
// GitHub (not scoped per-repo the way issue/PR *numbers* are), and comment ids in particular are already well
// past 2^31 (~2.1B) as of 2026 -- confirmed live via a `value "…" is out of range for type integer` failure on
// github_agent_command_answers.request_comment_id/response_comment_id. installation/account/user ids are
// nowhere near that threshold yet, but are widened here too rather than waiting for their own future incident
// -- bigint costs nothing extra at this table size. Same idempotent-ALTER, no-migration-ledger shape as
// GITHUB_RATE_LIMIT_OBSERVATIONS_AUTOVACUUM_SQL above: re-applying to an already-bigint column is a no-op, so
// this runs unconditionally on every Postgres boot. The original migrations are left untouched (already
// applied/ledger-tracked everywhere, and correct as written for SQLite/D1) -- this is a purely additive,
// Postgres-only follow-up, not a rewrite of history. New migrations introducing a GitHub-native id column
// going forward should declare it BIGINT directly instead of adding another line here.
export const GITHUB_ID_BIGINT_WIDENING_SQL = [
  "ALTER TABLE installations ALTER COLUMN id TYPE bigint",
  "ALTER TABLE installations ALTER COLUMN account_id TYPE bigint",
  "ALTER TABLE installations ALTER COLUMN app_id TYPE bigint",
  "ALTER TABLE repositories ALTER COLUMN installation_id TYPE bigint",
  "ALTER TABLE advisories ALTER COLUMN check_run_id TYPE bigint",
  "ALTER TABLE webhook_events ALTER COLUMN installation_id TYPE bigint",
  "ALTER TABLE installation_health ALTER COLUMN installation_id TYPE bigint",
  "ALTER TABLE auth_sessions ALTER COLUMN github_user_id TYPE bigint",
  "ALTER TABLE github_agent_command_answers ALTER COLUMN request_comment_id TYPE bigint",
  "ALTER TABLE github_agent_command_answers ALTER COLUMN response_comment_id TYPE bigint",
  "ALTER TABLE agent_pending_actions ALTER COLUMN installation_id TYPE bigint",
  "ALTER TABLE review_targets ALTER COLUMN installation_id TYPE bigint",
  "ALTER TABLE orb_webhook_events ALTER COLUMN installation_id TYPE bigint",
  "ALTER TABLE orb_github_installations ALTER COLUMN installation_id TYPE bigint",
  "ALTER TABLE orb_github_installations ALTER COLUMN account_id TYPE bigint",
  "ALTER TABLE orb_pr_outcomes ALTER COLUMN installation_id TYPE bigint",
  "ALTER TABLE orb_enrollments ALTER COLUMN installation_id TYPE bigint",
  "ALTER TABLE orb_enrollments ALTER COLUMN maintainer_github_id TYPE bigint",
  "ALTER TABLE orb_relay_failures ALTER COLUMN installation_id TYPE bigint",
  "ALTER TABLE orb_relay_pending ALTER COLUMN installation_id TYPE bigint",
].join(";\n");

/** Apply the bigint widening above via the same D1Database.exec() surface runSelfHostMigrations already uses,
 *  mirroring tuneGithubRateLimitObservationsAutovacuum's shape exactly. Must run AFTER migrations (every table
 *  above has to exist by then, so a mid-batch "relation does not exist" is not a realistic failure mode here);
 *  best-effort by design -- a failure here must not stop the self-host from booting. Postgres's simple-query
 *  protocol runs this whole multi-statement string as one implicit transaction, so either every ALTER in the
 *  list commits together or (on any single failure) none do -- fine given each ALTER is independently
 *  idempotent and this reruns unconditionally on every boot: a failed attempt just retries the whole batch
 *  next boot instead of leaving a partially-widened, inconsistent state. */
export async function widenGithubIdColumnsToBigint(db: D1Database): Promise<void> {
  await db.exec(GITHUB_ID_BIGINT_WIDENING_SQL).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "selfhost_github_id_bigint_widen_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}
