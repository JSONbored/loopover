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

/** Decide whether the GitHub App auth readiness probe should be registered, and how its check() behaves, from
 *  the two config vars (#2497). Registered whenever EITHER var is set -- gating registration on BOTH being set
 *  would silently skip the probe entirely for a partial config (e.g. the App ID set but the private key unset
 *  or a load failure), letting /ready report ready anyway even though GitHub App auth cannot mint a JWT. The
 *  returned check() itself re-verifies both are present before minting, so a partial config fails closed
 *  (false) in EITHER direction — not just the one a JWT-mint helper's own internal validation happens to catch.
 *  Neither var set is the legitimate brokered-mode deployment (central Orb App, no own App credentials):
 *  correctly returns null (no probe registered, since there is nothing of this instance's own to check).
 *  Scope: a successful mint only proves the private key is present and locally well-formed (importable +
 *  signable) -- it does NOT call GitHub, so it can't catch a valid key paired with the wrong App ID, or a
 *  key GitHub has since revoked. Those still surface (via the executor's own token mint) on the next real
 *  write, just not here. */
export function githubAppReadinessProbe(
  githubAppId: string | undefined,
  githubAppPrivateKey: string | undefined,
  mintAppJwt: () => Promise<unknown>,
): ReadinessProbe | null {
  if (!githubAppId && !githubAppPrivateKey) return null;
  return {
    name: "github_app",
    check: () =>
      githubAppId && githubAppPrivateKey
        ? mintAppJwt().then(() => true).catch(() => false)
        : Promise.resolve(false),
  };
}

/** Readiness probe for the codex CLI auth (#GITTENSORY-C). Runs `codex --version` in the restricted codex
 *  environment to confirm the binary is present AND authenticated before any review is attempted. A missing auth
 *  volume or an unauthenticated CLI exits non-zero here rather than silently inside a subprocess spawned mid-review.
 *  Only registered when `GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER=1` (the opt-in for the codex reviewer path). */
/** `codex --version` only proves the binary starts — it exits 0 with no usable credentials at all, so on its
 *  own it can't catch the exact missing/empty-auth-volume misconfiguration this probe exists to surface.
 *  Also stat the auth file so a present-but-empty or altogether-missing auth.json still fails readiness. */
async function defaultCodexAuthFileCheck(env: Record<string, string | undefined>): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  const base = env.CODEX_HOME ?? `${env.HOME ?? "~"}/.codex`;
  try {
    const info = await stat(`${base}/auth.json`);
    return info.size > 0;
  } catch {
    return false;
  }
}

export function codexAuthReadinessProbe(
  parentEnv: Record<string, string | undefined>,
  runCodexVersion: (env: Record<string, string | undefined>) => Promise<{ code: number | null }>,
  checkAuthFile: (env: Record<string, string | undefined>) => Promise<boolean> = defaultCodexAuthFileCheck,
): ReadinessProbe | null {
  if (parentEnv.GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER !== "1") return null;
  return {
    name: "codex_auth",
    check: async () => {
      const [versionOk, authFileOk] = await Promise.all([
        runCodexVersion(parentEnv)
          .then(({ code }) => code === 0)
          .catch(() => false),
        checkAuthFile(parentEnv).catch(() => false),
      ]);
      return versionOk && authFileOk;
    },
  };
}

/** Boot-time DATA-SAFETY advisory. A single SQLite file with no acknowledged backup is a data-loss SPOF — yet
 *  `/ready` would still answer 200, so an operator can run with zero durability believing they're healthy. Returns
 *  the warning to log at boot (or null on Postgres, or once the operator sets `BACKUP_ACKNOWLEDGED=true` after
 *  wiring Litestream or another backup). */
export function sqliteBackupAdvisory(opts: { usingSqlite: boolean; backupAcknowledged: boolean }): string | null {
  if (!opts.usingSqlite || opts.backupAcknowledged) return null;
  return "Running on a single SQLite file with no acknowledged backup — if the volume is lost, ALL review state is lost. Enable the Litestream sidecar (see the maintainer self-hosting docs) to stream the WAL to S3/B2/MinIO, then set BACKUP_ACKNOWLEDGED=true to silence this warning. (Multi-instance: use DATABASE_URL=postgres://… instead.)";
}
