// Postgres-backed D1Database for the self-host Postgres backend (#977). Implements the same D1 surface the
// app + drizzle-orm/d1 use (prepare/bind/all/first/run/raw + batch + exec), translating each SQLite query to
// Postgres (pg-dialect.ts) and running it via node-postgres. A shared Postgres DB makes multi-instance
// self-host possible (vs the single-file SQLite default).
import type { Pool, PoolClient } from "pg";
import { translateDdl, translateSql } from "./pg-dialect";

type Row = Record<string, unknown>;
type Runner = Pool | PoolClient;

class PgStatement {
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
  const adapter = {
    prepare: (sql: string) => new PgStatement(pool, sql),
    async batch(statements: PgStatement[]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out: unknown[] = [];
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
