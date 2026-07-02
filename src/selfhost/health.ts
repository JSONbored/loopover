// Self-host liveness/readiness probes (#982). Liveness is binding-free (the process is up); readiness asserts
// the things a request actually depends on — the DB answers and the schema migrations have been applied.
// Backend-agnostic: runs through the D1 surface, so it works on both the SQLite and Postgres adapters.

export interface Readiness {
  ok: boolean;
  checks: Record<string, boolean>;
  durationsMs: Record<string, number>;
}

export type HealthBackend = "sqlite" | "postgres";

export interface HealthBody {
  status: "ok";
  version: string;
  uptimeSeconds: number;
  backend: HealthBackend;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveHealthVersion(
  env: { GITTENSORY_VERSION?: string | undefined },
  packageVersion?: string,
): string {
  const envVersion = nonBlank(env.GITTENSORY_VERSION);
  if (envVersion) return envVersion;
  return nonBlank(packageVersion) ?? "unknown";
}

export function buildHealthBody(opts: {
  version?: string;
  startedAt: number;
  dbBackend: HealthBackend;
}): HealthBody {
  return {
    status: "ok",
    version: nonBlank(opts.version) ?? "unknown",
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - opts.startedAt) / 1000)),
    backend: opts.dbBackend,
  };
}

/** An extra readiness check for a CONFIGURED optional backend (Redis, Qdrant …). `check` resolves true when the
 *  backend is reachable; it OWNS its own timeout (the caller wires it that way) so a hung backend can't hang /ready.
 *  A configured backend that fails to answer means the instance is degraded — a multi-instance load balancer should
 *  stop routing to it — so every probe gates readiness. */
export type ReadinessProbe = { name: string; check: () => Promise<boolean> };

async function timedReadinessCheck(
  name: string,
  durationsMs: Record<string, number>,
  check: () => Promise<boolean>,
): Promise<boolean> {
  const startedAt = performance.now();
  try {
    return await check();
  } catch {
    return false;
  } finally {
    durationsMs[name] = Math.max(0, performance.now() - startedAt);
  }
}

/** Readiness: the DB answers a trivial query, the migrations table shows applied rows, and every configured
 *  optional-backend probe (Redis/Qdrant, when wired) answers. An instance can no longer report ready while a
 *  backend it actually depends on is down. */
export async function readiness(db: D1Database, probes: ReadinessProbe[] = []): Promise<Readiness> {
  const durationsMs: Record<string, number> = {};
  const dbOk = await timedReadinessCheck("db", durationsMs, async () => {
    await db.prepare("SELECT 1 AS one").first();
    return true;
  });
  const migrations = await timedReadinessCheck("migrations", durationsMs, async () => {
    const row = await db.prepare("SELECT COUNT(*) AS c FROM _selfhost_migrations").first<{ c: number }>();
    // COUNT(*) always returns one row on D1/SQLite; if an adapter violates that, this try/catch fails closed.
    return Number(row!.c) > 0;
  });
  const checks: Record<string, boolean> = { db: dbOk, migrations };
  for (const probe of probes) {
    checks[probe.name] = await timedReadinessCheck(probe.name, durationsMs, probe.check);
  }
  return { ok: Object.values(checks).every(Boolean), checks, durationsMs };
}

/** Boot-time DATA-SAFETY advisory. A single SQLite file with no acknowledged backup is a data-loss SPOF — yet
 *  `/ready` would still answer 200, so an operator can run with zero durability believing they're healthy. Returns
 *  the warning to log at boot (or null on Postgres, or once the operator sets `BACKUP_ACKNOWLEDGED=true` after
 *  wiring Litestream or another backup). */
export function sqliteBackupAdvisory(opts: { usingSqlite: boolean; backupAcknowledged: boolean }): string | null {
  if (!opts.usingSqlite || opts.backupAcknowledged) return null;
  return "Running on a single SQLite file with no acknowledged backup — if the volume is lost, ALL review state is lost. Enable the Litestream sidecar (see the maintainer self-hosting docs) to stream the WAL to S3/B2/MinIO, then set BACKUP_ACKNOWLEDGED=true to silence this warning. (Multi-instance: use DATABASE_URL=postgres://… instead.)";
}
