// GitHub-backed enrichment prefetch (#1697 security fix). Installation tokens stay in the engine —
// REES receives only derived, public-safe findings over the shared-secret wire, never raw credentials.
import { createInstallationToken } from "../github/app";
import type { PullRequestFileRecord } from "../types";

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_LINKED_ISSUES = 8;
const NEWCOMER_MERGED_THRESHOLD = 3;
const MAX_BODY_CHARS = 8000;

const LINKED_ISSUE_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s*)?#(\d+)\b/gi;

export interface EnrichmentLinkedIssueFinding {
  number: number;
  repo: string;
  state: string | null;
  title: string | null;
  aligned: boolean;
}

export interface EnrichmentHistoryFinding {
  authorLogin: string;
  mergedPrCount: number | null;
  authorTier: "newcomer" | "established" | "unknown";
  linkedIssues: EnrichmentLinkedIssueFinding[];
}

export interface EnrichmentPrefetch {
  history?: EnrichmentHistoryFinding | null;
}

export interface EnrichmentPrefetchInput {
  repoFullName: string;
  author?: string | undefined;
  body?: string | undefined;
  installationId?: number | null | undefined;
  files?: PullRequestFileRecord[];
}

/** Best-effort GitHub token for engine-side prefetch — installation token, then public token. */
export async function resolveEnrichmentGithubToken(
  env: Env,
  installationId: number | null | undefined,
): Promise<string | undefined> {
  if (installationId) {
    const token = await createInstallationToken(env, installationId).catch(
      () => undefined,
    );
    if (token) return token;
  }
  return env.GITHUB_PUBLIC_TOKEN ?? undefined;
}

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
    const repoFullName = owner && repo ? `${owner}/${repo}` : defaultRepo;
    const key = `${repoFullName}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    linked.push({ repo: repoFullName, number });
    if (linked.length >= MAX_LINKED_ISSUES) break;
  }
  return linked;
}

function parseRepoParts(
  repoFullName: string,
): { owner: string; repo: string } | null {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) {
    return null;
  }
  return { owner, repo };
}

async function fetchJson<T>(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    const resp = await fetch(
      url,
      signal ? { headers, signal } : { headers },
    );
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchAuthorMergedCount(
  repoFullName: string,
  author: string,
  githubToken: string,
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
    signal,
  );
  return typeof payload?.total_count === "number" ? payload.total_count : null;
}

async function fetchLinkedIssue(
  repo: string,
  number: number,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<EnrichmentLinkedIssueFinding> {
  const parts = parseRepoParts(repo);
  if (!parts) {
    return { number, repo, state: null, title: null, aligned: false };
  }
  const payload = await fetchJson<{ state?: string; title?: string }>(
    `https://api.github.com/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/issues/${number}`,
    headers,
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
): EnrichmentHistoryFinding["authorTier"] {
  if (mergedCount === null) return "unknown";
  return mergedCount < NEWCOMER_MERGED_THRESHOLD ? "newcomer" : "established";
}

/** Build history findings locally (fail-safe). Without a token, linked issues are parsed from the body only. */
export async function prefetchEnrichmentHistory(
  input: EnrichmentPrefetchInput,
  githubToken?: string,
  signal?: AbortSignal,
): Promise<EnrichmentHistoryFinding | null> {
  const author = input.author?.replace(/^@/, "") ?? "";
  if (!author) return null;

  const linkedRefs = extractLinkedIssues(input.body, input.repoFullName);
  let mergedPrCount: number | null = null;
  const linkedIssues: EnrichmentLinkedIssueFinding[] = [];

  if (githubToken) {
    const headers = {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    mergedPrCount = await fetchAuthorMergedCount(
      input.repoFullName,
      author,
      githubToken,
      signal,
    );
    for (const ref of linkedRefs) {
      linkedIssues.push(
        await fetchLinkedIssue(ref.repo, ref.number, headers, signal),
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

/** Prefetch GitHub-derived enrichment context in the engine. Tokens never leave this process. */
export async function prefetchEnrichmentGitHubContext(
  env: Env,
  input: EnrichmentPrefetchInput,
): Promise<EnrichmentPrefetch> {
  const token = await resolveEnrichmentGithubToken(env, input.installationId);
  const history = await prefetchEnrichmentHistory(input, token);
  return { history };
}
