import { Octokit } from "@octokit/core";
import { createInstallationToken } from "./app";

/** GitHub checks these paths in order when resolving CODEOWNERS. */
const CODEOWNERS_CANDIDATES = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"] as const;
const CODEOWNERS_MAX_BYTES = 512_000;

/**
 * Fetch the CODEOWNERS file for a repository from the public GitHub raw endpoint.
 * Tries CODEOWNERS, .github/CODEOWNERS, and docs/CODEOWNERS in order (GitHub resolution order).
 * Returns null when none exists or network errors occur — callers treat this as "no routing data".
 */
export async function fetchCodeownersFile(repoFullName: string): Promise<string | null> {
  const slash = repoFullName.indexOf("/");
  if (slash <= 0 || slash === repoFullName.length - 1) return null;
  const owner = encodeURIComponent(repoFullName.slice(0, slash));
  const name = encodeURIComponent(repoFullName.slice(slash + 1));
  for (const path of CODEOWNERS_CANDIDATES) {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/HEAD/${path}`;
    try {
      const response = await fetch(url, { headers: { "User-Agent": "gittensory" } });
      if (!response.ok) continue;
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        const parsed = Number.parseInt(contentLength, 10);
        if (Number.isFinite(parsed) && parsed > CODEOWNERS_MAX_BYTES) continue;
      }
      const text = await response.text();
      if (text.length <= CODEOWNERS_MAX_BYTES) return text;
    } catch {
      // try next candidate
    }
  }
  return null;
}

type RequestedReviewersResponse = {
  users?: Array<{ login?: string | null }>;
};

/**
 * Return the set of logins (lowercase) that are already pending review-request on a PR so the
 * caller can skip re-requesting them (idempotency guard).
 */
export async function getRequestedReviewers(env: Env, installationId: number, repoFullName: string, pullNumber: number): Promise<Set<string>> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return new Set();
  const token = await createInstallationToken(env, installationId);
  const octokit = new Octokit({ auth: token });
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
      owner,
      repo,
      pull_number: pullNumber,
    });
    const data = response.data as RequestedReviewersResponse;
    const logins = new Set<string>();
    for (const user of data.users ?? []) {
      if (user.login) logins.add(user.login.toLowerCase());
    }
    return logins;
  } catch {
    // Non-fatal: if we can't check, proceed conservatively (caller will skip).
    return new Set();
  }
}

/**
 * Request individual reviewers on a pull request using the GitHub installation token. Teams are
 * NOT passed — pass only user logins. Returns whether the request was sent.
 *
 * Throws on non-2xx responses so the caller can catch and audit the failure.
 */
export async function requestPullRequestReviewers(
  env: Env,
  installationId: number,
  repoFullName: string,
  pullNumber: number,
  reviewerLogins: string[],
): Promise<void> {
  if (reviewerLogins.length === 0) return;
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository full name: ${repoFullName}`);
  const token = await createInstallationToken(env, installationId);
  const octokit = new Octokit({ auth: token });
  await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
    owner,
    repo,
    pull_number: pullNumber,
    reviewers: reviewerLogins,
  });
}
