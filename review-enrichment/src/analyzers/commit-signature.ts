// Commit-signature / verified-author provenance analyzer (#1517). Inspects the PR head commit's signature
// verification verdict, its author/committer identity, and — when the head is from an author with no prior
// verified history in a repo that otherwise carries verified commits — flags a never-before-seen committer.
// These are supply-chain / impersonation signals the no-checkout `claude --print` reviewer cannot derive
// (no GitHub commit-verification API access, no repo history). Surfaces ONLY GitHub's public verification
// verdict (`verified` + `reason`) and boolean provenance flags — never tokens, emails, or private identities.
import type { EnrichRequest, CommitSignatureFinding } from "../types.js";

const GITHUB_API = "https://api.github.com";
// Pull a bounded slice of recent commits — enough to decide "has any verified history" without paging the whole
// repo. The history check runs at most two such queries (author-filtered + repo-wide), matching how the other
// analyzers cap their network round-trips.
const HISTORY_PER_PAGE = 30;
// Only repository slugs that look like real `owner/repo` segments are ever interpolated into a request URL.
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

interface ScanOptions {
  signal?: AbortSignal;
}

// The slice of the GitHub commit payload this analyzer reads. Everything else on the response is ignored.
interface CommitResponse {
  commit?: {
    verification?: { verified?: boolean; reason?: string };
    author?: { name?: string };
    committer?: { name?: string };
  };
  author?: { login?: string } | null;
  committer?: { login?: string } | null;
}

interface HistoryCommit {
  commit?: { verification?: { verified?: boolean } };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Fetch the head commit's verification + identity payload. Returns null on any error / non-200 (fail-safe). */
export async function fetchHeadCommit(
  owner: string,
  repo: string,
  headSha: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<CommitResponse | null> {
  if (signal?.aborted) return null;
  try {
    const resp = await fetchFn(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}`,
      { headers, signal },
    );
    if (!resp.ok) return null;
    return (await resp.json()) as CommitResponse;
  } catch {
    return null;
  }
}

/** Fetch one bounded page of the repo's recent commits, optionally filtered to a single author, and report
 *  whether ANY of them carry a verified signature. Returns true/false on a definitive answer, or null when
 *  undeterminable (network error / non-200 / unexpected shape) — callers fail safe on null. */
export async function hasVerifiedHistory(
  owner: string,
  repo: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  author?: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  if (signal?.aborted) return null;
  const authorQuery = author ? `author=${encodeURIComponent(author)}&` : "";
  try {
    const resp = await fetchFn(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${authorQuery}per_page=${HISTORY_PER_PAGE}`,
      { headers, signal },
    );
    if (!resp.ok) return null;
    const commits = (await resp.json()) as HistoryCommit[];
    if (!Array.isArray(commits)) return null;
    return commits.some((c) => c.commit?.verification?.verified === true);
  } catch {
    return null;
  }
}

/** Analyzer entrypoint: inspect the head commit's signature + author provenance. Fail-safe — returns no finding
 *  on a missing token / head SHA, an unresolvable repo slug, or any fetch error, and never throws. */
export async function scanCommitSignature(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<CommitSignatureFinding[]> {
  const { repoFullName, githubToken, headSha } = req;
  if (!githubToken || !headSha) return [];

  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers = githubHeaders(githubToken);
  const head = await fetchHeadCommit(
    owner,
    repo,
    headSha,
    headers,
    fetchFn,
    options.signal,
  );
  if (!head?.commit) return [];

  const verified = head.commit.verification?.verified === true;
  const reason = head.commit.verification?.reason ?? "unknown";
  const authorLogin = head.author?.login;
  const committerLogin = head.committer?.login;
  // An author/committer login mismatch can indicate a rewritten/impersonated authorship; only compare when both
  // logins are resolved (GitHub leaves them null for unmatched email identities, which is not itself a mismatch).
  const authorMismatch =
    Boolean(authorLogin) &&
    Boolean(committerLogin) &&
    authorLogin !== committerLogin;

  // A never-before-seen committer is only a signal when the repo otherwise HAS verified history but THIS author
  // has none — a repo with no verified commits at all is simply unsigned, not impersonated. Two bounded history
  // queries (author-filtered + repo-wide); either being undeterminable (null) fails safe to no flag.
  let newCommitter = false;
  if (authorLogin && !options.signal?.aborted) {
    const authorVerified = await hasVerifiedHistory(
      owner,
      repo,
      headers,
      fetchFn,
      authorLogin,
      options.signal,
    );
    if (authorVerified === false && !options.signal?.aborted) {
      const repoVerified = await hasVerifiedHistory(
        owner,
        repo,
        headers,
        fetchFn,
        undefined,
        options.signal,
      );
      newCommitter = repoVerified === true;
    }
  }

  // Nothing noteworthy: a verified head with a matching author and no new-committer signal needs no finding.
  if (verified && !authorMismatch && !newCommitter) return [];

  const finding: CommitSignatureFinding = {
    verified,
    reason,
    authorMismatch,
    newCommitter,
    ...(authorLogin ? { authorLogin } : {}),
  };
  return [finding];
}
