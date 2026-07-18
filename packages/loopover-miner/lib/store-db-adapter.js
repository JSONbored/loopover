// Shared SqliteDriver / D1 adapter seam for AMS local stores (#7175 part 1).
//
// Mirrors ORB's `src/selfhost/d1-adapter.ts` so hosted AMS can later swap in `createPgAdapter` without
// inventing a second abstraction. Self-host default remains node:sqlite via `nodeSqliteDriver`.
// Keep this surface in sync with the ORB module when either side grows (Postgres interactive txn /
// `runOn` arrives in a later #7175 slice — not this file yet).

/**
 * @typedef {{
 *   query: (sql: string, params: unknown[]) => { rows: Record<string, unknown>[]; changes: number; lastInsertRowid: number };
 *   exec: (sql: string) => void;
 * }} SqliteDriver
 */

function meta(changes = 0, lastRowId = 0) {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  };
}

/** One prepared (and optionally bound) statement — D1 statements are immutable after bind. */
class Statement {
  /**
   * @param {SqliteDriver} driver
   * @param {string} sql
   * @param {unknown[]} [values]
   */
  constructor(driver, sql, values = []) {
    this.driver = driver;
    this.sql = sql;
    this.values = values;
  }

  /** @param {...unknown} values */
  bind(...values) {
    return new Statement(this.driver, this.sql, values);
  }

  execSync() {
    const r = this.driver.query(this.sql, this.values);
    return { results: r.rows, success: true, meta: meta(r.changes, r.lastInsertRowid) };
  }

  async all() {
    return this.execSync();
  }

  async run() {
    return this.execSync();
  }

  /** @param {string} [colName] */
  async first(colName) {
    const row = this.driver.query(this.sql, this.values).rows[0];
    if (row == null) return null;
    return (colName != null ? row[colName] : row) ?? null;
  }

  async raw() {
    return this.driver.query(this.sql, this.values).rows.map((row) => Object.values(row));
  }
}

/**
 * Wrap a synchronous SqliteDriver as a D1-shaped database (async prepare/batch/exec).
 * @param {SqliteDriver} driver
 */
export function createD1Adapter(driver) {
  return {
    prepare(sql) {
      return new Statement(driver, sql);
    },
    async batch(statements) {
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
    async exec(sql) {
      driver.exec(sql);
      return { count: (sql.match(/;/g) ?? []).length || 1, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  };
}

/**
 * Build a SqliteDriver from a node:sqlite DatabaseSync.
 * A statement with zero result columns is a WRITE; otherwise a READ.
 *
 * LIMITATION (#7175 follow-up): `INSERT/UPDATE/DELETE … RETURNING` statements report result columns, so
 * this heuristic would treat them as reads and drop `changes`/`lastInsertRowid`. claim-ledger and other
 * RETURNING callers must not migrate onto `driver.query` until the heuristic is sharpened (e.g. statement
 * class detection) or those stores use `createD1Adapter`/`run` exclusively.
 * @param {{ prepare: (sql: string) => { columns: () => unknown[]; all: (...p: unknown[]) => unknown[]; run: (...p: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint } }; exec: (sql: string) => void }} db
 * @returns {SqliteDriver}
 */
export function nodeSqliteDriver(db) {
  return {
    query(sql, params) {
      const stmt = db.prepare(sql);
      if (stmt.columns().length > 0) {
        return { rows: /** @type {Record<string, unknown>[]} */ (stmt.all(...params)), changes: 0, lastInsertRowid: 0 };
      }
      const info = stmt.run(...params);
      return { rows: [], changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
    },
    exec(sql) {
      db.exec(sql);
    },
  };
}
