// Gittensory Orb central GitHub App (#1255) — the token-broker. A maintainer's self-hosted container exchanges a
// one-time enrollment secret for short-lived GitHub installation tokens, so it can act on its own repos WITHOUT
// ever holding the Orb App private key (gittensory holds it centrally and mints on demand).
//
// Trust model (das-github-mirror): the OPERATOR is the authority. An enrollment is issued only for an install the
// operator has already opted in (registered=1) via the internal-token-gated POST /v1/internal/orb/enrollments;
// the secret is shown to the operator ONCE and stored only as a SHA-256 hash. The container then presents that
// secret to /v1/orb/token. The minted token's installation_id comes from the enrollment ROW (bound server-side at
// issue time) — never from the request — so a stolen secret for install X can never mint a token for install Y.
// Every path is inert (404) until ORB_BROKER_ENABLED is set. Two issue paths exist: the operator-issued internal
// endpoint here, and maintainer-OAuth SELF-enrollment (src/orb/oauth.ts), which proves the caller is an admin of
// the installation's account server-side before issuing — both bind installation_id at issue time, so the OAuth
// privilege-escalation surface the red-team flagged stays closed.
import { createOpaqueToken, hashToken } from "../auth/security";
import { decryptSecret, encryptSecret } from "../utils/crypto";
import { createOrbInstallationToken } from "./app-auth";

// A minted GitHub installation token lasts ~1h; re-mint only once it is under this margin so a near-expiry
// entry is never handed out (covers clock skew + the engine's own ~5m cache margin).
const ORB_TOKEN_CACHE_MIN_REMAINING_MS = 10 * 60_000;

export function isOrbBrokerEnabled(env: Env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.ORB_BROKER_ENABLED ?? "").trim());
}

export type IssueResult = { enrollId: string; secret: string } | { error: "installation_not_found" | "installation_not_registered" };

/** Mint a one-time enrollment secret for a REGISTERED install. Returns the plaintext secret ONCE (stored only
 *  hashed). Issued by the operator (internal endpoint) OR by a maintainer who proved install-admin via OAuth —
 *  in the latter case the maintainer's GitHub identity is recorded for audit. installation_id is bound here and
 *  read back (never from the request) at token-exchange time, so a secret can never mint a token for another install. */
export async function issueOrbEnrollment(
  env: Env,
  installationId: number,
  maintainer?: { login: string; githubId?: number | null | undefined },
): Promise<IssueResult> {
  const install = await env.DB.prepare("SELECT registered FROM orb_github_installations WHERE installation_id = ?").bind(installationId).first<{ registered: number }>();
  if (!install) return { error: "installation_not_found" };
  if (install.registered !== 1) return { error: "installation_not_registered" };
  const enrollId = createOpaqueToken("orbenr");
  const secret = createOpaqueToken("orbsec");
  await env.DB.prepare(
    `INSERT INTO orb_enrollments (enroll_id, installation_id, maintainer_login, maintainer_github_id, secret_hash, state, authorized_at, enrolled_at)
     VALUES (?, ?, ?, ?, ?, 'enrolled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  )
    .bind(enrollId, installationId, maintainer?.login ?? null, maintainer?.githubId ?? null, await hashToken(secret))
    .run();
  return { enrollId, secret };
}

export type BrokerResult =
  | { token: string; installationId: number; expiresAt: string; permissions: Record<string, string> }
  | { error: "invalid_enrollment" | "installation_not_eligible" | "broker_misconfigured" };

/** The container's token-exchange: a valid enrollment secret → a short-lived installation token for the BOUND
 *  install. installation_id is read from the enrollment row, never the caller; the install must still be
 *  registered=1 and neither suspended nor removed at mint time (the gate is re-checked, not trusted from issue). */
export async function brokerOrbToken(env: Env, secret: string, options: { forceRefresh?: boolean } = {}): Promise<BrokerResult> {
  // Warn when TOKEN_ENCRYPTION_SECRET is absent — without it, the broker cache is bypassed and every exchange hits
  // GitHub's token endpoint, dramatically increasing exposure to throttle-induced failures.
  if (!env.TOKEN_ENCRYPTION_SECRET) {
    console.warn(JSON.stringify({ level: "warn", event: "orb_broker_no_encryption_key", message: "TOKEN_ENCRYPTION_SECRET is not set; broker token cache is disabled. Set this variable to enable caching and reduce GitHub throttle risk." }));
  }
  const row = await env.DB
    .prepare("SELECT enroll_id, installation_id, state, revoked_at, cached_token_json FROM orb_enrollments WHERE secret_hash = ?")
    .bind(await hashToken(secret))
    .first<{ enroll_id: string; installation_id: number; state: string; revoked_at: string | null; cached_token_json: string | null }>();
  if (!row || row.state !== "enrolled" || row.revoked_at !== null) return { error: "invalid_enrollment" };
  const install = await env.DB
    .prepare("SELECT registered, suspended_at, removed_at FROM orb_github_installations WHERE installation_id = ?")
    .bind(row.installation_id)
    .first<{ registered: number; suspended_at: string | null; removed_at: string | null }>();
  if (!install || install.registered !== 1 || install.suspended_at !== null || install.removed_at !== null) return { error: "installation_not_eligible" };
  // Serve a still-fresh cached token instead of re-minting. GitHub installation tokens last ~1h, and minting on
  // every broker call can throttle GitHub's token endpoint (slow responses -> engine timeouts -> unavailable orb).
  // The token is cached encrypted-at-rest (AES-256-GCM via TOKEN_ENCRYPTION_SECRET); with no key set the cache is
  // skipped and we mint every call exactly as before.
  const cached = options.forceRefresh ? null : await readCachedOrbToken(env, row.cached_token_json);
  if (cached) {
    await touchLastToken(env, row.enroll_id);
    return { token: cached.token, installationId: row.installation_id, expiresAt: cached.expiresAt, permissions: cached.permissions };
  }
  // Validate Orb App credentials only now that the caller is proven to hold a valid, eligible enrollment — NOT
  // up front. Checking credentials before the enrollment lookup would let an unauthenticated caller (any bad
  // secret) distinguish "broker misconfigured" from "invalid secret" via the response code alone, leaking the
  // server's deployment-config state to callers who never proved they hold a real enrollment (#2710).
  if (!env.ORB_GITHUB_APP_ID || !env.ORB_GITHUB_APP_PRIVATE_KEY) {
    console.error(JSON.stringify({ level: "error", event: "orb_broker_misconfigured", message: "ORB_GITHUB_APP_ID or ORB_GITHUB_APP_PRIVATE_KEY is not set; broker cannot mint tokens." }));
    return { error: "broker_misconfigured" };
  }
  const minted = await createOrbInstallationToken(env, row.installation_id);
  await cacheOrbToken(env, row.enroll_id, minted);
  await touchLastToken(env, row.enroll_id);
  return { token: minted.token, installationId: row.installation_id, expiresAt: minted.expiresAt, permissions: minted.permissions };
}

async function touchLastToken(env: Env, enrollId: string): Promise<void> {
  try {
    await env.DB.prepare("UPDATE orb_enrollments SET last_token_at = CURRENT_TIMESTAMP WHERE enroll_id = ?").bind(enrollId).run();
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "orb_token_last_touch_failed", enrollId, message: String(error).slice(0, 120) }));
  }
}

/** Decrypt + return the cached installation token when present and still safely before expiry; null (→ re-mint) on
 *  no key, no cache, an expired/unparseable entry, or any decrypt failure (e.g. a rotated encryption key). */
async function readCachedOrbToken(env: Env, cachedJson: string | null): Promise<{ token: string; expiresAt: string; permissions: Record<string, string> } | null> {
  if (!env.TOKEN_ENCRYPTION_SECRET || !cachedJson) return null;
  try {
    const entry = JSON.parse(cachedJson) as { ciphertext: string; iv: string; salt: string | null; expiresAt: string; permissions?: Record<string, string> };
    if (!(Date.parse(entry.expiresAt) - Date.now() >= ORB_TOKEN_CACHE_MIN_REMAINING_MS)) return null;
    const token = await decryptSecret(entry.ciphertext, entry.iv, env.TOKEN_ENCRYPTION_SECRET, entry.salt);
    return { token, expiresAt: entry.expiresAt, permissions: entry.permissions ?? {} };
  } catch {
    return null;
  }
}

/** Cache the freshly minted token (encrypted) on the enrollment row. Best-effort + fail-safe: a cache-write error
 *  must never fail a valid token exchange — the next call simply re-mints. No-op without an encryption key. */
async function cacheOrbToken(env: Env, enrollId: string, minted: { token: string; expiresAt: string; permissions: Record<string, string> }): Promise<void> {
  if (!env.TOKEN_ENCRYPTION_SECRET) return;
  try {
    const enc = await encryptSecret(minted.token, env.TOKEN_ENCRYPTION_SECRET);
    const json = JSON.stringify({ ciphertext: enc.ciphertext, iv: enc.iv, salt: enc.salt, expiresAt: minted.expiresAt, permissions: minted.permissions });
    await env.DB.prepare("UPDATE orb_enrollments SET cached_token_json = ? WHERE enroll_id = ?").bind(json, enrollId).run();
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "orb_token_cache_write_failed", enrollId, message: String(error).slice(0, 120) }));
  }
}
