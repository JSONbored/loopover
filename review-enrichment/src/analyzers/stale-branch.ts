// Stale-branch signal, read from structured GitHub repo/compare API fields only — no diff/text/log parsing.
// Surfaces a PR whose branch is significantly BEHIND the repo's current default branch — a staleness risk the
// PR page itself does not summarize as a number (GitHub's own UI only shows "This branch is out-of-date", not
// how far). A branch far behind is more likely to hide a subtle semantic conflict a clean `mergeable` check
// would miss. Reads only documented fields from the GitHub repo API (`default_branch`) and the compare API
// (`status`, `behind_by`) — no ambiguous-syntax parsing, so it cannot suffer a patch scanner's edge cases. Pure
// GitHub-metadata read, no repo content. Fail-safe: no token, no head SHA, a bad repo slug, or either fetch
// failing all yield no finding rather than an error.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  StaleBranchFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
// Below this many commits behind, drifting from the default branch is normal PR life, not a staleness risk.
const BEHIND_THRESHOLD = 100;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

interface RepoInfo {
  default_branch?: string;
}

interface CompareResult {
  status?: string;
  behind_by?: number;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchDefaultBranch(
  owner: string,
  repo: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const fetchOptions = {
    endpointCategory: "github-repo-info",
    headers,
    signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "stale-branch",
    subcall: "github-repo-info",
    maxBytes: 128 * 1024,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<RepoInfo>(url, fetchOptions)
    : await boundedFetchJson<RepoInfo>(url, fetchOptions);
  return response.ok && typeof response.data.default_branch === "string" && response.data.default_branch
    ? response.data.default_branch
    : null;
}

async function fetchCompare(
  owner: string,
  repo: string,
  base: string,
  head: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<CompareResult | null> {
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/` +
    `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const fetchOptions = {
    endpointCategory: "github-compare",
    headers,
    signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "stale-branch",
    subcall: "github-compare",
    maxBytes: 256 * 1024,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<CompareResult>(url, fetchOptions)
    : await boundedFetchJson<CompareResult>(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Pure: a repo's default branch + a compare-API result → a stale-branch finding, when behind_by crosses the
 *  fixed threshold. `behind_by` must be a finite non-negative number — a missing/malformed field fails closed
 *  (no finding) rather than guessing. Pure. */
export function evaluateStaleBranch(defaultBranch: string, compare: CompareResult): StaleBranchFinding[] {
  const behindBy = compare.behind_by;
  if (typeof behindBy !== "number" || !Number.isFinite(behindBy) || behindBy < 0) return [];
  if (behindBy < BEHIND_THRESHOLD) return [];
  return [{ defaultBranch, behindBy }];
}

/** Analyzer entrypoint: how far this PR's head is behind the repo's CURRENT default branch → a stale-branch
 *  finding, when significant. Fail-safe — no token, no head SHA, a bad repo slug, or either fetch failing all
 *  yield no finding rather than an error. */
export async function scanStaleBranch(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<StaleBranchFinding[]> {
  const { repoFullName, githubToken, headSha } = req;
  if (!githubToken || !headSha) return [];
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers = githubHeaders(githubToken);
  const defaultBranch = await fetchDefaultBranch(owner, repo, headers, fetchFn, options.signal, options);
  if (!defaultBranch) return [];
  const compare = await fetchCompare(owner, repo, defaultBranch, headSha, headers, fetchFn, options.signal, options);
  if (!compare) return [];

  return evaluateStaleBranch(defaultBranch, compare);
}
