// Milestone-lifecycle signals, read from structured GitHub issue API fields only — no diff/text/YAML parsing.
// Surfaces two milestone/PR mismatches a PR's own page doesn't call out: the PR's milestone due date has already
// passed while the milestone is still open, and the PR's milestone has already been closed out from under it
// while the PR itself is still open. Reads only documented fields from the GitHub issues API (`milestone.due_on`,
// `milestone.state`) and compares them — no ambiguous-syntax parsing, so it cannot suffer a patch scanner's edge
// cases. Pure GitHub-metadata read, no repo content. Fail-safe: no token, a bad repo slug, or a fetch error all
// yield no finding.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  MilestoneLifecycleFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
  /** Injectable clock so overdue-days math is deterministic in tests; defaults to Date.now(). */
  now?: number;
}

interface Milestone {
  title?: string;
  due_on?: string | null;
  state?: string;
}

interface IssueResponse {
  milestone?: Milestone | null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchIssue(
  owner: string,
  repo: string,
  prNumber: number,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<IssueResponse | null> {
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/` +
    `${encodeURIComponent(String(prNumber))}`;
  const fetchOptions = {
    endpointCategory: "github-issue",
    headers,
    signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "milestone-lifecycle",
    subcall: "github-issue",
    maxBytes: 256 * 1024,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<IssueResponse>(url, fetchOptions)
    : await boundedFetchJson<IssueResponse>(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Pure: a PR's milestone (or absence of one) → a lifecycle finding. The two kinds are mutually exclusive per PR
 *  — a closed milestone is reported as `milestone-already-closed` regardless of its due date, since "already
 *  closed" is the more actionable fact; only an OPEN milestone's due date is checked for overdue-ness. Pure. */
export function evaluateMilestoneLifecycle(
  milestone: Milestone | null | undefined,
  now: number,
): MilestoneLifecycleFinding[] {
  if (!milestone?.title) return [];

  if (milestone.state === "closed") {
    return [{ milestoneTitle: milestone.title, kind: "milestone-already-closed" }];
  }

  if (milestone.due_on) {
    const dueAt = Date.parse(milestone.due_on);
    if (Number.isFinite(dueAt) && dueAt < now) {
      const daysOverdue = Math.floor((now - dueAt) / MS_PER_DAY);
      if (daysOverdue > 0) {
        return [{ milestoneTitle: milestone.title, kind: "overdue-milestone", daysOverdue }];
      }
    }
  }

  return [];
}

/** Analyzer entrypoint: a PR's milestone → lifecycle findings. Fail-safe — no token, a bad repo slug, or a fetch
 *  error all yield no finding rather than an error. */
export async function scanMilestoneLifecycle(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<MilestoneLifecycleFinding[]> {
  const { repoFullName, githubToken, prNumber } = req;
  if (!githubToken) return [];
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers = githubHeaders(githubToken);
  const issue = await fetchIssue(owner, repo, prNumber, headers, fetchFn, options.signal, options);
  if (!issue) return [];

  return evaluateMilestoneLifecycle(issue.milestone, options.now ?? Date.now());
}
