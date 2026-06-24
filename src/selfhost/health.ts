// Self-host liveness/readiness probes (#982). Liveness is binding-free (the process is up); readiness asserts
// the things a request actually depends on — the DB answers and the schema migrations have been applied.
// Backend-agnostic: runs through the D1 surface, so it works on both the SQLite and Postgres adapters.

export interface Readiness {
  ok: boolean;
  checks: Record<string, boolean>;
}

/** Readiness: the DB answers a trivial query and the migrations table shows applied rows. */
export async function readiness(db: D1Database): Promise<Readiness> {
  let dbOk = false;
  let migrations = false;
  try {
    await db.prepare("SELECT 1 AS one").first();
    dbOk = true;
  } catch {
    /* db down */
  }
  try {
    const row = await db.prepare("SELECT COUNT(*) AS c FROM _selfhost_migrations").first<{ c: number }>();
    /* v8 ignore next */ // COUNT(*) always returns exactly one row, so the row?./?? 0 guards never fire
    migrations = Number(row?.c ?? 0) > 0;
  } catch {
    /* migrations table missing */
  }
  return { ok: dbOk && migrations, checks: { db: dbOk, migrations } };
}
