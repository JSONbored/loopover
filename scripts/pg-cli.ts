// Shared pg-driver plumbing for the calibration CLIs (#8171). Self-host operators' ledgers live in
// Postgres behind the same shim the Worker uses, so the CLIs reuse src/selfhost/pg-adapter.ts's
// createPgAdapter — the SAME dialect translation the deployed code runs, never a second SQL
// implementation — and each script's pure core stays untouched. Driver selection mirrors how the
// selfhost stack itself picks its DB (src/selfhost/preflight.ts reads DATABASE_URL): an explicit
// `--pg <conn>` wins, a bare `--pg` falls back to DATABASE_URL, and without `--pg` the D1/wrangler
// path stays the default — DATABASE_URL alone never silently switches drivers.
import pg from "pg";
import { createPgAdapter } from "../src/selfhost/pg-adapter.js";

/** PURE driver selection: the pg connection string to use, or null for the default D1/wrangler path.
 *  Throws (fail-loud, like every IO error in these CLIs) when `--pg` was given but no connection string
 *  can be resolved — a silent fall-through to D1 could read the WRONG deployment's ledger. */
export function resolvePgConnection(pgFlagPresent: boolean, pgFlagValue: string | undefined, databaseUrl: string | undefined): string | null {
  if (!pgFlagPresent) return null;
  const explicit = pgFlagValue?.trim();
  if (explicit) return explicit;
  const fromEnv = databaseUrl?.trim();
  if (fromEnv) return fromEnv;
  throw new Error("--pg was given without a connection string and DATABASE_URL is not set");
}

/** PURE label for reports/manifests: names the database WITHOUT the credentials the connection string
 *  carries (nothing secret-shaped may reach a written artifact). */
export function pgDatabaseLabel(connection: string): string {
  try {
    const database = new URL(connection).pathname.replace(/^\//, "");
    return database ? `postgres:${database}` : "postgres";
  } catch {
    return "postgres";
  }
}

export type PgCliSession = {
  /** The selfhost adapter: SQLite-dialect SQL in, translated Postgres out — identical to the Worker path. */
  db: D1Database;
  close(): Promise<void>;
};

/** Open a pooled connection wrapped in the selfhost adapter. Callers own close() (try/finally). */
export function openPgDatabase(connection: string): PgCliSession {
  const pool = new pg.Pool({ connectionString: connection });
  pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10)); // int8 (COUNT/SUM) → number, like D1
  return {
    db: createPgAdapter(pool),
    close: async () => {
      await pool.end();
    },
  };
}
