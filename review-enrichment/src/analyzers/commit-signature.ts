// Commit-signature / verified-author provenance analyzer (#1517). Inspects the PR head commit's signature
// verification verdict, its author/committer identity, and — when the head is from an author with no prior
// verified history in a repo that otherwise carries verified commits — flags a never-before-seen committer.
// These are supply-chain / impersonation signals the no-checkout `claude --print` reviewer cannot derive
// (no GitHub commit-verification API access, no repo history). Surfaces ONLY GitHub's public verification
// verdict (`verified` + `reason`) and boolean provenance flags — never tokens, emails, or private identities.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  CommitSignatureFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { githubHeaders } from "../github-headers.js";

const GITHUB_API = "https://api.github.com";
// Pull a bounded slice of recent commits — enough to decide "has any verified history" without paging the whole
// repo. The history check runs at most two such queries (author-filtered + repo-wide), matching how the other
// analyzers cap their network round-trips.
const HISTORY_PER_PAGE = 30;
// Only repository slugs that look like real `owner/repo` segments are ever interpolated into a request URL.
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
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

async function fetchGithubJson<T>(
  url: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
  options: Pick<ScanOptions, "analysis" | "diagnostics"> = {},
): Promise<T | null> {
  const fetchOptions = {
    endpointCategory: "github-commits",
    headers,
    signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "commit-signature",
    subcall: "github-commits",
    maxBytes: 256 * 1024,
    maxCallsPerCategory: 3,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<T>(url, fetchOptions)
    : await boundedFetchJson<T>(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Fetch the head commit's verification + identity payload. Returns null on any error / non-200 (fail-safe). */
export async function fetchHeadCommit(
  owner: string,
  repo: string,
  headSha: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
  options: Pick<ScanOptions, "analysis" | "diagnostics"> = {},
): Promise<CommitResponse | null> {
  if (signal?.aborted) return null;
  return fetchGithubJson<CommitResponse>(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}`,
    headers,
    fetchFn,
    signal,
    options,
  );
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
  options: Pick<ScanOptions, "analysis" | "diagnostics"> = {},
): Promise<boolean | null> {
  if (signal?.aborted) return null;
  const authorQuery = author ? `author=${encodeURIComponent(author)}&` : "";
  const commits = await fetchGithubJson<HistoryCommit[]>(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${authorQuery}per_page=${HISTORY_PER_PAGE}`,
    headers,
    fetchFn,
    signal,
    options,
  );
  if (!Array.isArray(commits)) return null;
  return commits.some((c) => c.commit?.verification?.verified === true);
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

  // Require EXACTLY `owner/repo`. A 3+ segment value like `o/r/extra` would otherwise keep parts[0]/parts[1]
  // and silently query the wrong repository (`o/r`) instead of failing safe, so reject anything that is not a
  // clean two-segment slug before building any GitHub URL.
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers = githubHeaders(githubToken);
  const head = await fetchHeadCommit(
    owner,
    repo,
    headSha,
    headers,
    fetchFn,
    options.signal,
    options,
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
      options,
    );
    if (authorVerified === false && !options.signal?.aborted) {
      const repoVerified = await hasVerifiedHistory(
        owner,
        repo,
        headers,
        fetchFn,
        undefined,
        options.signal,
        options,
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
