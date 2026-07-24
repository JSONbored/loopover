import {
  GITHUB_OAUTH_STATE_TTL_SECONDS,
  createOpaqueToken,
  createSessionForGitHubUser,
  timingSafeEqual,
} from "./security";
import { getDecryptedSessionGitHubTokenBundle, recordAuditEvent, storeSessionGitHubToken } from "../db/repositories";
import { PRODUCT_USER_AGENT, timeoutFetch } from "../github/client";
import type { JsonValue } from "../types";

type GitHubDeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
};

// `expires_in`/`refresh_token`/`refresh_token_expires_in` (#6115) are only present when the App owner has
// user-to-server token expiration enabled -- the default for a GitHub App unless explicitly opted out
// (GitHub's own docs: "Refreshing user access tokens"). Absent when expiration is disabled, so every reader
// of these fields must treat them as optional, not assume presence.
type GitHubAccessTokenResponse =
  | { access_token: string; token_type?: string; scope?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number }
  | { error: string; error_description?: string };

type GitHubUserResponse = {
  login?: string;
  id?: number;
  message?: string;
};

type GitHubAppTokenCheck = {
  app?: { client_id?: string };
};

type GitHubWebOAuthState = {
  nonce: string;
  returnTo: string;
  exp: number;
};

export async function startGitHubDeviceFlow(env: Env): Promise<GitHubDeviceCodeResponse> {
  if (!env.GITHUB_OAUTH_CLIENT_ID) throw new Error("github_oauth_not_configured");
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": PRODUCT_USER_AGENT,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      scope: "read:user",
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<GitHubDeviceCodeResponse> & { error?: string; error_description?: string };
  if (!response.ok || payload.error) throw new Error(payload.error_description ?? payload.error ?? "github_device_flow_start_failed");
  if (!payload.device_code || !payload.user_code || !payload.verification_uri || !payload.expires_in) throw new Error("github_device_flow_response_invalid");
  return {
    device_code: payload.device_code,
    user_code: payload.user_code,
    verification_uri: payload.verification_uri,
    expires_in: payload.expires_in,
    ...(payload.interval === undefined ? {} : { interval: payload.interval }),
  };
}

export async function pollGitHubDeviceFlow(env: Env, deviceCode: string) {
  if (!env.GITHUB_OAUTH_CLIENT_ID) throw new Error("github_oauth_not_configured");
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": PRODUCT_USER_AGENT,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as GitHubAccessTokenResponse;
  if ("error" in tokenPayload) {
    // #8378: `authorization_pending`/`slow_down` are RFC 8628's routine "still waiting on the browser step"
    // responses — a single successful login polls this dozens of times — so they are not audit-worthy at all
    // (auditing them as `denied` buried the one row that matters under ~180 rows of in-progress noise).
    // `access_denied` IS the genuine user rejection and is the only `denied` here, matching how the sibling
    // web-OAuth callback (routes.ts) treats an OAuth `error` param; every other terminal code stays `error`.
    if (tokenPayload.error !== "authorization_pending" && tokenPayload.error !== "slow_down") {
      await recordAuditEvent(env, {
        eventType: "auth.github_device_poll",
        outcome: tokenPayload.error === "access_denied" ? "denied" : "error",
        detail: tokenPayload.error,
      });
    }
    return {
      status: tokenPayload.error,
      message: tokenPayload.error_description,
    };
  }
  if (!tokenPayload.access_token) throw new Error("github_access_token_missing");
  const lifecycle = tokenLifecycleFromResponse(tokenPayload);
  return createSessionFromGitHubToken(
    env,
    tokenPayload.access_token,
    { source: "github_device_flow", scopes: parseScopes(tokenPayload.scope) },
    { tokenExpiresAt: lifecycle.expiresAt, refreshToken: lifecycle.refreshToken, refreshTokenExpiresAt: lifecycle.refreshExpiresAt },
  );
}

/**
 * Starts the GitHub web OAuth flow. `scope` defaults to `"read:user"` (the standard login flow) — pass
 * `"read:user repo"` only for the explicit APR idea-submission variant (#7637) that needs to create a repo
 * under the customer's own account later; every other caller keeps requesting `read:user` unchanged.
 */
export async function startGitHubWebOAuth(
  env: Env,
  requestUrl: string,
  returnTo: string | undefined,
  scope: string = "read:user",
): Promise<{ state: string; authorizationUrl: string; returnTo: string }> {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) throw new Error("github_oauth_not_configured");
  const safeReturnTo = normalizeReturnTo(env, returnTo);
  const state = await signOAuthState(env, {
    nonce: createOpaqueToken("oauth"),
    returnTo: safeReturnTo,
    exp: Math.floor(Date.now() / 1000) + GITHUB_OAUTH_STATE_TTL_SECONDS,
  });
  const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
  authorizationUrl.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", githubOAuthCallbackUrl(env, requestUrl));
  authorizationUrl.searchParams.set("scope", scope);
  authorizationUrl.searchParams.set("state", state);
  return { state, authorizationUrl: authorizationUrl.toString(), returnTo: safeReturnTo };
}

export async function completeGitHubWebOAuth(
  env: Env,
  requestUrl: string,
  args: { code: string; state: string; cookieState: string | undefined },
): Promise<{ token: string; login: string; expiresAt: string; scopes: string[]; returnTo: string }> {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) throw new Error("github_oauth_not_configured");
  if (!args.cookieState || !(await timingSafeEqual(args.state, args.cookieState))) throw new Error("github_oauth_state_invalid");
  const state = await verifyOAuthState(env, args.state);
  if (!state) throw new Error("github_oauth_state_invalid");
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": PRODUCT_USER_AGENT,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code: args.code,
      redirect_uri: githubOAuthCallbackUrl(env, requestUrl),
    }),
  });
  const tokenPayload = (await response.json().catch(() => ({}))) as GitHubAccessTokenResponse;
  if (!response.ok || "error" in tokenPayload) {
    await recordAuditEvent(env, {
      eventType: "auth.github_web_callback",
      outcome: "error",
      detail: "error" in tokenPayload ? tokenPayload.error : "github_oauth_token_exchange_failed",
    });
    throw new Error("error" in tokenPayload ? (tokenPayload.error_description ?? tokenPayload.error) : "github_oauth_token_exchange_failed");
  }
  if (!tokenPayload.access_token) throw new Error("github_access_token_missing");
  const lifecycle = tokenLifecycleFromResponse(tokenPayload);
  const session = await createSessionFromGitHubToken(
    env,
    tokenPayload.access_token,
    { source: "github_web_oauth", stateNonce: state.nonce, scopes: parseScopes(tokenPayload.scope) },
    { tokenExpiresAt: lifecycle.expiresAt, refreshToken: lifecycle.refreshToken, refreshTokenExpiresAt: lifecycle.refreshExpiresAt },
  );
  await recordAuditEvent(env, {
    eventType: "auth.github_web_callback",
    actor: session.login,
    outcome: "success",
  });
  return { ...session, returnTo: state.returnTo };
}

export async function createSessionFromGitHubToken(
  env: Env,
  githubToken: string,
  metadata: Record<string, JsonValue> = {},
  // `tokenExpiresAt`/`refreshToken`/`refreshTokenExpiresAt` (#6115): only known when the caller (the device/web
  // OAuth flows below) minted `githubToken` itself via our own exchange -- absent for a caller-supplied token
  // (the /v1/auth/github/session route), which has no lifecycle info to offer.
  options: { verifyAppAudience?: boolean; tokenExpiresAt?: string | null; refreshToken?: string | null; refreshTokenExpiresAt?: string | null } = {},
): Promise<{ token: string; login: string; expiresAt: string; scopes: string[] }> {
  // A caller-supplied token (the github_token_exchange route) carries no proof it was minted for THIS
  // OAuth app. Without an audience check, any token a victim issued to an unrelated app would mint a
  // loopover session as that login. The device/web flows skip this — they minted the token themselves.
  if (options.verifyAppAudience && !(await verifyTokenBelongsToApp(env, githubToken))) {
    await recordAuditEvent(env, {
      eventType: "auth.github_session",
      outcome: "denied",
      detail: "github_token_audience_mismatch",
    });
    throw new Error("github_token_audience_invalid");
  }
  const response = await timeoutFetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubToken}`,
      "user-agent": PRODUCT_USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
  });
  const user = (await response.json().catch(() => ({}))) as GitHubUserResponse;
  if (!response.ok || !user.login) {
    await recordAuditEvent(env, {
      eventType: "auth.github_session",
      outcome: "denied",
      detail: user.message ?? "github_user_validation_failed",
    });
    throw new Error("github_user_validation_failed");
  }
  const scopes = Array.isArray(metadata.scopes) ? metadata.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const githubUser = user.id === undefined ? { login: user.login } : { login: user.login, id: user.id };
  // #6114: the caller already just used `githubToken` for the identity check above -- pass it through so
  // it's persisted for later AMS git-operation use, instead of discarding it once identity is confirmed.
  const { token, session } = await createSessionForGitHubUser(env, githubUser, {
    scopes,
    metadata,
    githubToken,
    githubTokenExpiresAt: options.tokenExpiresAt,
    githubRefreshToken: options.refreshToken,
    githubRefreshTokenExpiresAt: options.refreshTokenExpiresAt,
  });
  return { token, login: session.login, expiresAt: session.expiresAt, scopes: session.scopes };
}

// Confirms an access token was issued for this OAuth app via GitHub's token-introspection endpoint
// (POST /applications/{client_id}/token, Basic client_id:client_secret). Fail-closed: if the app
// isn't configured, the token can't be vouched for, so it is rejected.
async function verifyTokenBelongsToApp(env: Env, githubToken: string): Promise<boolean> {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return false;
  const response = await timeoutFetch(`https://api.github.com/applications/${env.GITHUB_OAUTH_CLIENT_ID}/token`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Basic ${btoa(`${env.GITHUB_OAUTH_CLIENT_ID}:${env.GITHUB_OAUTH_CLIENT_SECRET}`)}`,
      "content-type": "application/json",
      "user-agent": PRODUCT_USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ access_token: githubToken }),
  });
  if (!response.ok) return false;
  const payload = (await response.json().catch(() => ({}))) as GitHubAppTokenCheck;
  return payload.app?.client_id === env.GITHUB_OAUTH_CLIENT_ID;
}

function parseScopes(scopeHeader: string | undefined): string[] {
  return (scopeHeader ?? "")
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

// #6115: turn a raw GitHub token-exchange response's expires_in/refresh_token/refresh_token_expires_in
// (relative seconds-from-now, when present at all) into the absolute ISO timestamps this codebase's own
// convention stores everywhere else (mirrors src/orb/broker.ts's own minted.expiresAt shape).
function tokenLifecycleFromResponse(payload: { expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number }): {
  expiresAt: string | null;
  refreshToken: string | null;
  refreshExpiresAt: string | null;
} {
  return {
    expiresAt: typeof payload.expires_in === "number" ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : null,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    refreshExpiresAt: typeof payload.refresh_token_expires_in === "number" ? new Date(Date.now() + payload.refresh_token_expires_in * 1000).toISOString() : null,
  };
}

// A stored access token is refreshed once it has less than this much time left, not right at the edge --
// AMS's own token-resolution (#6116) fetches once per process start and caches in memory for that process's
// lifetime, so a request landing with only seconds of headroom would otherwise fail mid-use. Generous relative
// to the 8h default lifetime; the cost is at most one extra GitHub round-trip per near-expiry fetch.
const GITHUB_TOKEN_REFRESH_MARGIN_MS = 15 * 60_000;

/**
 * Resolve a currently-LIVE GitHub token for a session, transparently refreshing via the stored refresh_token
 * when the access token is near/past expiry (#6115). Falls back to the (possibly stale) access token as-is
 * when there's no expiry on record (a #6114-era row, or an exchange that never returned expires_in -- treated
 * as "never expires" for backward compatibility) or no refresh_token is available. Returns null when nothing
 * usable remains: no token was ever stored, decryption fails, the refresh token itself is expired, or the
 * refresh attempt fails and a concurrent request's own refresh (rotating the SAME refresh token, per GitHub's
 * one-time-use-then-rotate contract) hasn't landed either -- callers already treat a null token as
 * "unavailable, fall back to a manual PAT."
 */
export async function getLiveSessionGitHubToken(env: Env, sessionId: string): Promise<string | null> {
  const bundle = await getDecryptedSessionGitHubTokenBundle(env, sessionId);
  if (!bundle) return null;

  const expiresAtMs = bundle.expiresAt ? Date.parse(bundle.expiresAt) : NaN;
  const hasKnownExpiry = Number.isFinite(expiresAtMs);
  if (!hasKnownExpiry || expiresAtMs - Date.now() >= GITHUB_TOKEN_REFRESH_MARGIN_MS) return bundle.accessToken;

  if (!bundle.refreshToken) return bundle.accessToken; // near/past expiry, but nothing to refresh WITH -- best effort.
  const refreshExpiresAtMs = bundle.refreshExpiresAt ? Date.parse(bundle.refreshExpiresAt) : NaN;
  if (Number.isFinite(refreshExpiresAtMs) && refreshExpiresAtMs <= Date.now()) return null; // dead end: re-login required.

  try {
    const refreshed = await refreshGitHubUserToken(env, bundle.refreshToken);
    await storeSessionGitHubToken(env, sessionId, refreshed.accessToken, {
      expiresAt: refreshed.expiresAt,
      refreshToken: refreshed.refreshToken,
      refreshExpiresAt: refreshed.refreshExpiresAt,
    });
    return refreshed.accessToken;
  } catch {
    // The refresh token GitHub issues is single-use-then-rotated: a concurrent request racing this one may
    // have already refreshed (consuming the same refresh token this attempt just failed with). Re-read once
    // rather than fail outright -- if the OTHER request's refresh already landed, its result is exactly as
    // usable as if this call had won the race itself.
    const retried = await getDecryptedSessionGitHubTokenBundle(env, sessionId);
    return retried && retried.accessToken !== bundle.accessToken ? retried.accessToken : null;
  }
}

/** Exchange a session's stored refresh_token for a fresh access token (#6115). Mirrors the initial
 *  code/device-code exchanges below -- same endpoint, `grant_type: "refresh_token"` instead. */
async function refreshGitHubUserToken(
  env: Env,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: string | null; refreshToken: string | null; refreshExpiresAt: string | null }> {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) throw new Error("github_oauth_not_configured");
  const response = await timeoutFetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": PRODUCT_USER_AGENT,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as GitHubAccessTokenResponse;
  if (!response.ok || "error" in payload || !payload.access_token) throw new Error("github_refresh_failed");
  return { accessToken: payload.access_token, ...tokenLifecycleFromResponse(payload) };
}

function githubOAuthCallbackUrl(env: Env, requestUrl: string): string {
  const origin = env.PUBLIC_API_ORIGIN ?? new URL(requestUrl).origin;
  return `${origin.replace(/\/$/, "")}/v1/auth/github/callback`;
}

function normalizeReturnTo(env: Env, value: string | undefined): string {
  const siteOrigin = env.PUBLIC_SITE_ORIGIN ?? "https://loopover.ai";
  const fallback = `${siteOrigin.replace(/\/$/, "")}/app`;
  if (!value) return fallback;
  try {
    const url = new URL(value, siteOrigin);
    // siteOrigin already IS "https://loopover.ai" when PUBLIC_SITE_ORIGIN is unset (the fallback
    // two lines up), so a separate hardcoded entry here was dead weight once a self-hoster sets their own
    // PUBLIC_SITE_ORIGIN -- it kept accepting the cloud origin as a valid redirect target even for a self-host
    // instance that never uses it (#4615). Rely solely on siteOrigin.
    const aliasOrigins = (env.PUBLIC_SITE_ORIGIN_ALIASES ?? "")
      .split(",")
      .map((alias) => alias.trim().replace(/\/$/, ""))
      .filter(Boolean);
    const allowedOrigins = new Set([
      siteOrigin.replace(/\/$/, ""),
      ...aliasOrigins,
      "http://localhost:3000",
      "http://localhost:4173",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:4173",
      "http://127.0.0.1:5173",
    ]);
    return allowedOrigins.has(url.origin) ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

async function signOAuthState(env: Env, payload: GitHubWebOAuthState): Promise<string> {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(oauthStateSecret(env), encoded);
  return `${encoded}.${signature}`;
}

async function verifyOAuthState(env: Env, state: string): Promise<GitHubWebOAuthState | null> {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) return null;
  const expected = await hmacSha256(oauthStateSecret(env), encoded);
  if (!(await timingSafeEqual(signature, expected))) return null;
  const payload = parseOAuthStatePayload(encoded);
  if (!payload || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return { ...payload, returnTo: normalizeReturnTo(env, payload.returnTo) };
}

function parseOAuthStatePayload(encoded: string): GitHubWebOAuthState | null {
  try {
    const payload = JSON.parse(base64UrlDecode(encoded)) as Partial<GitHubWebOAuthState>;
    if (typeof payload.nonce !== "string" || typeof payload.returnTo !== "string" || typeof payload.exp !== "number") return null;
    return { nonce: payload.nonce, returnTo: payload.returnTo, exp: payload.exp };
  } catch {
    return null;
  }
}

function oauthStateSecret(env: Env): string {
  if (!env.GITHUB_OAUTH_CLIENT_SECRET) throw new Error("github_oauth_not_configured");
  return env.GITHUB_OAUTH_CLIENT_SECRET;
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function base64UrlEncode(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlDecode(value: string): string {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
