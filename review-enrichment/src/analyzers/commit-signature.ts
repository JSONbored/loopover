// Commit-signature / verified-author provenance analyzer (#1517). Detects two supply-chain signals that the
// no-checkout reviewer cannot assess on their own:
//   "unsigned"      — the PR head commit is not signed/verified by GitHub
//                     (commit.verification.verified = false; reason exposed as context).
//   "new-committer" — the committing author has no prior commits in this repo, yet the repo's recent history
//                     is ≥80% verified-commit signed — a potential impersonation/injection vector.
// Network: two or three GitHub REST calls (head commit, recent repo commits, author history) under the shared
// AbortSignal timeout. Fail-safe: returns [] on any error or missing prerequisite.
import type { EnrichRequest, CommitSignatureFinding } from "../types.js";

const MAX_HISTORY_COMMITS = 20;
const MIN_HISTORY_FOR_PATTERN = 3;    // need ≥ this many non-head commits to infer the repo's signing pattern
const VERIFIED_RATIO_THRESHOLD = 0.8; // only flag new-committer when ≥80% of recent commits are verified

// Allowlists to prevent path traversal when these values are interpolated into API URL paths.
const SHA_RE = /^[a-f0-9]{7,40}$/i;
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/; // must start with alphanumeric — rejects ".." and other dot-only traversal segments

interface GitHubCommit {
  sha: string;
  commit: {
    verification: {
      verified: boolean;
      reason: string;
    };
  };
  author: { login: string } | null;
}

/** Fetch head-commit verification status, then optionally check for never-before-seen committers. */
export async function scanCommitSignature(
  req: EnrichRequest,
  fetchFn: typeof fetch,
  opts?: { signal?: AbortSignal },
): Promise<CommitSignatureFinding[]> {
  const { repoFullName, headSha, githubToken } = req;
  if (!githubToken || !headSha) return [];

  if (!SHA_RE.test(headSha)) return [];

  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers: Record<string, string> = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Phase 1: fetch the head commit and check its verification status.
  let headCommit: GitHubCommit;
  try {
    const resp = await fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}`,
      { headers, signal: opts?.signal },
    );
    if (!resp.ok) return [];
    headCommit = (await resp.json()) as GitHubCommit;
  } catch {
    return [];
  }

  const authorLogin = headCommit.author?.login ?? null;
  const verification = headCommit.commit.verification;

  if (!verification.verified) {
    return [{ headSha, authorLogin, kind: "unsigned", reason: verification.reason }];
  }

  // Phase 2: check whether this is a new committer in a repo with a verified-commit pattern.
  // Skip the check when the author identity is unknown (no GitHub user linked to the commit email).
  if (!authorLogin) return [];

  try {
    const recentResp = await fetchFn(
      `https://api.github.com/repos/${owner}/${repo}/commits?per_page=${MAX_HISTORY_COMMITS}`,
      { headers, signal: opts?.signal },
    );
    if (!recentResp.ok) return [];
    const recentCommits = (await recentResp.json()) as GitHubCommit[];

    // Exclude the current head from history so the ratio reflects the pre-existing signing pattern.
    const others = recentCommits.filter((c) => c.sha !== headSha);
    if (others.length < MIN_HISTORY_FOR_PATTERN) return [];

    const verifiedCount = others.filter((c) => c.commit.verification.verified).length;
    if (verifiedCount / others.length < VERIFIED_RATIO_THRESHOLD) return [];

    // Repo uses verified commits — does this author have any prior commits here?
    const authorHistoryResp = await fetchFn(
      `https://api.github.com/repos/${owner}/${repo}/commits?author=${encodeURIComponent(authorLogin)}&per_page=3`,
      { headers, signal: opts?.signal },
    );
    if (!authorHistoryResp.ok) return [];
    const authorHistory = (await authorHistoryResp.json()) as { sha: string }[];

    const priorCommits = authorHistory.filter((c) => c.sha !== headSha);
    if (priorCommits.length === 0) {
      return [{ headSha, authorLogin, kind: "new-committer", reason: null }];
    }
  } catch {
    return [];
  }

  return [];
}
