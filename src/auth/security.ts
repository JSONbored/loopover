import {
  createAuthSession,
  getAuthSessionByTokenHash,
  recordAuditEvent,
  revokeAuthSession,
  touchAuthSession,
} from "../db/repositories";
import type { AuthSessionRecord, JsonValue } from "../types";
import { nowIso } from "../utils/json";

export type AuthIdentity =
  | { kind: "static"; actor: "api" | "mcp" | "internal" }
  | { kind: "session"; actor: string; session: AuthSessionRecord };

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const BROWSER_SESSION_COOKIE = "gittensory_session";
export const GITHUB_OAUTH_STATE_COOKIE = "gittensory_oauth_state";
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
  if (await timingSafeEqual(token, env.GITTENSORY_API_TOKEN)) return { kind: "static", actor: "api" };
  if (await timingSafeEqual(token, env.GITTENSORY_MCP_TOKEN)) return { kind: "static", actor: "mcp" };
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

/** Is `repoFullName` within the operator's MCP_ACTUATION_REPO_ALLOWLIST? The static `mcp` identity is minted from
 *  a single shared secret (GITTENSORY_MCP_TOKEN) that is documented as an ordinary end-user CLI credential — unlike
 *  `api`/`internal`, it is not operator-only, so unlike those it must NOT be unconditionally trusted for every
 *  installed repo. Unset/empty ⇒ deny (fail closed: an operator must explicitly opt a repo in). `*`/`all` ⇒ every
 *  repo, an explicit escape hatch for an operator who wants the old unscoped-trust behavior. (#2253) */
export function isMcpActuationRepoAllowed(value: string | undefined, repoFullName: string): boolean {
  const entries = (value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return false;
  if (entries.includes("*") || entries.includes("all")) return true;
  return entries.includes(repoFullName.toLowerCase());
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
  options: { scopes?: string[]; metadata?: Record<string, JsonValue> } = {},
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
