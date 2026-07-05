// Flaky-test history annotator (#2033). For test files a PR touches, probes bounded recent default-branch commit +
// check-run history and counts CI test-check failures whose output references that file — a signal the change
// lands on historically flaky coverage. Structured GitHub API fields only in findings (counts + window, never
// logs). Bounded file/commit/check-run fanout; marks partial status when the probe budget is exhausted. Fail-safe
// without a token, bad slug, or fetch errors.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  FlakyTestFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { isTestPath } from "./test-ratio.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const WINDOW_DAYS = 30;
const WINDOW_LABEL = "30d";
const MAX_FILES_PROBED = 6;
const MAX_COMMITS_PER_FILE = 5;
const MAX_CHECK_RUN_FETCHES = 12;
const MAX_FINDINGS = 25;
const MIN_FAILURE_EVENTS = 2;
const COMMITS_PER_PAGE = 20;

const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);
const TEST_CHECK_RE =
  /test|jest|vitest|pytest|mocha|rspec|unittest|validate-code|go test|cargo test|npm test|yarn test|pnpm test/i;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

interface CommitItem {
  sha?: string;
}

interface CheckRunItem {
  name?: string;
  status?: string;
  conclusion?: string | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null };
}

interface CheckRunsResponse {
  check_runs?: CheckRunItem[];
}

interface RepoInfo {
  default_branch?: string;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function markPartial(diagnostics: AnalyzerDiagnostics | undefined, reason: string): void {
  if (!diagnostics) return;
  diagnostics.partialStatus = "partial";
  diagnostics.partialReason ??= reason;
}

/** True when a check-run name looks like a test/CI test job rather than lint/build-only. Pure. */
export function isTestCheckName(name: string): boolean {
  return TEST_CHECK_RE.test(name);
}

/** True when structured check-run output references the test file path or its basename. Pure. */
export function referencesTestFile(
  output: { title?: string | null; summary?: string | null; text?: string | null } | undefined,
  filePath: string,
): boolean {
  if (!output) return false;
  const haystack = `${output.title ?? ""}\n${output.summary ?? ""}\n${output.text ?? ""}`;
  if (haystack.includes(filePath)) return true;
  const base = filePath.split("/").pop() ?? filePath;
  if (base && haystack.includes(base)) return true;
  const stem = base.replace(/\.[^.]+$/, "");
  return Boolean(stem && stem.length >= 3 && haystack.includes(stem));
}

/** Count completed test-check failures on one commit's runs that reference `filePath`. Pure. */
export function countCommitTestFailures(runs: CheckRunItem[], filePath: string): number {
  let failures = 0;
  for (const run of runs) {
    if (run.status !== "completed" || !run.name || !run.conclusion) continue;
    if (!FAILURE_CONCLUSIONS.has(run.conclusion)) continue;
    if (!isTestCheckName(run.name)) continue;
    if (!referencesTestFile(run.output, filePath)) continue;
    failures += 1;
  }
  return failures;
}

async function fetchJson<T>(
  url: string,
  token: string,
  fetchFn: typeof fetch,
  options: ScanOptions,
  endpointCategory: string,
  phase: string,
  subcall: string,
  maxCallsPerCategory?: number,
): Promise<T | null> {
  const fetchOptions = {
    endpointCategory,
    headers: githubHeaders(token),
    signal: options.signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase,
    subcall,
    maxBytes: 512 * 1024,
    maxCallsPerCategory,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<T>(url, fetchOptions)
    : await boundedFetchJson<T>(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Analyzer entrypoint. Fail-safe — returns no finding without a token or on fetch errors. */
export async function scanFlakyTest(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<FlakyTestFinding[]> {
  const { repoFullName, githubToken, files = [] } = req;
  if (!githubToken) return [];
  const parts = repoFullName.split("/");
  if (parts.length !== 2) return [];
  const [owner, repo] = parts;
  if (!owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const testPaths = [...new Set(files.filter((f) => isTestPath(f.path)).map((f) => f.path))].slice(
    0,
    MAX_FILES_PROBED,
  );
  if (!testPaths.length) return [];

  const repoInfo = await fetchJson<RepoInfo>(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    githubToken,
    fetchFn,
    options,
    "github-repo-info",
    "flaky-test",
    "default-branch",
    1,
  );
  const defaultBranch = repoInfo?.default_branch;
  if (!defaultBranch) return [];

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const findings: FlakyTestFinding[] = [];
  let checkRunFetches = 0;
  let capped = false;

  for (const path of testPaths) {
    if (options.signal?.aborted) break;
    if (findings.length >= MAX_FINDINGS) break;

    const commits = await fetchJson<CommitItem[]>(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits` +
        `?sha=${encodeURIComponent(defaultBranch)}&path=${encodeURIComponent(path)}` +
        `&since=${encodeURIComponent(since)}&per_page=${COMMITS_PER_PAGE}`,
      githubToken,
      fetchFn,
      options,
      "github-commits",
      "flaky-test",
      "file-commits",
      MAX_FILES_PROBED,
    );
    if (!commits?.length) continue;

    let failureEvents = 0;
    for (const commit of commits.slice(0, MAX_COMMITS_PER_FILE)) {
      if (!commit.sha) continue;
      if (checkRunFetches >= MAX_CHECK_RUN_FETCHES) {
        capped = true;
        break;
      }
      checkRunFetches += 1;
      const checkData = await fetchJson<CheckRunsResponse>(
        `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/` +
          `${encodeURIComponent(commit.sha)}/check-runs?per_page=100&filter=all`,
        githubToken,
        fetchFn,
        options,
        "github-check-runs",
        "flaky-test",
        "commit-check-runs",
        MAX_CHECK_RUN_FETCHES,
      );
      const runs = checkData?.check_runs ?? [];
      if (countCommitTestFailures(runs, path) > 0) failureEvents += 1;
    }

    if (failureEvents >= MIN_FAILURE_EVENTS) {
      findings.push({ file: path, recentFailures: failureEvents, window: WINDOW_LABEL });
    }
    if (capped) break;
  }

  if (capped) markPartial(options.diagnostics, "flaky_test_probe_cap");
  return findings;
}
