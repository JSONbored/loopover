import {
  createAuthSession,
  getAuthSessionByTokenHash,
  recordAuditEvent,
  revokeAuthSession,
  storeSessionGitHubToken,
  touchAuthSession,
} from "../db/repositories";
import type { AuthSessionRecord, JsonValue } from "../types";
import { nowIso } from "../utils/json";

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export type AuthIdentity =
  | { kind: "static"; actor: "api" | "mcp" | "mcp-admin" | "internal" }
  | { kind: "session"; actor: string; session: AuthSessionRecord };

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const BROWSER_SESSION_COOKIE = "loopover_session";
export const GITHUB_OAUTH_STATE_COOKIE = "loopover_oauth_state";
export const GITHUB_OAUTH_STATE_TTL_SECONDS = 10 * 60;

export function extractBearerToken(header: string | null | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1]?.trim() || undefined;
}

export function extractCookieValue(header: string | null | undefined, name: string): string | undefined {
  const cookies = (header ?? "").split(";");
  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.trim().split("=");
    if (rawKey === name) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function extractBrowserSessionToken(cookieHeader: string | null | undefined): string | undefined {
  return extractCookieValue(cookieHeader, BROWSER_SESSION_COOKIE);
}

export function buildBrowserSessionCookie(token: string, requestUrl: string): string {
  return serializeCookie(BROWSER_SESSION_COOKIE, token, {
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookie(requestUrl),
  });
}

export function buildClearedBrowserSessionCookie(requestUrl: string): string {
  return serializeCookie(BROWSER_SESSION_COOKIE, "", {
    maxAge: 0,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookie(requestUrl),
  });
}

export function buildGitHubOAuthStateCookie(state: string, requestUrl: string): string {
  return serializeCookie(GITHUB_OAUTH_STATE_COOKIE, state, {
    maxAge: GITHUB_OAUTH_STATE_TTL_SECONDS,
    path: "/v1/auth/github",
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookie(requestUrl),
  });
}

export function buildClearedGitHubOAuthStateCookie(requestUrl: string): string {
  return serializeCookie(GITHUB_OAUTH_STATE_COOKIE, "", {
    maxAge: 0,
    path: "/v1/auth/github",
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookie(requestUrl),
  });
}

export async function timingSafeEqual(actual: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!actual || !expected) return false;
  const [left, right] = await Promise.all([sha256Bytes(actual), sha256Bytes(expected)]);
  let diff = left.length ^ right.length;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return diff === 0;
}

export async function hashToken(token: string): Promise<string> {
  return bytesToHex(await sha256Bytes(token));
}

export function createOpaqueToken(prefix = "gts"): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${bytesToHex(bytes)}`;
}

export async function authenticatePrivateToken(env: Env, token: string | undefined): Promise<AuthIdentity | null> {
  if (!token) return null;
  if (await timingSafeEqual(token, nonBlank(env.LOOPOVER_API_TOKEN))) return { kind: "static", actor: "api" };
  // Checked before the general LOOPOVER_MCP_TOKEN: a distinct, higher-privilege credential (#7721) so a leaked
  // ordinary MCP token can never reach the admin config-write tools, which gate on actor === "mcp-admin"
  // specifically. Order doesn't change behavior here (the two secrets are never equal in a real deployment),
  // but checking the more-privileged token first keeps this function reading top-to-bottom by privilege.
  if (await timingSafeEqual(token, nonBlank(env.LOOPOVER_MCP_ADMIN_TOKEN))) return { kind: "static", actor: "mcp-admin" };
  if (await timingSafeEqual(token, nonBlank(env.LOOPOVER_MCP_TOKEN))) return { kind: "static", actor: "mcp" };
  return authenticateSessionToken(env, token);
}

export async function authenticateInternalToken(env: Env, token: string | undefined): Promise<AuthIdentity | null> {
  if (await timingSafeEqual(token, env.INTERNAL_JOB_TOKEN)) return { kind: "static", actor: "internal" };
  return null;
}

export async function authenticateSessionToken(env: Env, token: string | undefined): Promise<AuthIdentity | null> {
  if (!token) return null;
  const session = await getAuthSessionByTokenHash(env, await hashToken(token));
  if (!session) return null;
  // Fail closed on an unparseable expiry: Date.parse → NaN makes `NaN <= Date.now()` false, which would
  // otherwise authenticate a session whose stored expires_at is malformed/empty as if it never expired.
  const expiresAtMs = Date.parse(session.expiresAt);
  if (session.revokedAt || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
  await touchAuthSession(env, session.id);
  return { kind: "session", actor: session.login, session };
}

export function isAuthorizedGitHubSessionLogin(env: Env, login: string): boolean {
  const allowedLogins = parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS);
  if (allowedLogins.size === 0) return false;
  return allowedLogins.has(login.toLowerCase());
}

/** #4889 hosted per-repo admin mode. When ON, the global ADMIN_GITHUB_LOGINS allowlist stops granting
 *  fleet-wide maintainer trust at the review/queue exemption sites — each consults the live per-repo GitHub
 *  permission instead ({@link isPerTenantAdmin}). OFF (the default) keeps self-host's existing
 *  global-allowlist behavior byte-identical. Truthy convention matches isOpsEnabled (ops-wire.ts). */
export function isPerRepoAdminModeEnabled(env: { LOOPOVER_PER_REPO_ADMIN?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_PER_REPO_ADMIN ?? "").trim());
}

/** Injectable seam for {@link isPerTenantAdmin}'s live lookup (tests; production callers omit it). Matches
 *  getRepositoryCollaboratorPermission's shape (src/github/app.ts). */
export type PerTenantAdminPermissionFetch = (
  env: Env,
  installationId: number,
  repoFullName: string,
  login: string,
) => Promise<string | null>;

/**
 * #4889: whether `login` holds admin trust for THIS repo — the hosted replacement for a bare
 * `parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(login)` at the exemption sites.
 *
 * - Per-repo admin mode OFF (self-host default): exact ADMIN_GITHUB_LOGINS membership, unchanged semantics.
 * - Mode ON (hosted): GitHub's real-time collaborator permission on `repoFullName` — `admin`/`maintain`
 *   passes, anything else denies. Fail-CLOSED: no installation to ask through, a lookup error, or an
 *   unknown collaborator all deny — an API blip must never silently grant fleet-operator trust (#4889's
 *   explicit safety guardrail). The repo-owner shortcut stays at the call sites (it predates and is
 *   independent of the allowlist this replaces).
 */
export async function isPerTenantAdmin(
  env: Env,
  installationId: number | null,
  repoFullName: string,
  login: string,
  getPermission?: PerTenantAdminPermissionFetch,
): Promise<boolean> {
  const normalized = login.trim().toLowerCase();
  if (!normalized) return false;
  if (!isPerRepoAdminModeEnabled(env)) return parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(normalized);
  if (installationId === null) return false;
  let permission: string | null;
  try {
    const fetchPermission = getPermission ?? (await import("../github/app")).getRepositoryCollaboratorPermission;
    permission = await fetchPermission(env, installationId, repoFullName, normalized);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "per_tenant_admin_check_failed",
        repoFullName,
        login: normalized,
        message: error instanceof Error ? error.message.slice(0, 150) : String(error).slice(0, 150),
      }),
    );
    return false;
  }
  return permission === "admin" || permission === "maintain";
}

/** Parse a GitHub-login allowlist env (e.g. ADMIN_GITHUB_LOGINS) into a lowercased Set. Splits on whitespace OR
 *  commas so every caller agrees on the same parse (#audit-3.13). */
export function parseGitHubLoginList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(/[\s,]+/)
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Shared CSV/whitespace allowlist parse for the MCP repo-allowlist env vars — both the actuation (write) and
 *  read allowlists use the identical fail-closed/wildcard parsing, just gate a different security boundary at
 *  their respective call sites. */
function parseMcpRepoAllowlistEntries(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Does an allowlist value grant `repoFullName`? Unset/empty ⇒ deny (fail closed). `*`/`all` ⇒ every repo, an
 *  explicit escape hatch for an operator who wants unscoped trust. */
function matchesMcpRepoAllowlist(value: string | undefined, repoFullName: string): boolean {
  const entries = parseMcpRepoAllowlistEntries(value);
  if (entries.length === 0) return false;
  if (entries.includes("*") || entries.includes("all")) return true;
  return entries.includes(repoFullName.toLowerCase());
}

/** Is `repoFullName` within the operator's MCP_ACTUATION_REPO_ALLOWLIST? The static `mcp` identity is minted from
 *  a single shared secret (LOOPOVER_MCP_TOKEN) that is documented as an ordinary end-user CLI credential — unlike
 *  `api`/`internal`, it is not operator-only, so unlike those it must NOT be unconditionally trusted for every
 *  installed repo. Unset/empty ⇒ deny (fail closed: an operator must explicitly opt a repo in). `*`/`all` ⇒ every
 *  repo, an explicit escape hatch for an operator who wants the old unscoped-trust behavior. (#2253) */
export function isMcpActuationRepoAllowed(value: string | undefined, repoFullName: string): boolean {
  return matchesMcpRepoAllowlist(value, repoFullName);
}

/** Is `repoFullName` within the operator's MCP_READ_REPO_ALLOWLIST? Same fail-closed/wildcard model as
 *  isMcpActuationRepoAllowed, kept as a SEPARATE allowlist so an operator can grant broad read access without
 *  also granting actuation (merge/close/approve) trust, or the reverse. Gates the static `mcp` identity's
 *  read-only MCP tools: repo context, issue quality, watch subscriptions, and (via isMcpReadUnscoped below) the
 *  non-repo-scoped contributor/operator tools. (#2455) */
export function isMcpReadRepoAllowed(value: string | undefined, repoFullName: string): boolean {
  return matchesMcpRepoAllowlist(value, repoFullName);
}

/** Is MCP_READ_REPO_ALLOWLIST set to the full `*`/`all` wildcard? Contributor-login-scoped tools (another
 *  contributor's decision pack/profile/notifications) and operator-scoped tools (fleet analytics) have no single
 *  repo to check a scoped allowlist entry against, so — unlike the repo-scoped read tools above — they only
 *  unlock for the static `mcp` identity via the full wildcard opt-in: a repo-scoped allowlist does not imply a
 *  right to read an ARBITRARY other contributor's private data or cross-instance operator-only analytics. (#2455) */
export function isMcpReadUnscoped(value: string | undefined): boolean {
  const entries = parseMcpRepoAllowlistEntries(value);
  return entries.includes("*") || entries.includes("all");
}

type CookieOptions = {
  maxAge: number;
  path: string;
  httpOnly: boolean;
  sameSite: "Lax" | "Strict" | "None";
  secure: boolean;
};

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export const __securityInternals = {
  serializeCookie,
};

function shouldUseSecureCookie(requestUrl: string): boolean {
  try {
    const hostname = new URL(requestUrl).hostname;
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "[::1]";
  } catch {
    return true;
  }
}

export async function createSessionForGitHubUser(
  env: Env,
  user: { login: string; id?: number | null },
  // `githubToken` (#6114): the raw GitHub user-to-server token this session's login exchange minted, if any.
  // Persisted encrypted so a CLI/AMS process can fetch it later (see storeSessionGitHubToken) -- NEVER placed
  // in `metadata` (that's a plaintext JSON blob) or otherwise logged/audited alongside this session.
  // `githubTokenExpiresAt`/`githubRefreshToken`/`githubRefreshTokenExpiresAt` (#6115): only known when the
  // login exchange went through our own device/web OAuth flow -- absent for the caller-supplied-token path.
  options: {
    scopes?: string[];
    metadata?: Record<string, JsonValue>;
    githubToken?: string;
    githubTokenExpiresAt?: string | null | undefined;
    githubRefreshToken?: string | null | undefined;
    githubRefreshTokenExpiresAt?: string | null | undefined;
  } = {},
): Promise<{ token: string; session: AuthSessionRecord }> {
  const token = createOpaqueToken();
  const issuedAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  const session: AuthSessionRecord = {
    id: crypto.randomUUID(),
    tokenHash: await hashToken(token),
    login: user.login,
    githubUserId: user.id,
    scopes: options.scopes ?? [],
    expiresAt,
    createdAt: issuedAt,
    lastSeenAt: issuedAt,
    metadata: options.metadata ?? {},
  };
  await createAuthSession(env, session);
  if (options.githubToken) {
    await storeSessionGitHubToken(env, session.id, options.githubToken, {
      expiresAt: options.githubTokenExpiresAt,
      refreshToken: options.githubRefreshToken,
      refreshExpiresAt: options.githubRefreshTokenExpiresAt,
    });
  }
  await recordAuditEvent(env, {
    eventType: "auth.session_created",
    actor: user.login,
    outcome: "success",
    metadata: { scopes: session.scopes, githubUserId: user.id ?? null },
  });
  return { token, session };
}

export async function revokeSession(env: Env, identity: AuthIdentity | null): Promise<boolean> {
  if (!identity || identity.kind !== "session") return false;
  await revokeAuthSession(env, identity.session.id);
  await recordAuditEvent(env, {
    eventType: "auth.session_revoked",
    actor: identity.actor,
    outcome: "success",
  });
  return true;
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
