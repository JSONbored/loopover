// LoopOver Orb central GitHub App (#1255) — the token-broker. A maintainer's self-hosted container exchanges a
// one-time enrollment secret for short-lived GitHub installation tokens, so it can act on its own repos WITHOUT
// ever holding the Orb App private key (loopover holds it centrally and mints on demand).
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

// The original secret type this broker knows how to mint (#7174). The `secret_type` column exists so a future
// AI-provider-key / DB-credential strategy (the hosted control-plane's provisioning core, #7180) can record
// what an enrollment row is FOR without inventing a second table — any row carrying a value this file doesn't
// recognize is a config/data error brokerOrbToken must refuse, not silently GitHub-mint against.
export const ORB_SECRET_TYPE_GITHUB_TOKEN = "github_token";

// A STORED (not minted) secret type (#8064, split from #7852/#7180): a credential the caller already has in
// hand (e.g. a hosted tenant's Postgres connection string) that this broker just holds custody of, encrypted
// at rest, and hands back verbatim on exchange — no installation-eligibility re-check, no mint/cache TTL logic,
// none of which apply to a value that isn't derived from a GitHub App at all. See issueOrbStoredSecret and
// brokerOrbToken's own secret_type branch below.
export const ORB_SECRET_TYPE_TENANT_DB_CREDENTIAL = "tenant_db_credential";

export function isOrbBrokerEnabled(env: Env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.ORB_BROKER_ENABLED ?? "").trim());
}

export type IssueResult = { enrollId: string; secret: string } | { error: "installation_not_found" | "installation_not_registered" };

/** Mint a one-time enrollment secret for a REGISTERED install. Returns the plaintext secret ONCE (stored only
 *  hashed). Issued by the operator (internal endpoint) OR by a maintainer who proved install-admin via OAuth —
 *  in the latter case the maintainer's GitHub identity is recorded for audit. installation_id is bound here and
 *  read back (never from the request) at token-exchange time, so a secret can never mint a token for another
 *  install. `secretType` defaults to the only mintable type today; every existing caller is unaffected. */
export async function issueOrbEnrollment(
  env: Env,
  installationId: number,
  maintainer?: { login: string; githubId?: number | null | undefined },
  secretType: string = ORB_SECRET_TYPE_GITHUB_TOKEN,
): Promise<IssueResult> {
  const install = await env.DB.prepare("SELECT registered FROM orb_github_installations WHERE installation_id = ?").bind(installationId).first<{ registered: number }>();
  if (!install) return { error: "installation_not_found" };
  if (install.registered !== 1) return { error: "installation_not_registered" };
  const enrollId = createOpaqueToken("orbenr");
  const secret = createOpaqueToken("orbsec");
  await env.DB.prepare(
    `INSERT INTO orb_enrollments (enroll_id, installation_id, maintainer_login, maintainer_github_id, secret_hash, secret_type, state, authorized_at, enrolled_at)
     VALUES (?, ?, ?, ?, ?, ?, 'enrolled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  )
    .bind(enrollId, installationId, maintainer?.login ?? null, maintainer?.githubId ?? null, await hashToken(secret), secretType)
    .run();
  return { enrollId, secret };
}

export type IssueStoredSecretResult = IssueResult | { error: "secret_value_required" | "encryption_unavailable" };

/** Issues a one-time enrollment secret for a STORED (not minted) credential (#8064) -- e.g. control-plane's
 *  hosted tenant Postgres connection details (#7180's provisioning core). Deliberately does NOT reuse
 *  issueOrbEnrollment's installation-registration gate: that gate exists because a GitHub-token enrollment is
 *  a maintainer's self-hosted container proving it administers a REAL, registered GitHub installation -- a
 *  stored tenant secret has no GitHub installation to bind to at all (an AMS tenant has none; even a hosted
 *  ORB tenant's installation lives in control-plane's own registry, #7181, not this table's
 *  orb_github_installations). `installation_id` is therefore always NULL on these rows. This issuance path's
 *  authority is the caller already holding the internal admin token -- the same /v1/internal/* middleware
 *  every other operator-only route in routes.ts sits behind -- not installation registration. */
export async function issueOrbStoredSecret(env: Env, secretType: string, secretValue: string): Promise<IssueStoredSecretResult> {
  if (!secretValue) return { error: "secret_value_required" };
  if (!env.TOKEN_ENCRYPTION_SECRET) return { error: "encryption_unavailable" };
  const enrollId = createOpaqueToken("orbenr");
  const secret = createOpaqueToken("orbsec");
  const encrypted = await encryptSecret(secretValue, env.TOKEN_ENCRYPTION_SECRET);
  await env.DB.prepare(
    `INSERT INTO orb_enrollments
       (enroll_id, installation_id, secret_hash, secret_type, state, authorized_at, enrolled_at,
        secret_value_ciphertext, secret_value_iv, secret_value_salt, secret_value_version)
     VALUES (?, NULL, ?, ?, 'enrolled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?)`,
  )
    .bind(enrollId, await hashToken(secret), secretType, encrypted.ciphertext, encrypted.iv, encrypted.salt, encrypted.version)
    .run();
  return { enrollId, secret };
}

export type RevokeResult = { revoked: true } | { error: "enrollment_not_found" };

/** Generic revoke path (#8064): works for ANY secret type, since brokerOrbToken's very first gate (both the
 *  original GitHub-token mint flow and the new stored-secret flow below) already refuses any row with a
 *  non-null revoked_at -- that check has existed since #7174 but nothing has ever WRITTEN to the column until
 *  now. Idempotent: revoking an already-revoked enrollment succeeds without disturbing its original
 *  revoked_at (COALESCE keeps the first revocation's timestamp, matching every other driver's teardown
 *  contract in this codebase -- a repeat revoke is a no-op, not a second event). */
export async function revokeOrbEnrollment(env: Env, enrollId: string): Promise<RevokeResult> {
  const existing = await env.DB.prepare("SELECT enroll_id FROM orb_enrollments WHERE enroll_id = ?").bind(enrollId).first<{ enroll_id: string }>();
  if (!existing) return { error: "enrollment_not_found" };
  await env.DB.prepare("UPDATE orb_enrollments SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP), state = 'revoked' WHERE enroll_id = ?")
    .bind(enrollId)
    .run();
  return { revoked: true };
}

export type BrokerResult =
  | { token: string; installationId: number; expiresAt: string; permissions: Record<string, string> }
  | { secretValue: string; secretType: string }
  | { error: "invalid_enrollment" | "installation_not_eligible" | "broker_misconfigured" | "unsupported_secret_type" };

type OrbEnrollmentRow = {
  enroll_id: string;
  installation_id: number;
  state: string;
  revoked_at: string | null;
  cached_token_json: string | null;
  secret_type: string;
  secret_value_ciphertext: string | null;
  secret_value_iv: string | null;
  secret_value_salt: string | null;
};

/** The container's token-exchange: a valid enrollment secret → either a short-lived GitHub installation token
 *  (the original, mint-style flow) or a decrypted stored secret value (#8064's store-style flow), branching on
 *  the enrollment row's own secret_type. installation_id/eligibility only apply to the GitHub-token flow — a
 *  stored secret has no GitHub installation to re-check at all (see issueOrbStoredSecret's header comment). */
export async function brokerOrbToken(env: Env, secret: string, options: { forceRefresh?: boolean } = {}): Promise<BrokerResult> {
  // Warn when TOKEN_ENCRYPTION_SECRET is absent — without it, the broker cache is bypassed and every exchange hits
  // GitHub's token endpoint, dramatically increasing exposure to throttle-induced failures.
  if (!env.TOKEN_ENCRYPTION_SECRET) {
    console.warn(JSON.stringify({ level: "warn", event: "orb_broker_no_encryption_key", message: "TOKEN_ENCRYPTION_SECRET is not set; broker token cache is disabled. Set this variable to enable caching and reduce GitHub throttle risk." }));
  }
  const row = await env.DB
    .prepare(
      `SELECT enroll_id, installation_id, state, revoked_at, cached_token_json, secret_type,
              secret_value_ciphertext, secret_value_iv, secret_value_salt
       FROM orb_enrollments WHERE secret_hash = ?`,
    )
    .bind(await hashToken(secret))
    .first<OrbEnrollmentRow>();
  if (!row || row.state !== "enrolled" || row.revoked_at !== null) return { error: "invalid_enrollment" };
  if (row.secret_type === ORB_SECRET_TYPE_TENANT_DB_CREDENTIAL) return resolveStoredSecret(env, row);
  // Checked once the caller is already proven to hold a valid enrollment (same ordering rationale as the App-
  // credential check below, #2710) — anything else here belongs to a mint strategy that doesn't exist yet.
  if (row.secret_type !== ORB_SECRET_TYPE_GITHUB_TOKEN) return { error: "unsupported_secret_type" };
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

/** Decrypts and returns a STORED secret value (#8064) -- the exchange-time counterpart to
 *  issueOrbStoredSecret's encrypt-and-store. Unlike the GitHub-token flow above, there is no cache, no
 *  re-mint, and no installation-eligibility check: the value was already fixed at issue time, so the ONLY way
 *  this can fail is a server-side config/data problem (no encryption key configured, a rotated key that can no
 *  longer decrypt an older value, or -- defensively -- a row that claims this secret_type but never actually
 *  got a value written, which should be impossible via issueOrbStoredSecret but is checked anyway). Every
 *  failure reuses broker_misconfigured: none of them are the caller's fault, matching this file's existing
 *  posture that a bad App-credential config (above) is never reported as "invalid_enrollment". */
async function resolveStoredSecret(env: Env, row: OrbEnrollmentRow): Promise<BrokerResult> {
  if (!env.TOKEN_ENCRYPTION_SECRET || !row.secret_value_ciphertext || !row.secret_value_iv) {
    console.error(JSON.stringify({ level: "error", event: "orb_broker_misconfigured", message: "TOKEN_ENCRYPTION_SECRET is not set, or this enrollment has no stored secret value; the broker cannot serve a stored secret." }));
    return { error: "broker_misconfigured" };
  }
  try {
    const secretValue = await decryptSecret(row.secret_value_ciphertext, row.secret_value_iv, env.TOKEN_ENCRYPTION_SECRET, row.secret_value_salt);
    await touchLastToken(env, row.enroll_id);
    return { secretValue, secretType: row.secret_type };
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "orb_broker_stored_secret_decrypt_failed", enrollId: row.enroll_id, message: String(error).slice(0, 120) }));
    return { error: "broker_misconfigured" };
  }
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
  } catch (error) {
    // Was silent, unlike this function's mirror-image sibling cacheOrbToken (below), which logs the identical
    // failure class (a malformed entry or a decrypt failure, e.g. after TOKEN_ENCRYPTION_SECRET rotation) at
    // warn. Without this, a rotated/mismatched key makes every cached-token read fail permanently and silently,
    // degrading every broker call to a full GitHub token mint forever with zero signal anywhere.
    console.warn(JSON.stringify({ level: "warn", event: "orb_token_cache_read_failed", message: String(error).slice(0, 120) }));
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
