// Review/approval integrity signals, read from structured PR-reviews data only — no diff/text/YAML parsing.
// Surfaces cases a PR's own page does not always make obvious without branch protection's "dismiss stale reviews"
// setting enabled: an APPROVED review that predates the current head commit (new pushes landed since the
// approval), the PR author approving their own PR, and a reviewer whose CURRENT (most recent) review is still
// CHANGES_REQUESTED. Reads only documented fields from the GitHub PR-reviews API (state, commit_id, user.login,
// submitted_at) and compares them — no ambiguous-syntax parsing, so it cannot suffer a patch scanner's edge cases.
// Pure GitHub-metadata read, no repo content. Fail-safe: no token, no head SHA, a bad repo slug, or a fetch error
// all yield no finding. Bounded to MAX_PAGES pages of reviews (REVIEWS_PER_PAGE each) — a pathological PR can't
// spin the analyzer, but any realistic PR's full review history is read, not just its oldest page.
import type {
  AnalyzerDiagnostics,
  ApprovalIntegrityFinding,
  EnrichRequest,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const REVIEWS_PER_PAGE = 100;
// GitHub returns PR reviews oldest-first with no reorder option, so a single `per_page=100` fetch would silently
// read only the OLDEST reviews on any PR with more — exactly backwards for "each reviewer's latest vote". Walk
// pages instead, bounded so a pathological PR can't spin (mirrors this repo's own PR_DETAIL_MAX_PAGES convention).
const MAX_PAGES = 10;
const SHA_PREFIX_LEN = 12;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

/** The slice of a GitHub PR-review list item this analyzer reads. */
interface ReviewListItem {
  user?: { login?: string } | null;
  state?: string;
  commit_id?: string;
  submitted_at?: string | null;
}

/** One reviewer's current (most recent submitted) vote. */
interface LatestReview {
  login: string;
  state: string;
  commitId: string | undefined;
  submittedAt: string;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchReviewsPage(
  owner: string,
  repo: string,
  prNumber: number,
  page: number,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<ReviewListItem[] | null> {
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/` +
    `${encodeURIComponent(String(prNumber))}/reviews?per_page=${REVIEWS_PER_PAGE}&page=${page}`;
  const fetchOptions = {
    endpointCategory: "github-pr-reviews",
    headers,
    signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "approval-integrity",
    subcall: "github-pr-reviews",
    maxBytes: 512 * 1024,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<ReviewListItem[]>(url, fetchOptions)
    : await boundedFetchJson<ReviewListItem[]>(url, fetchOptions);
  return response.ok && Array.isArray(response.data) ? response.data : null;
}

/** Walks review pages (oldest-first, as GitHub returns them) up to MAX_PAGES, so `latestReviewPerReviewer` sees
 *  every reviewer's true latest vote rather than just the oldest page. A short page (fewer than REVIEWS_PER_PAGE
 *  items) confirms there is nothing further — no Link-header parsing needed — and only THEN is the list returned.
 *  Unlike a purely additive signal (e.g. blame-link's "last touched by"), a PARTIAL oldest-first list here is not
 *  a smaller-but-still-correct result — it is actively WRONG: a reviewer's true latest vote could sit on a page
 *  never read, making a resolved CHANGES_REQUESTED or a fresh APPROVED look stuck/stale. So any page failure, OR
 *  exhausting MAX_PAGES while the last page fetched was still full (pagination not confirmed complete), fails
 *  the whole call closed (null) rather than treating incomplete history as authoritative. */
async function fetchReviews(
  owner: string,
  repo: string,
  prNumber: number,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<ReviewListItem[] | null> {
  const items: ReviewListItem[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const pageItems = await fetchReviewsPage(owner, repo, prNumber, page, headers, fetchFn, signal, options);
    if (!pageItems) return null; // any page failing means we cannot trust what we have so far
    items.push(...pageItems);
    if (pageItems.length < REVIEWS_PER_PAGE) return items; // confirmed: this was the last page
  }
  return null; // MAX_PAGES exhausted with a still-full final page — completeness unconfirmed
}

/** Reduces a PR's review list to one entry per reviewer: the review with the latest `submitted_at`. This mirrors
 *  GitHub's own semantics for "a reviewer's current vote" — a later review of ANY state supersedes an earlier one
 *  from the same person, including a dismissal (the API reports a dismissed review back with `state: "DISMISSED"`,
 *  so a dismissed CHANGES_REQUESTED naturally stops counting as outstanding without any extra handling here).
 *  Reviews with no `submitted_at` (a still-open PENDING draft review) are excluded — not yet a submitted vote.
 *  Login comparison is case-insensitive (GitHub logins are case-insensitive), keyed on the lowercased login.
 *  `reviews` must be in GitHub's own (oldest-first) API order: on a `submitted_at` tie (same timestamp
 *  precision), the LATER item in that order wins, using API order itself as the tie-break. Pure. */
export function latestReviewPerReviewer(reviews: ReviewListItem[]): Map<string, LatestReview> {
  const latest = new Map<string, LatestReview>();
  for (const review of reviews) {
    const login = review.user?.login;
    const state = review.state;
    const submittedAt = review.submitted_at;
    if (!login || !state || !submittedAt) continue;
    const key = login.toLowerCase();
    const existing = latest.get(key);
    if (!existing || submittedAt >= existing.submittedAt) {
      latest.set(key, { login, state, commitId: review.commit_id, submittedAt });
    }
  }
  return latest;
}

/** Analyzer entrypoint: a PR's reviews → stale/self/outstanding approval-integrity findings. Fail-safe — no token,
 *  no head SHA, a bad repo slug, or a fetch error all yield no finding rather than an error. */
export async function scanApprovalIntegrity(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<ApprovalIntegrityFinding[]> {
  const { repoFullName, githubToken, headSha, author, prNumber } = req;
  if (!githubToken || !headSha) return [];
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers = githubHeaders(githubToken);
  const reviews = await fetchReviews(owner, repo, prNumber, headers, fetchFn, options.signal, options);
  if (!reviews) return [];

  const findings: ApprovalIntegrityFinding[] = [];
  const authorKey = author?.toLowerCase();
  const headShaKey = headSha.toLowerCase();
  for (const { login, state, commitId } of latestReviewPerReviewer(reviews).values()) {
    if (state === "APPROVED") {
      if (commitId && commitId.toLowerCase() !== headShaKey) {
        findings.push({
          reviewer: login,
          kind: "stale-approval",
          reviewedShaPrefix: commitId.slice(0, SHA_PREFIX_LEN),
        });
      }
      if (authorKey && login.toLowerCase() === authorKey) {
        findings.push({ reviewer: login, kind: "self-approval" });
      }
    } else if (state === "CHANGES_REQUESTED") {
      findings.push({ reviewer: login, kind: "outstanding-changes-requested" });
    }
  }
  return findings;
}
