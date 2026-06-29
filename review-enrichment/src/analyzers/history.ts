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
import type { EnrichRequest, HistoryFinding } from "../types.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_FILES_PROBED = 5; // bound the per-file commit-history fan-out
const COMMITS_PER_FILE = 10; // recent commits to inspect per probed file
const MAX_PR_LOOKUPS = 12; // global cap on commit→PR resolution calls
const MAX_SIMILAR_PRS = 8; // cap the rendered similar-PR list
const MIN_TOKEN_LENGTH = 4; // requirement keywords shorter than this are ignored
const FULL_COVERAGE_RATIO = 0.6; // >= this share of requirement keywords present in the diff ⇒ "full"

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

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "gittensory-review-enrichment",
  };
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
  const hay = haystack.toLowerCase();
  const covered = tokens.filter((t) => hay.includes(t)).length;
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
      if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
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
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=1`;
    const res = await fetchImpl(url, { headers: githubHeaders(token), signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { total_count?: number };
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
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const url = `${GITHUB_API}/users/${encodeURIComponent(login)}`;
    const res = await fetchImpl(url, { headers: githubHeaders(token), signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { created_at?: string };
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
  signal?: AbortSignal,
): Promise<{ author: NonNullable<HistoryFinding["author"]>; partial: boolean }> {
  const repoQ = `repo:${owner}/${repo} type:pr author:${author}`;
  const merged = await fetchSearchCount(`${repoQ} is:merged`, token, fetchImpl, signal);
  const closed = await fetchSearchCount(`${repoQ} is:unmerged is:closed`, token, fetchImpl, signal);
  const accountAgeDays = await fetchAccountAgeDays(author, token, fetchImpl, now, signal);
  const priorMergedInRepo = merged ?? 0;
  const priorClosedInRepo = closed ?? 0;
  return {
    author: {
      priorMergedInRepo,
      priorClosedInRepo,
      accountAgeDays,
      firstTimeContributor: priorMergedInRepo === 0 && priorClosedInRepo === 0,
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
  signal?: AbortSignal,
): Promise<Array<{ sha: string; message: string }> | null> {
  try {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?path=${encodeURIComponent(path)}&per_page=${COMMITS_PER_FILE}`;
    const res = await fetchImpl(url, { headers: githubHeaders(token), signal });
    if (!res.ok) return null;
    const json = (await res.json()) as Array<{
      sha?: string;
      commit?: { message?: string };
    }>;
    if (!Array.isArray(json)) return null;
    const out: Array<{ sha: string; message: string }> = [];
    for (const c of json) {
      if (typeof c.sha === "string") {
        out.push({ sha: c.sha, message: c.commit?.message ?? "" });
      }
    }
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
  signal?: AbortSignal,
): Promise<Array<{ number: number; title: string }> | null> {
  if (!SHA_RE.test(sha)) return [];
  try {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/pulls`;
    const res = await fetchImpl(url, { headers: githubHeaders(token), signal });
    if (!res.ok) return null;
    const json = (await res.json()) as Array<{ number?: number; title?: string }>;
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

/** Collect PR numbers referenced by a revert commit message (`Revert "…" (#N)`, `This reverts … #N`) into `into`. */
export function collectRevertRefs(
  message: string | undefined,
  into: Set<number>,
): void {
  if (!message || !/\brevert/i.test(message)) return;
  for (const m of message.matchAll(/#(\d+)/g)) {
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
  signal?: AbortSignal,
): Promise<{ similarPastPrs: HistoryFinding["similarPastPrs"]; partial: boolean }> {
  let partial = false;
  let lookups = 0;
  const revertedRefs = new Set<number>();
  const prs = new Map<number, { title: string; overlap: Set<string> }>();

  for (const file of files.slice(0, MAX_FILES_PROBED)) {
    const commits = await fetchCommitsForPath(owner, repo, file.path, token, fetchImpl, signal);
    if (commits === null) {
      partial = true;
      continue;
    }
    for (const commit of commits) {
      collectRevertRefs(commit.message, revertedRefs);
      if (lookups >= MAX_PR_LOOKUPS) {
        partial = true;
        continue;
      }
      lookups++;
      const pulls = await fetchPullsForCommit(owner, repo, commit.sha, token, fetchImpl, signal);
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

  let author: HistoryFinding["author"] = null;
  let similarPastPrs: HistoryFinding["similarPastPrs"] = [];
  let partial = false;

  if (repo && token && req.author) {
    const ctx = await buildAuthorContext(repo.owner, repo.repo, req.author, token, fetchImpl, now, options.signal);
    author = ctx.author;
    if (ctx.partial) partial = true;
  } else {
    // No repo/token/author ⇒ the author track record can't be computed; flag the block as incomplete.
    partial = true;
  }

  if (repo && token && (req.files?.length ?? 0) > 0) {
    const similar = await buildSimilarPastPrs(repo.owner, repo.repo, token, req.files!, req.prNumber, fetchImpl, options.signal);
    similarPastPrs = similar.similarPastPrs;
    if (similar.partial) partial = true;
  }

  const linkedIssueAlignment = buildLinkedIssueAlignment(req);

  // Nothing to report (no token AND no linked issue) ⇒ contribute nothing, byte-identical to before the analyzer.
  if (!author && similarPastPrs.length === 0 && !linkedIssueAlignment) return [];

  return [{ author, similarPastPrs, linkedIssueAlignment, partial }];
}
