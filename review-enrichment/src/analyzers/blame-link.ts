// Blame-to-PR regression linker (#2034, part of #1499). For files this PR MODIFIES or DELETES, resolves which
// prior PR most recently introduced that region and surfaces it, so the reviewer sees at a glance what history the
// change is altering. It does not run true per-line blame (no checkout, no blame API): for each touched file it
// reads the path's most recent commit on the base branch and maps that commit to its PR via the commit→PR
// association API. Bounded (maxFilesProbed + maxLookups) and fail-safe — any missing token, bad slug, or fetch
// error yields no finding rather than an error. Surfaces only a PR number and a short SHA prefix, never contents.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  BlameLinkFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const MAX_FILES_PROBED = 6; // bound the files we probe, matching the other history-class analyzers
const MAX_LOOKUPS = 12; // hard cap on total GitHub round-trips (each file costs up to 2: commits + pulls)
const SHA_PREFIX_LEN = 12;
// Files whose commit history is not a useful "who introduced this" signal — lockfiles, generated output, binaries.
const SKIP_RE =
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|go\.sum)$|\.(?:lock|min\.js|map|snap|png|jpe?g|gif|svg|ico|pdf|zip|gz|woff2?)$|(?:^|\/)(?:dist|build|vendor)\//i;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

/** The slice of a GitHub commit-list item this analyzer reads. */
interface CommitListItem {
  sha?: string;
}
/** The slice of a commit→PR association item this analyzer reads. */
interface AssociatedPr {
  number?: number;
}

/**
 * The old-file line number of the FIRST line this patch modifies or deletes, or null when the patch only ADDS
 * lines (nothing pre-existing is being altered, so there is no prior author to attribute). Walks unified-diff
 * hunks: a `@@ -old,+new @@` header resets the old-line cursor; context lines advance it; a deletion line reports
 * the cursor; addition lines do not advance it (they exist only in the new file). Pure. */
export function firstTouchedOldLine(patch: string): number | null {
  let oldLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (header) {
      oldLine = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("---") || raw.startsWith("+++")) continue; // stray file headers inside the fragment
    if (raw.startsWith("\\")) continue; // `\ No newline at end of file` marker — metadata, not a real line
    if (raw.startsWith("-")) return oldLine; // first modified/deleted old-file line
    if (raw.startsWith("+")) continue; // added line: present only in the new file, no old-line advance
    oldLine += 1; // context line
  }
  return null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchGithubJson<T>(
  url: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<T | null> {
  const fetchOptions = {
    endpointCategory: "github-commits",
    headers,
    signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "blame-link",
    subcall: "github-commits",
    maxBytes: 256 * 1024,
    maxCallsPerCategory: MAX_LOOKUPS,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<T>(url, fetchOptions)
    : await boundedFetchJson<T>(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** The SHA of the most recent commit touching `path` on the base branch, or null. Anchoring to `baseSha` keeps
 *  the PR's own commits out of the answer so we attribute PRIOR authorship, not this change. */
export async function fetchLatestCommitSha(
  owner: string,
  repo: string,
  path: string,
  baseSha: string | undefined,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<string | null> {
  const shaQuery = baseSha ? `&sha=${encodeURIComponent(baseSha)}` : "";
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits` +
    `?path=${encodeURIComponent(path)}&per_page=1${shaQuery}`;
  const commits = await fetchGithubJson<CommitListItem[]>(url, headers, fetchFn, signal, options);
  const sha = Array.isArray(commits) ? commits[0]?.sha : undefined;
  return typeof sha === "string" && sha ? sha : null;
}

/** The number of the PR that a commit belongs to, via the commit→PR association API, or null when unassociated. */
export async function fetchPrForCommit(
  owner: string,
  repo: string,
  sha: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<number | null> {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/pulls`;
  const pulls = await fetchGithubJson<AssociatedPr[]>(url, headers, fetchFn, signal, options);
  const number = Array.isArray(pulls) ? pulls[0]?.number : undefined;
  return typeof number === "number" ? number : null;
}

/** Analyzer entrypoint: changed files that alter existing lines → the prior PR/commit that introduced them.
 *  Fail-safe — no token, bad slug, or fetch error yields no finding. Stops and returns partial results at the
 *  lookup cap. */
export async function scanBlameLink(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<BlameLinkFinding[]> {
  const { repoFullName, githubToken, baseSha, files = [] } = req;
  if (!githubToken) return [];
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers = githubHeaders(githubToken);
  // Only files that alter pre-existing lines can be blamed: skip added files, generated/binary paths, and pure
  // additions (a patch with no deletion line has no prior author to attribute).
  const candidates: Array<{ path: string; line: number }> = [];
  for (const file of files) {
    if (file.status === "added" || SKIP_RE.test(file.path) || !file.patch) continue;
    const line = firstTouchedOldLine(file.patch);
    if (line === null) continue;
    candidates.push({ path: file.path, line });
    if (candidates.length >= MAX_FILES_PROBED) break;
  }

  const findings: BlameLinkFinding[] = [];
  let lookups = 0;
  for (const { path, line } of candidates) {
    if (options.signal?.aborted) break;
    if (lookups >= MAX_LOOKUPS) break; // cap reached → emit partial
    lookups += 1;
    const sha = await fetchLatestCommitSha(owner, repo, path, baseSha, headers, fetchFn, options.signal, options);
    if (!sha) continue; // unresolvable line → no finding
    let introducedByPr: number | null = null;
    if (lookups < MAX_LOOKUPS && !options.signal?.aborted) {
      lookups += 1;
      introducedByPr = await fetchPrForCommit(owner, repo, sha, headers, fetchFn, options.signal, options);
    }
    findings.push({
      file: path,
      line,
      introducedByShaPrefix: sha.slice(0, SHA_PREFIX_LEN),
      ...(introducedByPr !== null ? { introducedByPr } : {}),
    });
  }
  return findings;
}
