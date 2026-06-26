// Self-host liveness/readiness probes (#982). Liveness is binding-free (the process is up); readiness asserts
// the things a request actually depends on — the DB answers and the schema migrations have been applied.
// Backend-agnostic: runs through the D1 surface, so it works on both the SQLite and Postgres adapters.

export interface Readiness {
  ok: boolean;
  checks: Record<string, boolean>;
}

/** An extra readiness check for a CONFIGURED optional backend (Redis, Qdrant …). `check` resolves true when the
 *  backend is reachable; it OWNS its own timeout (the caller wires it that way) so a hung backend can't hang /ready.
 *  A configured backend that fails to answer means the instance is degraded — a multi-instance load balancer should
 *  stop routing to it — so every probe gates readiness. */
export type ReadinessProbe = { name: string; check: () => Promise<boolean> };

/** Readiness: the DB answers a trivial query, the migrations table shows applied rows, and every configured
 *  optional-backend probe (Redis/Qdrant, when wired) answers. An instance can no longer report ready while a
 *  backend it actually depends on is down. */
export async function readiness(db: D1Database, probes: ReadinessProbe[] = []): Promise<Readiness> {
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
  const checks: Record<string, boolean> = { db: dbOk, migrations };
  for (const probe of probes) {
    try {
      checks[probe.name] = await probe.check();
    } catch {
      checks[probe.name] = false; // an unreachable / erroring backend is not ready
    }
  }
  return { ok: Object.values(checks).every(Boolean), checks };
}
