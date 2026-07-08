// Self-host D1 adapter (#980). A FAITHFUL D1Database implementation over a synchronous SQLite driver, so
// EVERY data-access path in gittensory runs UNCHANGED on a local file:
//   • drizzle-orm/d1 (getDb → the ~171 repository call sites) — calls bind/all/run/raw/batch + reads .results
//   • the raw `env.DB.prepare(sql).bind(...).all()/.first()/.run()/.batch()` sites
//   • the test suite, which uses the same D1 surface
// D1's API is async; the SQLite drivers are sync — sync calls are wrapped in resolved Promises. The driver is
// INJECTED behind the tiny SqliteDriver interface, so this module has no hard SQLite dependency and the
// Cloudflare Worker bundle never imports it. Default driver: node:sqlite (built into Node, no native build).
//
// `Statement` implements the shared `SelfHostD1PreparedStatement` contract (backend-contracts.ts, #4010) --
// the same one pg-adapter.ts's `PgStatement` implements -- and `createD1Adapter`'s own return value is typed
// `SelfHostD1Database` before the final `as unknown as D1Database` cast (D1Database is a `declare abstract
// class`, so a plain object can only ever satisfy it via that cast; there is no way to avoid it). That
// intermediate typed step is what's new: previously nothing checked this module's own shape against its
// Postgres sibling's before the cast erased everything to `unknown`.
import type { SelfHostD1Database, SelfHostD1PreparedStatement } from "./backend-contracts";

/** A uniform sync SQLite primitive both node:sqlite and better-sqlite3 can satisfy via a thin wrapper. `query`
 *  ALWAYS returns rows (empty for a write) + the write metadata, so the adapter needs no reader-detection. */
export interface SqliteDriver {
  query(sql: string, params: unknown[]): { rows: Record<string, unknown>[]; changes: number; lastInsertRowid: number };
  exec(sql: string): void;
}

function meta(changes = 0, lastRowId = 0): Record<string, unknown> {
  return { duration: 0, size_after: 0, rows_read: 0, rows_written: changes, last_row_id: lastRowId, changed_db: changes > 0, changes };
}

/** One prepared (and optionally bound) statement. bind() returns a fresh instance (D1 statements are immutable
 *  after bind). The SQLite statement is compiled per execution (drivers cache by SQL text). */
class Statement implements SelfHostD1PreparedStatement {
  constructor(
    private readonly driver: SqliteDriver,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.driver, this.sql, values);
  }

  /** Sync core used by all()/run() (async wrappers) and batch() (inside a transaction). */
  execSync(): { results: unknown[]; success: true; meta: Record<string, unknown> } {
    const r = this.driver.query(this.sql, this.values);
    return { results: r.rows, success: true, meta: meta(r.changes, r.lastInsertRowid) };
  }

  async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return this.execSync() as { results: T[]; success: true; meta: Record<string, unknown> };
  }

  // D1's run() returns the same {results, meta} shape (results empty for a non-returning write).
  async run<T = unknown>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return this.execSync() as { results: T[]; success: true; meta: Record<string, unknown> };
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = this.driver.query(this.sql, this.values).rows[0];
    if (row == null) return null;
    return ((colName != null ? row[colName] : row) ?? null) as T | null;
  }

  async raw<T = unknown>(): Promise<T[]> {
    // D1 raw() returns each row as an array of column values (column order preserved).
    return this.driver.query(this.sql, this.values).rows.map((row) => Object.values(row)) as T[];
  }
}

/** Wrap a synchronous SQLite driver as a D1Database. */
export function createD1Adapter(driver: SqliteDriver): D1Database {
  const adapter: SelfHostD1Database = {
    prepare(sql: string) {
      return new Statement(driver, sql);
    },
    async batch(statements: Statement[]) {
      // D1 runs a batch atomically, one result per statement, in order.
      driver.exec("BEGIN");
      try {
        const out = statements.map((s) => s.execSync());
        driver.exec("COMMIT");
        return out;
      } catch (error) {
        try {
          driver.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw error;
      }
    },
    async exec(sql: string) {
      driver.exec(sql); // runs one or more statements (used for migrations)
      return { count: (sql.match(/;/g) ?? []).length || 1, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0); // unused by gittensory; present for D1 surface completeness
    },
  };
  return adapter as unknown as D1Database;
}

/** The minimal node:sqlite surface the wrapper uses (DatabaseSync + StatementSync). */
interface NodeSqliteStatement {
  columns(): unknown[];
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
}

/** Build a SqliteDriver from a node:sqlite DatabaseSync. A statement with zero result columns is a WRITE
 *  (run → changes); otherwise a READ (all → rows). */
export function nodeSqliteDriver(db: NodeSqliteDatabase): SqliteDriver {
  return {
    query(sql, params) {
      const stmt = db.prepare(sql);
      if (stmt.columns().length > 0) {
        return { rows: stmt.all(...params) as Record<string, unknown>[], changes: 0, lastInsertRowid: 0 };
      }
      const info = stmt.run(...params);
      return { rows: [], changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
    },
    exec(sql) {
      db.exec(sql);
    },
  };
}
