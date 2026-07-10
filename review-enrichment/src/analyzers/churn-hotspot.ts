// Churn-hotspot analyzer (#1513). For the files a PR changes, reads each file's recent commit history from the
// GitHub API and flags the ones that are statistical fragility hotspots — a high commit frequency AND a high
// fraction of fix/revert commits in the window. These are areas where defects historically cluster, so the
// reviewer should scrutinize the change harder. This is heavy/external/historical analysis the no-checkout
// `claude --print` reviewer cannot do. Surfaces only counts derived from the public commit log — never file
// contents. Distinct from the history analyzer (#1478), which scores the AUTHOR's track record.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  ChurnHotspotFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { githubHeaders } from "../github-headers.js";
import { isHistoryUninformativePath } from "./history-path.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const WINDOW_DAYS = 90;
const PER_PAGE = 100; // one page; a file with a full page of commits in the window is already a clear hotspot
const MAX_FILES_PROBED = 8; // bound the GitHub round-trips, matching the other history-class analyzers
const MIN_COMMITS = 8; // a hotspot must change frequently within the window
const MIN_FIX_FRACTION = 0.3; // and a meaningful share of those changes must be fixes/reverts
// Defect-correcting commit subjects: fix/bugfix/hotfix/revert/regression (conventional-commit `fix:` included).
const FIX_RE = /\b(?:fix(?:e[ds]|ing)?|bug ?fix|hotfix|revert(?:ed|s)?|regression)\b/i;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

/** The slice of a GitHub commit-list item this analyzer reads. */
interface CommitItem {
  commit?: { message?: string };
}

/** True when a commit's SUBJECT line describes a defect correction. Pure. */
export function isFixCommit(message: string): boolean {
  const subject = message.split("\n", 1)[0] ?? "";
  return FIX_RE.test(subject);
}

/** Reduce a commit list to total + fix counts, capped flag, and the fix fraction. Pure. */
export function summarizeChurn(commits: CommitItem[]): {
  commitCount: number;
  fixCount: number;
  fixFraction: number;
} {
  let fixCount = 0;
  for (const item of commits) if (isFixCommit(item.commit?.message ?? "")) fixCount += 1;
  const commitCount = commits.length;
  return { commitCount, fixCount, fixFraction: commitCount ? fixCount / commitCount : 0 };
}

/** True when a file's churn summary meets the hotspot thresholds (enough commits AND enough of them fixes). Pure. */
export function isHotspot(summary: { commitCount: number; fixFraction: number }): boolean {
  return summary.commitCount >= MIN_COMMITS && summary.fixFraction >= MIN_FIX_FRACTION;
}

/** Fetch one page of commits touching `path` since `since`. Returns the list, or null on any error / non-200. */
async function fetchFileCommits(
  url: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<CommitItem[] | null> {
  const fetchOptions = {
    endpointCategory: "github-commits",
    headers,
    signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "churn-hotspot",
    subcall: "github-commits",
    maxBytes: 512 * 1024,
    maxCallsPerCategory: MAX_FILES_PROBED,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<CommitItem[]>(url, fetchOptions)
    : await boundedFetchJson<CommitItem[]>(url, fetchOptions);
  return response.ok && Array.isArray(response.data) ? response.data : null;
}

/** Analyzer entrypoint: changed files → per-file recent commit history → fragility hotspots. Fail-safe. */
export async function scanChurnHotspot(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<ChurnHotspotFinding[]> {
  const { repoFullName, githubToken, files = [] } = req;
  if (!githubToken) return [];
  const parts = repoFullName.split("/");
  if (parts.length !== 2) return [];
  const [owner, repo] = parts;
  if (!owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers = githubHeaders(githubToken);
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  // A newly-added file has no prior history; skip it (and non-code/generated files) before spending a round-trip.
  const paths = files
    .filter((file) => file.status !== "added" && !isHistoryUninformativePath(file.path))
    .map((file) => file.path)
    .slice(0, MAX_FILES_PROBED);

  const findings: ChurnHotspotFinding[] = [];
  for (const path of paths) {
    if (options.signal?.aborted) break;
    const url =
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits` +
      `?path=${encodeURIComponent(path)}&since=${encodeURIComponent(since)}&per_page=${PER_PAGE}`;
    const commits = await fetchFileCommits(url, headers, fetchFn, options.signal, options);
    if (!commits) continue;
    const summary = summarizeChurn(commits);
    if (!isHotspot(summary)) continue;
    findings.push({
      file: path,
      commitCount: summary.commitCount,
      fixCount: summary.fixCount,
      windowDays: WINDOW_DAYS,
      capped: summary.commitCount >= PER_PAGE,
    });
  }
  return findings;
}
