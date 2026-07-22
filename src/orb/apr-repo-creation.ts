// APR (auto-provisioned repo) creation under the submitting customer's own GitHub account (#7637, decision
// #7590 — corrected 2026-07-21). Earlier drafts of this issue specced creating the repo with a fixed/operator
// account's own token, which would put every APR repo under one owner regardless of who actually submitted the
// idea. That is NOT the intended behavior: the repo must be created under the CUSTOMER's own account, using
// THEIR OAuth authorization, via this codebase's existing multi-user session infrastructure
// (src/auth/github-oauth.ts) — never a fixed/operator session, never an installation-token driver.
//
// Requesting the `repo` scope only happens for the customer's own explicit idea-submission OAuth flow (the
// `scope` parameter `startGitHubWebOAuth` now accepts) — the default login flow is completely unaffected.

import { getLiveSessionGitHubToken } from "../auth/github-oauth";
import { githubHeaders, timeoutFetch } from "../github/client";

export type CreateAprRepoResult =
  | { created: true; fullName: string; htmlUrl: string; nodeId: string }
  | { created: false; status: number | null; error: string };

/**
 * Create a new GitHub repository owned by the customer identified by `sessionId`, using THAT session's own
 * live OAuth token (never a fixed/operator session) — GitHub's `POST /user/repos` always creates the repo
 * under the authenticated user's own account, so the returned `full_name` is `<their-login>/<repoName>`.
 *
 * Returns a structured `{ created: false }` result rather than throwing on a missing/expired session token or
 * a GitHub API error (e.g. a repo-name collision), so callers get a total function they can branch on.
 */
export async function createAprRepoForCustomerSession(
  env: Env,
  sessionId: string,
  repoName: string,
  options: { private?: boolean; description?: string } = {},
): Promise<CreateAprRepoResult> {
  const token = await getLiveSessionGitHubToken(env, sessionId);
  if (!token) return { created: false, status: null, error: "customer_session_token_unavailable" };

  const body: Record<string, unknown> = { name: repoName, private: options.private ?? true };
  if (options.description) body.description = options.description;

  const response = await timeoutFetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: githubHeaders({ token, json: true }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { created: false, status: response.status, error: detail.slice(0, 200) || `repo creation failed (${response.status})` };
  }
  const payload = (await response.json().catch(() => null)) as { full_name?: string; html_url?: string; node_id?: string } | null;
  if (!payload?.full_name || !payload.html_url || !payload.node_id) {
    return { created: false, status: response.status, error: "repo creation response missing required fields" };
  }
  return { created: true, fullName: payload.full_name, htmlUrl: payload.html_url, nodeId: payload.node_id };
}
