// Author / change-area history analyzer (#1478). Surfaces public-safe historical context the no-checkout
// `claude --print` reviewer is blind to and the engine deliberately does NOT compute: the PR author's track record
// IN THIS repo (prior merged/closed PRs, account age, first-time flag), past PRs that already changed the same files
// (with their merged/reverted outcome — revert/regression history), and whether the diff covers the linked issue's
// stated requirement. It surfaces ONLY public GitHub facts — never the engine's internal submitter reputation, nor
// any trust / reward / score value (those are private and intentionally absent here).
//
// Author context + similar-PR history use the request's short-lived githubToken; linked-issue alignment uses the
// linkedIssue passed in the request envelope and needs no fetch. Every GitHub call is wrapped so a missing token or
// a rate-limit/error degrades THIS analyzer only (the block is returned with `partial: true`) — the rest of the
// brief still ships. Fail-safe: returns [] when there is nothing to report.
import type { AnalyzerDiagnostics, EnrichRequest, HistoryFinding } from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { githubHeaders } from "../github-headers.js";
import { isDiffFileHeaderLine } from "./diff-lines.js";

const GITHUB_API = "https://api.github.com";
const MAX_FILES_PROBED = 5; // bound the per-file commit-history fan-out
const COMMITS_PER_FILE = 10; // recent commits to inspect per probed file
const MAX_PR_LOOKUPS = 12; // global cap on commit→PR resolution calls
const MAX_SIMILAR_PRS = 8; // cap the rendered similar-PR list
const MIN_TOKEN_LENGTH = 4; // requirement keywords shorter than this are ignored
const FULL_COVERAGE_RATIO = 0.6; // >= this share of requirement keywords present in the diff ⇒ "full"
const GITHUB_SUBCALL_TIMEOUT_MS = 1200;
const HISTORY_RESPONSE_RESERVE_MS = 250;

// A single repo path segment (owner or name): word chars, dot, dash only. Whole-segment `.`/`..` are rejected
// separately so a hostile repoFullName can't traverse or redirect the token-bearing request to another repository.
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

// Generic English + PR/issue-boilerplate words carry no signal about WHAT the issue asks for, so they are dropped
// before measuring requirement-vs-diff overlap (otherwise every diff would "cover" "feature"/"add"/"update").
const REQUIREMENT_STOPWORDS = new Set([
  "this", "that", "with", "from", "into", "when", "then", "than", "they", "them",
  "your", "have", "will", "shall", "should", "would", "could", "about", "there",
  "their", "which", "feat", "feature", "support", "implement", "implementation",
  "issue", "pull", "request", "code", "test", "tests", "added", "adds", "change",
  "changes", "update", "updates", "should",
]);

interface ScanOptions {
  signal?: AbortSignal;
  /** Injectable clock so account-age math is deterministic in tests; defaults to Date.now(). */
  now?: number;
  /** Analyzer deadline from the orchestrator. History stops fanout before this so REES can return a partial brief. */
  deadlineMs?: number;
  timeoutMs?: number;
  githubSubcallTimeoutMs?: number;
  diagnostics?: AnalyzerDiagnostics;
  analysis?: Pick<AnalysisContext, "fetchJson">;
}

type GithubEndpointCategory =
  | "github-search"
  | "github-users"
  | "github-commits"
  | "github-commit-pulls";

function markPartial(options: ScanOptions, reason: string, captureDegradation = false): void {
  const diagnostics = options.diagnostics;
  if (!diagnostics) return;
  diagnostics.partialStatus = "partial";
  if (!diagnostics.partialReason || captureDegradation) diagnostics.partialReason = reason;
  if (captureDegradation) diagnostics.captureDegradation = true;
}

function setPhase(options: ScanOptions, phase: string, subcall?: string): void {
  const diagnostics = options.diagnostics;
  if (!diagnostics) return;
  diagnostics.phase = phase;
  if (subcall) diagnostics.subcall = subcall;
}

function addCount(
  diagnostics: AnalyzerDiagnostics | undefined,
  key: "fileLookupCount" | "commitLookupCount" | "prLookupCount" | "skippedFileCount",
  count = 1,
): void {
  if (!diagnostics) return;
  diagnostics[key] = (diagnostics[key] ?? 0) + count;
}

function remainingMs(options: ScanOptions): number {
  if (options.signal?.aborted) return 0;
  if (typeof options.deadlineMs !== "number") return Number.POSITIVE_INFINITY;
  return Math.max(0, options.deadlineMs - Date.now());
}

function hasResponseBudget(options: ScanOptions): boolean {
  return remainingMs(options) > HISTORY_RESPONSE_RESERVE_MS;
}

function githubSubcallTimeoutMs(options: ScanOptions): number | null {
  if (!hasResponseBudget(options)) {
    markPartial(options, options.signal?.aborted ? "history_aborted" : "history_budget_exhausted", true);
    return null;
  }
  const remaining = remainingMs(options);
  return Math.max(
    1,
    Math.min(
      options.githubSubcallTimeoutMs ?? GITHUB_SUBCALL_TIMEOUT_MS,
      Number.isFinite(remaining) ? Math.max(1, remaining - HISTORY_RESPONSE_RESERVE_MS) : GITHUB_SUBCALL_TIMEOUT_MS,
    ),
  );
}

function prepareGithubSubcall(
  options: ScanOptions,
  category: GithubEndpointCategory,
): number | null {
  const diagnostics = options.diagnostics;
  if (diagnostics) {
    diagnostics.githubEndpointCategory = category;
    diagnostics.endpointCategory = category;
    diagnostics.subcall = category;
  }
  const timeoutMs = githubSubcallTimeoutMs(options);
  if (timeoutMs === null) return null;
  if (category === "github-commits") addCount(diagnostics, "fileLookupCount");
  if (category === "github-commit-pulls") addCount(diagnostics, "prLookupCount");
  return timeoutMs;
}

async function fetchGithubJson<T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  options: ScanOptions,
  category: GithubEndpointCategory,
): Promise<T | null> {
  const timeoutMs = prepareGithubSubcall(options, category);
  if (timeoutMs === null) return null;
  const fetchOptions = {
    endpointCategory: category,
    headers: githubHeaders(token),
    signal: options.signal,
    timeoutMs,
    fetchImpl,
    diagnostics: options.diagnostics,
    phase: options.diagnostics?.phase,
    subcall: category,
    maxBytes: 512 * 1024,
    maxCallsPerCategory: category === "github-commit-pulls" ? MAX_PR_LOOKUPS : undefined,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<T>(url, fetchOptions)
    : await boundedFetchJson<T>(url, fetchOptions);
  if (!response.ok) {
    if (response.reason === "http_error") {
      markPartial(
        options,
        `${category}_http_${response.status ?? "unknown"}`,
        response.status === 403 || response.status === 429,
      );
    } else {
      markPartial(options, `${category}_${response.reason}`, true);
    }
    return null;
  }
  return response.data;
}

/** Parse `owner/repo`, rejecting anything that isn't exactly two safe segments (no traversal, no extra slashes) so a
 *  hostile `repoFullName` cannot redirect the token-bearing request elsewhere. Returns null when unsafe. */
export function parseRepo(
  repoFullName: string,
): { owner: string; repo: string } | null {
  const parts = repoFullName.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  for (const seg of [owner, repo]) {
    if (!seg || seg === "." || seg === ".." || !REPO_SEGMENT.test(seg)) {
      return null;
    }
  }
  return { owner: owner!, repo: repo! };
}

// ── Linked-issue alignment (no fetch — the issue text is in the envelope) ───────

/** Extract lowercased keyword tokens (length >= MIN_TOKEN_LENGTH, minus stopwords) from the issue's stated
 *  requirement so coverage can be measured against the diff. Deduplicated, in first-seen order. */
export function requirementTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LENGTH || REQUIREMENT_STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/** Classify how much of the linked issue's requirement the diff appears to cover: `none` (no keyword present),
 *  `full` (>= FULL_COVERAGE_RATIO of keywords present), else `partial`. Advisory keyword overlap, never a proof. */
export function classifyCoverage(
  requirement: string,
  haystack: string,
): "full" | "partial" | "none" {
  const tokens = requirementTokens(requirement);
  if (tokens.length === 0) return "none";
  // Match whole words only — tokenize the haystack the same way the requirement is tokenized — so a short keyword
  // can't be "covered" by an unrelated word it is a substring of (e.g. `test` inside `latest`). (#1478)
  const hayWords = new Set(haystack.toLowerCase().split(/[^a-z0-9]+/));
  const covered = tokens.filter((t) => hayWords.has(t)).length;
  if (covered === 0) return "none";
  return covered / tokens.length >= FULL_COVERAGE_RATIO ? "full" : "partial";
}

/** The added ('+') lines of the PR, from req.diff or the per-file patches — the text the requirement is matched
 *  against (alongside the changed file paths). */
function diffAddedText(req: EnrichRequest): string {
  const sources: string[] = [];
  if (req.diff) sources.push(req.diff);
  for (const f of req.files ?? []) if (f.patch) sources.push(f.patch);
  const added: string[] = [];
  for (const src of sources) {
    for (const line of src.split("\n")) {
      // Skip real file headers (`+++ b/…`) but keep added CONTENT that begins with `++` (rendered `+++x`/`+++ x`).
      if (line.startsWith("+") && !isDiffFileHeaderLine(line)) added.push(line.slice(1));
    }
  }
  return added.join("\n");
}

/** Build the linked-issue alignment block from the envelope-provided issue text + the diff. `null` when there is no
 *  linked issue, or it carries no title/body to assess. */
export function buildLinkedIssueAlignment(
  req: EnrichRequest,
): HistoryFinding["linkedIssueAlignment"] {
  const issue = req.linkedIssue;
  const title = issue?.title?.trim() ?? "";
  const body = issue?.body?.trim() ?? "";
  if (!issue || (!title && !body)) return null;
  const statedRequirement = (title || body.split("\n")[0] || "").slice(0, 160);
  const requirementText = `${title}\n${body}`;
  const haystack = `${(req.files ?? [])
    .map((f) => f.path)
    .join(" ")}\n${diffAddedText(req)}`;
  return {
    issue: issue.number,
    statedRequirement,
    diffCovers: classifyCoverage(requirementText, haystack),
  };
}

// ── Author track record (GitHub Search + Users API) ─────────────────────────────

/** Issue/PR-search `total_count` for a query, or null on a non-OK reply / network error (so the caller degrades). */
async function fetchSearchCount(
  query: string,
  token: string,
  fetchImpl: typeof fetch,
  options: ScanOptions,
): Promise<number | null> {
  try {
    const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=1`;
    const json = await fetchGithubJson<{ total_count?: number }>(url, token, fetchImpl, options, "github-search");
    if (!json) return null;
    return typeof json.total_count === "number" ? json.total_count : null;
  } catch {
    return null;
  }
}

/** Account age in whole days from the Users API `created_at`, or null when unavailable / unparseable. */
async function fetchAccountAgeDays(
  login: string,
  token: string,
  fetchImpl: typeof fetch,
  now: number,
  options: ScanOptions,
): Promise<number | null> {
  try {
    const url = `${GITHUB_API}/users/${encodeURIComponent(login)}`;
    const json = await fetchGithubJson<{ created_at?: string }>(url, token, fetchImpl, options, "github-users");
    if (!json) return null;
    if (!json.created_at) return null;
    const created = Date.parse(json.created_at);
    if (Number.isNaN(created)) return null;
    return Math.max(0, Math.floor((now - created) / 86_400_000));
  } catch {
    return null;
  }
}

/** Author track record in this repo. `partial` is true when any sub-query failed (the counts then fall back to 0). */
async function buildAuthorContext(
  owner: string,
  repo: string,
  author: string,
  token: string,
  fetchImpl: typeof fetch,
  now: number,
  options: ScanOptions,
): Promise<{ author: NonNullable<HistoryFinding["author"]>; partial: boolean }> {
  setPhase(options, "author");
  const repoQ = `repo:${owner}/${repo} type:pr author:${author}`;
  const merged = await fetchSearchCount(`${repoQ} is:merged`, token, fetchImpl, options);
  const closed = await fetchSearchCount(`${repoQ} is:unmerged is:closed`, token, fetchImpl, options);
  const accountAgeDays = await fetchAccountAgeDays(author, token, fetchImpl, now, options);
  // A failed Search lookup is UNKNOWN, not zero — keep it null so a 403 / rate-limit can never be rendered as a
  // first-time contributor. firstTimeContributor is decided ONLY when both counts are known. (#1478)
  const firstTimeContributor =
    merged === null || closed === null ? null : merged === 0 && closed === 0;
  return {
    author: {
      priorMergedInRepo: merged,
      priorClosedInRepo: closed,
      accountAgeDays,
      firstTimeContributor,
    },
    partial: merged === null || closed === null || accountAgeDays === null,
  };
}

// ── Similar past PRs (commits-by-path → associated PRs, with revert detection) ───

/** Recent commits touching `path` as {sha, message}, or null on a non-OK reply / network error. */
async function fetchCommitsForPath(
  owner: string,
  repo: string,
  path: string,
  token: string,
  fetchImpl: typeof fetch,
  options: ScanOptions,
): Promise<Array<{ sha: string; message: string }> | null> {
  try {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?path=${encodeURIComponent(path)}&per_page=${COMMITS_PER_FILE}`;
    const json = await fetchGithubJson<Array<{
      sha?: string;
      commit?: { message?: string };
    }>>(url, token, fetchImpl, options, "github-commits");
    if (!json) return null;
    if (!Array.isArray(json)) return null;
    const out: Array<{ sha: string; message: string }> = [];
    for (const c of json) {
      if (typeof c.sha === "string") {
        out.push({ sha: c.sha, message: c.commit?.message ?? "" });
      }
    }
    addCount(options.diagnostics, "commitLookupCount", out.length);
    return out;
  } catch {
    return null;
  }
}

/** PRs associated with a commit as {number, title}, or null on a non-OK reply / network error. */
async function fetchPullsForCommit(
  owner: string,
  repo: string,
  sha: string,
  token: string,
  fetchImpl: typeof fetch,
  options: ScanOptions,
): Promise<Array<{ number: number; title: string }> | null> {
  if (!SHA_RE.test(sha)) return [];
  try {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/pulls`;
    const json = await fetchGithubJson<Array<{ number?: number; title?: string }>>(url, token, fetchImpl, options, "github-commit-pulls");
    if (!json) return null;
    if (!Array.isArray(json)) return null;
    const out: Array<{ number: number; title: string }> = [];
    for (const p of json) {
      if (typeof p.number === "number") {
        out.push({ number: p.number, title: typeof p.title === "string" ? p.title : "" });
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Collect the reverted PR number(s) from a revert commit/PR message into `into`. GitHub's revert title is
 *  `Revert "<original title> (#N)"` — the reverted PR is the number INSIDE the quoted original title, so we match
 *  only that. This avoids misclassifying a trailing revert-PR number or an unrelated `fixes #X` in the body. (#1478) */
export function collectRevertRefs(
  message: string | undefined,
  into: Set<number>,
): void {
  if (!message) return;
  for (const m of message.matchAll(/\brevert\s+"[^"]*\(#(\d+)\)"/gi)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) into.add(n);
  }
}

/** Past PRs that already changed the same files. `partial` is true when any commit/PR lookup failed or the global
 *  lookup budget capped the scan. A PR referenced by a revert commit is marked `reverted`; otherwise `merged`
 *  (commits-by-path only surface merged history). The current PR is excluded. */
async function buildSimilarPastPrs(
  owner: string,
  repo: string,
  token: string,
  files: NonNullable<EnrichRequest["files"]>,
  currentPrNumber: number,
  fetchImpl: typeof fetch,
  options: ScanOptions,
): Promise<{ similarPastPrs: HistoryFinding["similarPastPrs"]; partial: boolean }> {
  let partial = false;
  let lookups = 0;
  const revertedRefs = new Set<number>();
  const prs = new Map<number, { title: string; overlap: Set<string> }>();
  setPhase(options, "similar_past_prs");

  const filesToProbe = files.slice(0, MAX_FILES_PROBED);
  if (files.length > filesToProbe.length) {
    partial = true;
    options.diagnostics && (options.diagnostics.capped = true);
    addCount(options.diagnostics, "skippedFileCount", files.length - filesToProbe.length);
    markPartial(options, "github_file_lookup_capped");
  }

  for (const [index, file] of filesToProbe.entries()) {
    if (!hasResponseBudget(options)) {
      partial = true;
      options.diagnostics && (options.diagnostics.capped = true);
      addCount(options.diagnostics, "skippedFileCount", filesToProbe.length - index);
      markPartial(options, options.signal?.aborted ? "history_aborted" : "history_budget_exhausted", true);
      break;
    }

    const commits = await fetchCommitsForPath(owner, repo, file.path, token, fetchImpl, options);
    if (commits === null) {
      partial = true;
      continue;
    }
    for (const commit of commits) {
      if (!hasResponseBudget(options)) {
        partial = true;
        markPartial(options, options.signal?.aborted ? "history_aborted" : "history_budget_exhausted", true);
        break;
      }
      collectRevertRefs(commit.message, revertedRefs);
      if (lookups >= MAX_PR_LOOKUPS) {
        partial = true;
        options.diagnostics && (options.diagnostics.capped = true);
        markPartial(options, "github_pr_lookup_capped");
        continue;
      }
      lookups++;
      const pulls = await fetchPullsForCommit(owner, repo, commit.sha, token, fetchImpl, options);
      if (pulls === null) {
        partial = true;
        continue;
      }
      for (const pull of pulls) {
        if (pull.number === currentPrNumber) continue;
        const existing = prs.get(pull.number) ?? { title: pull.title, overlap: new Set<string>() };
        existing.overlap.add(file.path);
        prs.set(pull.number, existing);
      }
    }
  }

  const similarPastPrs = [...prs.entries()]
    .map(([number, value]) => ({
      number,
      title: value.title,
      outcome: (revertedRefs.has(number) ? "reverted" : "merged") as "merged" | "reverted",
      overlapPaths: [...value.overlap].sort(),
    }))
    .sort((a, b) => b.number - a.number)
    .slice(0, MAX_SIMILAR_PRS);
  return { similarPastPrs, partial };
}

// ── Analyzer entrypoint ─────────────────────────────────────────────────────────

/** Surface public-safe author + change-area history for the PR. Author context and similar-PR history need the
 *  request token; linked-issue alignment needs only the envelope. Fail-safe: any missing input or failed fetch
 *  degrades to a `partial` block (or [] when there is nothing to report) — never throws, never blocks the brief. */
export async function scanHistory(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<HistoryFinding[]> {
  const now = options.now ?? Date.now();
  const repo = parseRepo(req.repoFullName);
  const token = req.githubToken;
  if (options.diagnostics) {
    options.diagnostics.phase = "history";
    options.diagnostics.partialStatus ??= "complete";
    options.diagnostics.fileLookupCount ??= 0;
    options.diagnostics.commitLookupCount ??= 0;
    options.diagnostics.prLookupCount ??= 0;
    options.diagnostics.skippedFileCount ??= 0;
  }

  let author: HistoryFinding["author"] = null;
  let similarPastPrs: HistoryFinding["similarPastPrs"] = [];
  let partial = false;

  if (repo && token && req.author) {
    const ctx = await buildAuthorContext(repo.owner, repo.repo, req.author, token, fetchImpl, now, options);
    author = ctx.author;
    if (ctx.partial) partial = true;
  } else {
    // No repo/token/author ⇒ the author track record can't be computed; flag the block as incomplete.
    partial = true;
    markPartial(options, !repo ? "github_repo_invalid" : token ? "github_author_missing" : "github_token_missing");
  }

  if (repo && token && (req.files?.length ?? 0) > 0) {
    const similar = await buildSimilarPastPrs(repo.owner, repo.repo, token, req.files!, req.prNumber, fetchImpl, options);
    similarPastPrs = similar.similarPastPrs;
    if (similar.partial) partial = true;
  }

  const linkedIssueAlignment = buildLinkedIssueAlignment(req);

  // Nothing to report (no token AND no linked issue) ⇒ contribute nothing, byte-identical to before the analyzer.
  if (!author && similarPastPrs.length === 0 && !linkedIssueAlignment) return [];

  return [{ author, similarPastPrs, linkedIssueAlignment, partial }];
}
