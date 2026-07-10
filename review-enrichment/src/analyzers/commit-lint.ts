// Conventional-Commits subject linter (#2021). Reads a PR's commit subjects from the structured GitHub PR-commits
// API and flags each subject that does not conform to the Conventional Commits spec — a wrong/absent type, a
// missing `type: ` structure, an over-long subject, or an empty subject. A house-rule the gate cares about,
// surfaced early. Reads only documented fields (sha, commit.message) and lints each subject independently — no
// cross-commit or cross-line state, and the subject strings come from the API already clean (no diff/comment/
// string parsing). Bounded to one page of commits (MAX_COMMITS). Fail-safe: no token, a bad repo slug, or a
// fetch error all yield no finding rather than an error. Follows commit-hygiene.ts / commit-signature.ts.
import type {
  AnalyzerDiagnostics,
  CommitLintFinding,
  EnrichRequest,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { githubHeaders } from "../github-headers.js";
import { DEFAULT_MAX_FINDINGS } from "./limits.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const MAX_COMMITS = 100;
const MAX_FINDINGS = DEFAULT_MAX_FINDINGS;
const SHA_PREFIX_LEN = 12;
const MAX_SUBJECT_LEN = 72; // Conventional Commits / git convention soft cap for the subject line.

// The Conventional Commits type set (the spec's two + the Angular/commitlint conventional preset). A finite,
// documented enum — not free-form text.
const ALLOWED_TYPES = new Set([
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
]);

// `type(scope)?!?: summary` — captures the type and asserts the `: ` structure. `!` (breaking-change marker) and a
// parenthesized scope are both optional, per the spec.
const CONVENTIONAL_RE = /^([a-zA-Z]+)(?:\([^)]*\))?!?:\s+\S/;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

/** The slice of a GitHub PR-commit list item this analyzer reads. */
interface CommitListItem {
  sha?: string;
  commit?: { message?: string };
}

async function fetchPrCommits(
  owner: string,
  repo: string,
  prNumber: number,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<CommitListItem[] | null> {
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/` +
    `${encodeURIComponent(String(prNumber))}/commits?per_page=${MAX_COMMITS}`;
  const fetchOptions = {
    endpointCategory: "github-pr-commits",
    headers,
    signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "commit-lint",
    subcall: "github-pr-commits",
    maxBytes: 512 * 1024,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<CommitListItem[]>(url, fetchOptions)
    : await boundedFetchJson<CommitListItem[]>(url, fetchOptions);
  return response.ok && Array.isArray(response.data) ? response.data : null;
}

/** Lint one commit subject against the Conventional Commits spec. Returns the failing reason, or null when the
 *  subject conforms. `empty` and `too-long` take priority over structural checks. Pure. */
export function lintSubject(subject: string): CommitLintFinding["reason"] | null {
  const trimmed = subject.trim();
  if (!trimmed) return "empty";
  if (trimmed.length > MAX_SUBJECT_LEN) return "too-long";
  const match = CONVENTIONAL_RE.exec(trimmed);
  if (!match) return "missing-colon";
  // Case-SENSITIVE: the Conventional Commits type set is lowercase, so `FEAT:`/`Fix:` is a bad type, not a pass.
  if (!ALLOWED_TYPES.has(match[1]!)) return "bad-type";
  return null;
}

/** Pure reduction: a PR's commit list → conventional-commit lint findings, in list order, each independent.
 *  Bounded by maxFindings. */
export function analyzeCommitSubjects(
  commits: CommitListItem[],
  maxFindings = MAX_FINDINGS,
): CommitLintFinding[] {
  const findings: CommitLintFinding[] = [];
  for (const item of commits) {
    if (findings.length >= maxFindings) break;
    const sha = item.sha;
    if (!sha) continue;
    const subject = (item.commit?.message ?? "").split("\n")[0] ?? "";
    const reason = lintSubject(subject);
    if (reason) {
      findings.push({ sha: sha.slice(0, SHA_PREFIX_LEN), subject: subject.trim().slice(0, 120), reason });
    }
  }
  return findings;
}

/** Analyzer entrypoint: a PR's commit subjects → conventional-commit lint findings. Fail-safe — no token, a bad
 *  repo slug, or a fetch error all yield no finding rather than an error. */
export async function scanCommitLint(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<CommitLintFinding[]> {
  const { repoFullName, githubToken, prNumber } = req;
  if (!githubToken) return [];
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers = githubHeaders(githubToken);
  const commits = await fetchPrCommits(owner, repo, prNumber, headers, fetchFn, options.signal, options);
  if (!commits) return [];

  return analyzeCommitSubjects(commits);
}
