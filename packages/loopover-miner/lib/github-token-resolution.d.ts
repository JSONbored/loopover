// A narrower shape than `typeof fetch` on purpose: this module only ever calls it with a string URL and a
// plain init object, and the ambient `fetch` type in this repo's TS program is Cloudflare-Workers-flavored
// (RequestInfo<CfProperties> | URL), which is both irrelevant here (this package runs under plain Node) and
// stricter than any real caller needs -- same rationale as live-issue-snapshot.js's own LiveIssueSnapshotFetch.
export type GitHubTokenResolutionFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export function resolveGitHubToken(
  env?: NodeJS.ProcessEnv,
  options?: { fetchImpl?: GitHubTokenResolutionFetch },
): Promise<string | null>;

/** Same loopover-mcp session + API URL posture `resolveGitHubToken` uses (#6487). Null when no session. */
export function resolveLoopoverBackendSession(
  env?: NodeJS.ProcessEnv,
): { apiUrl: string; sessionToken: string } | null;

export function resetGitHubTokenResolutionForTesting(): void;

export function hasGitHubTokenSource(env?: NodeJS.ProcessEnv): boolean;
