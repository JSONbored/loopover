// Self-host liveness/readiness probes (#982). Liveness is binding-free (the process is up); readiness asserts
// the things a request actually depends on — the DB answers and the schema migrations have been applied.
// Backend-agnostic: runs through the D1 surface, so it works on both the SQLite and Postgres adapters.

export interface Readiness {
  ok: boolean;
  checks: Record<string, boolean>;
  durationsMs: Record<string, number>;
}

export interface HealthBody {
  status: "ok";
}

export function buildHealthBody(): HealthBody {
  return { status: "ok" };
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
 *  Only registered when `LOOPOVER_ENABLE_UNSAFE_CODEX_REVIEWER=1` (the opt-in for the codex reviewer path). */
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
  env: Record<string, string | undefined>,
  runCodexVersion: (env: Record<string, string | undefined>) => Promise<{ code: number | null }>,
  checkAuthFile: (env: Record<string, string | undefined>) => Promise<boolean> = defaultCodexAuthFileCheck,
  cacheMs = 30_000,
): ReadinessProbe | null {
  // Strict "1"-only, matching this flag's intentionally narrow (non-loose-truthy) opt-in convention.
  if (env.LOOPOVER_ENABLE_UNSAFE_CODEX_REVIEWER !== "1") return null;
  let cached: boolean | undefined;
  let cachedUntil = 0;
  let inFlight: Promise<boolean> | undefined;
  const evaluate = async (): Promise<boolean> => {
    const [versionOk, authFileOk] = await Promise.all([
      runCodexVersion(env)
        .then(({ code }) => code === 0)
        .catch(() => false),
      checkAuthFile(env).catch(() => false),
    ]);
    return versionOk && authFileOk;
  };
  return {
    name: "codex_auth",
    check: () => {
      const now = Date.now();
      if (cached !== undefined && now < cachedUntil) return Promise.resolve(cached);
      if (inFlight) return inFlight;
      inFlight = evaluate()
        .then((ok) => {
          cached = ok;
          cachedUntil = Date.now() + cacheMs;
          return ok;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
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

/** Prometheus gauge value mirroring {@link sqliteBackupAdvisory}: 1 when Postgres or backup is acknowledged, 0 when the advisory would fire. */
export function backupAcknowledgedGaugeValue(opts: { usingSqlite: boolean; backupAcknowledged: boolean }): 0 | 1 {
  return sqliteBackupAdvisory(opts) === null ? 1 : 0;
}

// Hostnames that are NEVER reachable from the public internet, regardless of deployment — loopback, RFC1918
// private ranges, and the mDNS/internal-DNS conventions no public resolver honors. Deliberately excludes
// Tailscale's own *.ts.net MagicDNS suffix from this "never" list: a node with Funnel explicitly enabled DOES
// serve that exact hostname over public HTTPS, so *.ts.net gets its own softer check below rather than being
// treated as definitely non-public.
function isDefinitelyPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // URL.hostname keeps the brackets on an IPv6 literal ("[::1]", not "::1") — compare against the bracketed
  // form, not the bare address.
  if (host === "localhost" || host === "0.0.0.0" || host === "[::1]") return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (ipv4) {
    const first = Number(ipv4[1]);
    const second = Number(ipv4[2]);
    if (first === 127 || first === 10) return true;
    if (first === 192 && second === 168) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
  }
  return false;
}

/** True when `origin` parses as a URL whose hostname is a well-known non-public pattern (loopback, RFC1918,
 *  mDNS/`.internal`), OR a bare Tailscale MagicDNS hostname (`*.ts.net`) — publicly reachable ONLY when the
 *  operator has explicitly enabled Tailscale Funnel for that node, which this check has no way to observe.
 *  An unparseable value is this function's job to reject as "not a URL at all", not "looks non-public" — but
 *  that is a distinct, well-formedness problem this advisory doesn't cover (PUBLIC_API_ORIGIN's own
 *  first-run-setup preflight check already validates that shape; nothing else currently reads
 *  PUBLIC_SITE_ORIGIN at boot), so it's silently false here rather than double-reported. */
function looksNonPublic(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return isDefinitelyPrivateHostname(hostname) || hostname.toLowerCase().endsWith(".ts.net");
  } catch {
    return false;
  }
}

/** Boot-time advisory (JSONbored/gittensory PR #4180's live bug): `PUBLIC_API_ORIGIN`/`PUBLIC_SITE_ORIGIN` get
 *  embedded VERBATIM as `<img src>` in the public "Visual preview" PR comment table (see
 *  `src/review/visual/capture.ts`) — a value GitHub's own servers, not this instance, must be able to fetch.
 *  `PUBLIC_API_ORIGIN`'s existing preflight check (see `isBareHttpsOrigin` above) only confirms it's a
 *  WELL-FORMED bare https origin — a private tailnet hostname like `https://node.example.ts.net` passes that
 *  check fine while still being completely unfetchable by GitHub, so every screenshot silently renders as a
 *  broken image with no operator-visible signal until a human notices. This never hard-fails boot (unlike
 *  `assertSelfHostPreflight`'s checks): a false positive here (e.g. a legitimately Funnel-exposed `*.ts.net`
 *  node) would only be a degraded review feature, not a security or data-loss risk, so — mirroring
 *  {@link sqliteBackupAdvisory}'s own acknowledgment escape hatch — it warns rather than blocks, and the
 *  operator can silence it with `PUBLIC_ORIGIN_ACKNOWLEDGED=true` once they've confirmed the origin really is
 *  public (Funnel enabled, a reverse proxy in front of it, etc.). Neither var set is left alone: visual
 *  capture degrades to dash cells in that case (see capture.ts), not a broken image, so there's nothing to warn
 *  about until an operator sets one of these to something that looks wrong. */
export function publicOriginReachabilityAdvisory(opts: {
  publicApiOrigin: string | undefined;
  publicSiteOrigin: string | undefined;
  acknowledged: boolean;
}): string | null {
  if (opts.acknowledged) return null;
  const suspect = [opts.publicApiOrigin, opts.publicSiteOrigin]
    .filter((value): value is string => Boolean(value?.trim()))
    .find((value) => looksNonPublic(value));
  if (!suspect) return null;
  return `PUBLIC_API_ORIGIN/PUBLIC_SITE_ORIGIN includes "${suspect}", which looks like a private/internal hostname — GitHub's servers cannot fetch it, so visual-capture screenshots embedded in PR comments will render as broken images. Set it to a real publicly-reachable origin (or, if this host has Tailscale Funnel enabled and IS genuinely public, set PUBLIC_ORIGIN_ACKNOWLEDGED=true to silence this warning).`;
}

/** Prometheus gauge value mirroring {@link publicOriginReachabilityAdvisory}: 1 when no suspect origin is
 *  configured (or the operator acknowledged it), 0 when the advisory would fire. */
export function publicOriginAcknowledgedGaugeValue(opts: {
  publicApiOrigin: string | undefined;
  publicSiteOrigin: string | undefined;
  acknowledged: boolean;
}): 0 | 1 {
  return publicOriginReachabilityAdvisory(opts) === null ? 1 : 0;
}
