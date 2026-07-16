// GitHub-token resolution for AMS's git operations (#6116). Precedence: an explicit GITHUB_TOKEN env
// override always wins (a self-host operator's existing PAT setup keeps working, unchanged) -- otherwise,
// fetch a live token from the authenticated loopover-mcp session (POST /v1/auth/github/token, #6114/#6115),
// so `loopover-mcp login` alone becomes sufficient to run AMS against a repo the user has access to.
//
// Deliberately reimplements loopover-mcp's own config-file read here rather than depending on @loopover/mcp
// as a package: @loopover/miner and @loopover/mcp are separately-installable CLIs (the whole point of this
// milestone is that installing the GitHub App doesn't require BOTH), and a hard runtime dependency between
// them would mean installing one always pulls in the other just to read a config file format neither
// package publishes as a stable API. This mirrors loopover-mcp/bin/loopover-mcp.js's own configPath/
// selectProfileName/apiUrl resolution logic (kept in sync by hand -- there is no shared module to import).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_API_URL = "https://api.loopover.ai";
const LEGACY_DEFAULT_API_URLS = new Set([
  "https://gittensory-api.zeronode.workers.dev",
  "https://gittensory-api.aethereal.dev",
]);
const DEFAULT_PROFILE_NAME = "default";
const GITHUB_TOKEN_FETCH_TIMEOUT_MS = 10_000;

function loopoverConfigPath(env) {
  if (env.LOOPOVER_CONFIG_PATH) return env.LOOPOVER_CONFIG_PATH;
  if (env.LOOPOVER_CONFIG_DIR) return join(env.LOOPOVER_CONFIG_DIR, "config.json");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "loopover", "config.json");
}

function loadLoopoverConfig(env) {
  const configPath = loopoverConfigPath(env);
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Only ever called with an already-truthy candidate name (see selectProfileName below) -- no nullish
// fallback needed here, since a nullish/empty `value` never reaches this function in the first place.
function normalizeProfileName(value) {
  const name = String(value).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? name : DEFAULT_PROFILE_NAME;
}

// Mirrors loopover-mcp's own selectProfileName: an explicit request wins, else the config's own
// activeProfile (only if it names a real profile entry), else "default".
function selectProfileName(config, requestedName) {
  if (requestedName) return normalizeProfileName(requestedName);
  const configured = config.activeProfile ? normalizeProfileName(config.activeProfile) : DEFAULT_PROFILE_NAME;
  return config.profiles?.[configured] ? configured : DEFAULT_PROFILE_NAME;
}

function activeLoopoverProfile(env) {
  const config = loadLoopoverConfig(env);
  const profileName = selectProfileName(config, env.LOOPOVER_PROFILE);
  return config.profiles?.[profileName] ?? {};
}

function loopoverSessionToken(env) {
  const token = activeLoopoverProfile(env).session?.token;
  return typeof token === "string" && token ? token : null;
}

function loopoverApiUrl(env) {
  if (env.LOOPOVER_API_URL) return env.LOOPOVER_API_URL.replace(/\/+$/, "");
  const profileApiUrl = activeLoopoverProfile(env).apiUrl;
  if (typeof profileApiUrl === "string" && profileApiUrl.trim()) {
    const normalized = profileApiUrl.replace(/\/+$/, "");
    if (!LEGACY_DEFAULT_API_URLS.has(normalized)) return normalized;
  }
  return DEFAULT_API_URL;
}

/**
 * Same loopover-mcp session + API URL posture `resolveGitHubToken` uses for backend calls (#6487).
 * Returns null when there is no session token on disk (fully-standalone AMS / no `loopover-mcp login`).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ apiUrl: string, sessionToken: string } | null}
 */
export function resolveLoopoverBackendSession(env = process.env) {
  const sessionToken = loopoverSessionToken(env);
  if (!sessionToken) return null;
  return { apiUrl: loopoverApiUrl(env), sessionToken };
}

async function fetchLiveGitHubTokenFromSession(sessionToken, apiUrl, fetchImpl) {
  try {
    const response = await fetchImpl(`${apiUrl}/v1/auth/github/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(GITHUB_TOKEN_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    return typeof payload?.token === "string" && payload.token ? payload.token : null;
  } catch {
    return null;
  }
}

// Process-lifetime cache of a SUCCESSFUL resolution only. A failure (no session, expired session, transient
// network error) is deliberately NOT cached -- it's retried on the next call instead, so a long-running AMS
// process can self-heal from a transient blip rather than being stuck treating the token as permanently
// unavailable for its entire remaining lifetime.
let cachedToken;

/**
 * Resolve a GitHub token for AMS's git operations (#6116). Returns null when nothing is available: no
 * GITHUB_TOKEN override, no loopover-mcp session on disk, or the session-token fetch fails for any reason --
 * callers already treat a missing token as "git operations requiring auth will fail," the same failure mode
 * as before this feature existed.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ fetchImpl?: import("./github-token-resolution.d.ts").GitHubTokenResolutionFetch }} [options]
 * @returns {Promise<string | null>}
 */
export async function resolveGitHubToken(env = process.env, options = {}) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (cachedToken) return cachedToken;
  const sessionToken = loopoverSessionToken(env);
  if (!sessionToken) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const fetched = await fetchLiveGitHubTokenFromSession(sessionToken, loopoverApiUrl(env), fetchImpl);
  if (fetched) cachedToken = fetched;
  return fetched;
}

/** Test-only: clear the process-lifetime cache so one test's resolution can't leak into the next. */
export function resetGitHubTokenResolutionForTesting() {
  cachedToken = undefined;
}

/**
 * Offline-only check: does resolveGitHubToken have ANYTHING to try (a GITHUB_TOKEN override, or a
 * loopover-mcp session recorded on disk), without making the network call resolveGitHubToken itself would
 * make to actually verify it still works. For `doctor`/`status`-style diagnostics (status.js's
 * checkGitHubTokenPresent), which are deliberately offline-only -- a genuinely expired or revoked session
 * still reports "present" here; only an actual attempt (or resolveGitHubToken itself) discovers that.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function hasGitHubTokenSource(env = process.env) {
  return Boolean(env.GITHUB_TOKEN) || Boolean(loopoverSessionToken(env));
}
