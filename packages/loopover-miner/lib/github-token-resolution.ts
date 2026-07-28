// GitHub-token resolution for AMS's git operations (#6116). Precedence: an explicit GITHUB_TOKEN env
// override always wins (a self-host operator's existing PAT setup keeps working, unchanged) -- otherwise,
// fetch a live token from the authenticated loopover-mcp session (POST /v1/auth/github/token, #6114/#6115),
// so `loopover-mcp login` alone becomes sufficient to run AMS against a repo the user has access to.
//
// The config/profile/apiUrl/session resolution this needs used to be hand-copied from loopover-mcp's own
// bin, because @loopover/miner and @loopover/mcp are separately-installable CLIs and neither publishes the
// config format as a stable API. It now imports @loopover/contract/local-config (#9521), which both
// packages already depend on -- so the hand-sync, and the drift it invited, are gone.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROFILE_NAME,
  canonicalProfileName,
  loopoverConfigPath,
  parseLoopoverConfig,
  profileSessionToken,
  resolveLoopoverApiUrl,
  type LoopoverConfig,
  type LoopoverConfigProfile,
} from "@loopover/contract/local-config";

// A narrower shape than `typeof fetch` on purpose: this module only ever calls it with a string URL and a
// plain init object, and the ambient `fetch` type in this repo's TS program is Cloudflare-Workers-flavored
// (RequestInfo<CfProperties> | URL), which is both irrelevant here (this package runs under plain Node) and
// stricter than any real caller needs -- same rationale as live-issue-snapshot.js's own LiveIssueSnapshotFetch.
export type GitHubTokenResolutionFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

const GITHUB_TOKEN_FETCH_TIMEOUT_MS = 10_000;

// The miner only READS the config, so an unusable profile name degrades to "default" here rather than
// throwing the way loopover-mcp's own writer does -- `loopover-mcp login` is where a bad name gets
// rejected, and refusing to start AMS over one would be a worse failure than falling back.
function readLoopoverConfig(env: NodeJS.ProcessEnv): LoopoverConfig {
  const configPath = loopoverConfigPath(env, { join, homeDir: homedir });
  if (!existsSync(configPath)) return {};
  try {
    return parseLoopoverConfig(readFileSync(configPath, "utf8"));
  } catch {
    // An unreadable file (permissions, a directory in its place) is the same "no config" state as an
    // absent one -- parseLoopoverConfig already absorbs malformed contents.
    return {};
  }
}

function selectProfileName(config: LoopoverConfig, requestedName: string | undefined): string {
  if (requestedName) return canonicalProfileName(requestedName) ?? DEFAULT_PROFILE_NAME;
  const configured = config.activeProfile ? (canonicalProfileName(config.activeProfile) ?? DEFAULT_PROFILE_NAME) : DEFAULT_PROFILE_NAME;
  return config.profiles?.[configured] ? configured : DEFAULT_PROFILE_NAME;
}

function activeLoopoverProfile(env: NodeJS.ProcessEnv): LoopoverConfigProfile {
  const config = readLoopoverConfig(env);
  return config.profiles?.[selectProfileName(config, env.LOOPOVER_PROFILE)] ?? {};
}

function loopoverSessionToken(env: NodeJS.ProcessEnv): string | null {
  return profileSessionToken(activeLoopoverProfile(env));
}

function loopoverApiUrl(env: NodeJS.ProcessEnv): string {
  return resolveLoopoverApiUrl(env, readLoopoverConfig(env), activeLoopoverProfile(env));
}

/**
 * Same loopover-mcp session + API URL posture `resolveGitHubToken` uses for backend calls (#6487).
 * Returns null when there is no session token on disk (fully-standalone AMS / no `loopover-mcp login`).
 */
export function resolveLoopoverBackendSession(
  env: NodeJS.ProcessEnv = process.env,
): { apiUrl: string; sessionToken: string } | null {
  const sessionToken = loopoverSessionToken(env);
  if (!sessionToken) return null;
  return { apiUrl: loopoverApiUrl(env), sessionToken };
}

async function fetchLiveGitHubTokenFromSession(
  sessionToken: string,
  apiUrl: string,
  fetchImpl: GitHubTokenResolutionFetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(`${apiUrl}/v1/auth/github/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(GITHUB_TOKEN_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as { token?: unknown } | null;
    return typeof payload?.token === "string" && payload.token ? payload.token : null;
  } catch {
    return null;
  }
}

// Process-lifetime cache of a SUCCESSFUL resolution only. A failure (no session, expired session, transient
// network error) is deliberately NOT cached -- it's retried on the next call instead, so a long-running AMS
// process can self-heal from a transient blip rather than being stuck treating the token as permanently
// unavailable for its entire remaining lifetime.
let cachedToken: string | undefined;

/**
 * Resolve a GitHub token for AMS's git operations (#6116). Returns null when nothing is available: no
 * GITHUB_TOKEN override, no loopover-mcp session on disk, or the session-token fetch fails for any reason --
 * callers already treat a missing token as "git operations requiring auth will fail," the same failure mode
 * as before this feature existed.
 */
export async function resolveGitHubToken(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: GitHubTokenResolutionFetch } = {},
): Promise<string | null> {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (cachedToken) return cachedToken;
  const sessionToken = loopoverSessionToken(env);
  if (!sessionToken) return null;
  const fetchImpl = options.fetchImpl ?? (fetch as GitHubTokenResolutionFetch);
  const fetched = await fetchLiveGitHubTokenFromSession(sessionToken, loopoverApiUrl(env), fetchImpl);
  if (fetched) cachedToken = fetched;
  return fetched;
}

/** Test-only: clear the process-lifetime cache so one test's resolution can't leak into the next. */
export function resetGitHubTokenResolutionForTesting(): void {
  cachedToken = undefined;
}

/**
 * Offline-only check: does resolveGitHubToken have ANYTHING to try (a GITHUB_TOKEN override, or a
 * loopover-mcp session recorded on disk), without making the network call resolveGitHubToken itself would
 * make to actually verify it still works. For `doctor`/`status`-style diagnostics (status.js's
 * checkGitHubTokenPresent), which are deliberately offline-only -- a genuinely expired or revoked session
 * still reports "present" here; only an actual attempt (or resolveGitHubToken itself) discovers that.
 */
export function hasGitHubTokenSource(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GITHUB_TOKEN) || Boolean(loopoverSessionToken(env));
}
