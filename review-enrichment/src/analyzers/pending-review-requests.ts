// Pending review-request staleness, read from structured GitHub API fields only — no diff/text/YAML parsing.
// Surfaces a reviewer or team whose review request has been outstanding a long time with no response yet — a
// PR's own page shows WHO was requested, but not HOW LONG they've been waiting. Combines the requested-reviewers
// endpoint (the current pending set) with the issue-timeline API (each `review_requested` event's timestamp) to
// compute how long the most recent request to each still-pending reviewer has been open. Reads only documented
// fields (user.login, team.slug, event, created_at) and compares them — no ambiguous-syntax parsing, so it
// cannot suffer a patch scanner's edge cases. Pure GitHub-metadata read, no repo content. Fail-safe: no token, a
// bad repo slug, either fetch failing, or an unconfirmed-complete timeline (still-full last page) all yield no
// finding — like approval-integrity, this reports on CURRENT state, so incomplete history must fail closed
// rather than risk understating (and thus mis-reporting) how long a request has actually been pending.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  PendingReviewRequestFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { githubHeaders } from "../github-headers.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const TIMELINE_PER_PAGE = 100;
const MAX_TIMELINE_PAGES = 5;
const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
  /** Injectable clock so staleness math is deterministic in tests; defaults to Date.now(). */
  now?: number;
}

interface RequestedReviewers {
  users?: Array<{ login?: string }>;
  teams?: Array<{ slug?: string }>;
}

interface TimelineEvent {
  event?: string;
  created_at?: string;
  requested_reviewer?: { login?: string };
  requested_team?: { slug?: string };
}

async function fetchRequestedReviewers(
  owner: string,
  repo: string,
  prNumber: number,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<RequestedReviewers | null> {
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/` +
    `${encodeURIComponent(String(prNumber))}/requested_reviewers`;
  const fetchOptions = {
    endpointCategory: "github-requested-reviewers",
    headers,
    signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "pending-review-requests",
    subcall: "github-requested-reviewers",
    maxBytes: 256 * 1024,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<RequestedReviewers>(url, fetchOptions)
    : await boundedFetchJson<RequestedReviewers>(url, fetchOptions);
  return response.ok ? response.data : null;
}

async function fetchTimelinePage(
  owner: string,
  repo: string,
  prNumber: number,
  page: number,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<TimelineEvent[] | null> {
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/` +
    `${encodeURIComponent(String(prNumber))}/timeline?per_page=${TIMELINE_PER_PAGE}&page=${page}`;
  const fetchOptions = {
    endpointCategory: "github-issue-timeline",
    headers,
    signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "pending-review-requests",
    subcall: "github-issue-timeline",
    maxBytes: 512 * 1024,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<TimelineEvent[]>(url, fetchOptions)
    : await boundedFetchJson<TimelineEvent[]>(url, fetchOptions);
  return response.ok && Array.isArray(response.data) ? response.data : null;
}

/** Walks timeline pages up to MAX_TIMELINE_PAGES. Like approval-integrity's review pagination, a short page
 *  (< TIMELINE_PER_PAGE items) is the only way to confirm there is nothing further; any page failure, or
 *  exhausting the page cap while the last page was still full, fails the whole call closed (null) — this
 *  analyzer reports how long a request has been pending, so an incomplete timeline could understate that
 *  duration and report a fresher request as stale, or hide a truly stale one behind a later re-request event. */
async function fetchFullTimeline(
  owner: string,
  repo: string,
  prNumber: number,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<TimelineEvent[] | null> {
  const events: TimelineEvent[] = [];
  for (let page = 1; page <= MAX_TIMELINE_PAGES; page += 1) {
    const pageEvents = await fetchTimelinePage(owner, repo, prNumber, page, headers, fetchFn, signal, options);
    if (!pageEvents) return null;
    events.push(...pageEvents);
    if (pageEvents.length < TIMELINE_PER_PAGE) return events;
  }
  return null;
}

/** Pure: the latest `review_requested` timestamp (ISO string) per reviewer login (lowercased) and per team slug
 *  (lowercased, keyed as `team:slug`), from timeline events in API (oldest-first) order — a later event of the
 *  same reviewer/team always overwrites an earlier one, so this is always each one's MOST RECENT request. */
export function latestReviewRequestTimes(events: TimelineEvent[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const event of events) {
    if (event.event !== "review_requested" || !event.created_at) continue;
    const userKey = event.requested_reviewer?.login?.toLowerCase();
    const teamKey = event.requested_team?.slug ? `team:${event.requested_team.slug.toLowerCase()}` : undefined;
    const key = userKey ?? teamKey;
    if (!key) continue;
    latest.set(key, event.created_at);
  }
  return latest;
}

/** Pure reduction: the current pending-reviewer set + the timeline's latest-request timestamps → staleness
 *  findings. A pending reviewer/team with no matching `review_requested` event in the (confirmed-complete)
 *  timeline is skipped, not guessed at. Pure. */
export function evaluatePendingReviewRequests(
  requested: RequestedReviewers,
  requestTimes: Map<string, string>,
  now: number,
): PendingReviewRequestFinding[] {
  const findings: PendingReviewRequestFinding[] = [];

  for (const user of requested.users ?? []) {
    const login = user.login;
    if (!login) continue;
    const requestedAt = requestTimes.get(login.toLowerCase());
    if (!requestedAt) continue;
    const hoursPending = (now - Date.parse(requestedAt)) / (60 * 60 * 1000);
    if (Number.isFinite(hoursPending) && hoursPending * 60 * 60 * 1000 >= STALE_THRESHOLD_MS) {
      findings.push({ reviewer: login, hoursPending: Math.round(hoursPending) });
    }
  }

  for (const team of requested.teams ?? []) {
    const slug = team.slug;
    if (!slug) continue;
    const requestedAt = requestTimes.get(`team:${slug.toLowerCase()}`);
    if (!requestedAt) continue;
    const hoursPending = (now - Date.parse(requestedAt)) / (60 * 60 * 1000);
    if (Number.isFinite(hoursPending) && hoursPending * 60 * 60 * 1000 >= STALE_THRESHOLD_MS) {
      findings.push({ reviewer: `team:${slug}`, hoursPending: Math.round(hoursPending) });
    }
  }

  return findings;
}

/** Analyzer entrypoint: a PR's pending review requests + timeline → staleness findings. Fail-safe — no token, a
 *  bad repo slug, either fetch failing, or an unconfirmed-complete timeline all yield no finding. */
export async function scanPendingReviewRequests(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<PendingReviewRequestFinding[]> {
  const { repoFullName, githubToken, prNumber } = req;
  if (!githubToken) return [];
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers = githubHeaders(githubToken);
  const requested = await fetchRequestedReviewers(owner, repo, prNumber, headers, fetchFn, options.signal, options);
  if (!requested) return [];
  if (!requested.users?.length && !requested.teams?.length) return [];

  const timeline = await fetchFullTimeline(owner, repo, prNumber, headers, fetchFn, options.signal, options);
  if (!timeline) return [];

  const requestTimes = latestReviewRequestTimes(timeline);
  return evaluatePendingReviewRequests(requested, requestTimes, options.now ?? Date.now());
}
