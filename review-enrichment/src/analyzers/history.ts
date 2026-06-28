// History analyzer (#1697 / #1478). Uses PR metadata + optional GitHub API access to surface author track
// record and linked-issue alignment — context the diff-only reviewer cannot infer. Fail-safe: returns a
// degraded finding set when no token is available (linked-issue parsing still runs on the body).
import type { EnrichRequest, HistoryFinding, LinkedIssueFinding } from "../types.js";

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_LINKED_ISSUES = 8;
const NEWCOMER_MERGED_THRESHOLD = 3;
const MAX_BODY_CHARS = 8000;

const LINKED_ISSUE_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s*)?#(\d+)\b/gi;

/** Parse `Fixes #123` / `Closes org/repo#456` references from the PR body. Pure. */
export function extractLinkedIssues(
  body: string | undefined,
  defaultRepo: string,
): Array<{ repo: string; number: number }> {
  const text = (body ?? "").slice(0, MAX_BODY_CHARS);
  const seen = new Set<string>();
  const linked: Array<{ repo: string; number: number }> = [];
  for (const match of text.matchAll(LINKED_ISSUE_RE)) {
    const owner = match[1];
    const repo = match[2];
    const number = Number(match[3]);
    if (!Number.isFinite(number) || number <= 0) continue;
    const repoFullName =
      owner && repo ? `${owner}/${repo}` : defaultRepo;
    const key = `${repoFullName}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    linked.push({ repo: repoFullName, number });
    if (linked.length >= MAX_LINKED_ISSUES) break;
  }
  return linked;
}

function parseRepoParts(repoFullName: string): { owner: string; repo: string } | null {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return null;
  return { owner, repo };
}

async function fetchJson<T>(
  url: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    const resp = await fetchFn(url, { headers, signal });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/** Count merged PRs by the author in this repo (search API, bounded). */
export async function fetchAuthorMergedCount(
  repoFullName: string,
  author: string,
  githubToken: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<number | null> {
  const parts = parseRepoParts(repoFullName);
  if (!parts || !SLUG_RE.test(author.replace(/^@/, ""))) return null;
  const q = encodeURIComponent(
    `repo:${repoFullName} author:${author.replace(/^@/, "")} is:pr is:merged`,
  );
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const payload = await fetchJson<{ total_count?: number }>(
    `https://api.github.com/search/issues?q=${q}&per_page=1`,
    headers,
    fetchFn,
    signal,
  );
  return typeof payload?.total_count === "number" ? payload.total_count : null;
}

/** Fetch issue state/title for a linked reference. */
async function fetchLinkedIssue(
  repo: string,
  number: number,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<LinkedIssueFinding> {
  const parts = parseRepoParts(repo);
  if (!parts) {
    return {
      number,
      repo,
      state: null,
      title: null,
      aligned: false,
    };
  }
  const payload = await fetchJson<{ state?: string; title?: string }>(
    `https://api.github.com/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/issues/${number}`,
    headers,
    fetchFn,
    signal,
  );
  const state = payload?.state ?? null;
  return {
    number,
    repo,
    state,
    title: payload?.title ?? null,
    aligned: state === "open" || state === "closed",
  };
}

export function classifyAuthorTier(
  mergedCount: number | null,
): HistoryFinding["authorTier"] {
  if (mergedCount === null) return "unknown";
  return mergedCount < NEWCOMER_MERGED_THRESHOLD ? "newcomer" : "established";
}

/** Analyzer entrypoint: linked issues + optional author history via GitHub API. */
export async function scanHistory(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  opts?: { signal?: AbortSignal },
): Promise<HistoryFinding | null> {
  const author = req.author?.replace(/^@/, "") ?? "";
  if (!author) return null;

  const linkedRefs = extractLinkedIssues(req.body, req.repoFullName);
  let mergedPrCount: number | null = null;
  const linkedIssues: LinkedIssueFinding[] = [];

  if (req.githubToken) {
    const headers = {
      Authorization: `Bearer ${req.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    mergedPrCount = await fetchAuthorMergedCount(
      req.repoFullName,
      author,
      req.githubToken,
      fetchFn,
      opts?.signal,
    );
    for (const ref of linkedRefs) {
      linkedIssues.push(
        await fetchLinkedIssue(ref.repo, ref.number, headers, fetchFn, opts?.signal),
      );
    }
  } else {
    for (const ref of linkedRefs) {
      linkedIssues.push({
        number: ref.number,
        repo: ref.repo,
        state: null,
        title: null,
        aligned: true,
      });
    }
  }

  if (!linkedIssues.length && mergedPrCount === null) {
    return {
      authorLogin: author,
      mergedPrCount: null,
      authorTier: "unknown",
      linkedIssues: [],
    };
  }

  return {
    authorLogin: author,
    mergedPrCount,
    authorTier: classifyAuthorTier(mergedPrCount),
    linkedIssues,
  };
}
