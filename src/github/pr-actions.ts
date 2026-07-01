import { createInstallationToken } from "./app";
import { githubRateLimitAdmissionKeyForInstallation, makeInstallationOctokit } from "./client";
import type { AgentActionMode } from "../settings/agent-execution";
import type { AutoMergeMethod } from "../types";

const ISSUE_EVENTS_PAGE_SIZE = 100;
const ISSUE_EVENTS_RECENT_PAGE_LIMIT = 10;
// Reviews are returned oldest-first with no sort override, so finding the LATEST bot approval means walking
// every page rather than stopping at the first — a single per_page:100 fetch would only see the bot's
// earliest reviews on a PR with a long review history and could dismiss (or miss) the wrong one.
const REVIEW_PAGE_SIZE = 100;
const REVIEW_PAGE_LIMIT = 10;

// The GitHub write primitives the maintainer auto-maintain layer (#778) uses to act on a PR's STATE — never
// its source. Thin wrappers over the installation-scoped REST API, mirroring labels.ts / comments.ts. Each
// throws on a non-2xx response; the action executor owns the try/catch + audit so a failed mutation is
// recorded, not swallowed.

function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository full name: ${repoFullName}`);
  return { owner, repo };
}

export type PullRequestReviewEvent = "REQUEST_CHANGES" | "APPROVE" | "COMMENT";

/** Post a pull-request review (request-changes / approve / comment). `body` is required for REQUEST_CHANGES. */
export async function createPullRequestReview(
  env: Env,
  installationId: number,
  repoFullName: string,
  pullNumber: number,
  event: PullRequestReviewEvent,
  body: string,
): Promise<{ id: number }> {
  const { owner, repo } = splitRepo(repoFullName);
  const token = await createInstallationToken(env, installationId);
  const octokit = makeInstallationOctokit(env, token, "live", githubRateLimitAdmissionKeyForInstallation(installationId));
  const response = await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner,
    repo,
    pull_number: pullNumber,
    event,
    body,
  });
  return { id: (response.data as { id: number }).id };
}

/** Post a quiet, NON-BLOCKING review (`event: "COMMENT"`) carrying line-anchored inline comments — the
 *  CodeRabbit-style inline code notes (#inline-comments). `commitId` anchors them to the reviewed head SHA so
 *  GitHub places each on the right diff line. Mirrors {@link createPullRequestReview}; the action `mode` is
 *  threaded so a dry-run instance suppresses the write. Throws on a non-2xx — the caller
 *  (`postInlineReviewComments`) owns the fail-safe try/catch + audit. */
export async function createPullRequestReviewComments(
  env: Env,
  installationId: number,
  repoFullName: string,
  pullNumber: number,
  commitId: string,
  comments: Array<{ path: string; line: number; side: "RIGHT" | "LEFT"; body: string }>,
  mode: AgentActionMode,
): Promise<{ id: number }> {
  const { owner, repo } = splitRepo(repoFullName);
  const token = await createInstallationToken(env, installationId);
  const octokit = makeInstallationOctokit(env, token, mode, githubRateLimitAdmissionKeyForInstallation(installationId));
  const response = await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: commitId,
    event: "COMMENT",
    comments,
  });
  return { id: (response.data as { id: number }).id };
}

/** Merge a pull request with the configured method. Pass `sha` to make the merge fail (409) if the head moved
 *  since we evaluated it — a guard against merging a PR that changed under us. */
export async function mergePullRequest(
  env: Env,
  installationId: number,
  repoFullName: string,
  pullNumber: number,
  options: { mergeMethod: AutoMergeMethod; sha?: string | undefined },
): Promise<{ merged: boolean; sha: string | null }> {
  const { owner, repo } = splitRepo(repoFullName);
  const token = await createInstallationToken(env, installationId);
  const octokit = makeInstallationOctokit(env, token, "live", githubRateLimitAdmissionKeyForInstallation(installationId));
  const response = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
    owner,
    repo,
    pull_number: pullNumber,
    merge_method: options.mergeMethod,
    ...(options.sha ? { sha: options.sha } : {}),
  });
  const data = response.data as { merged?: boolean; sha?: string };
  return { merged: data.merged ?? true, sha: data.sha ?? null };
}

/** Dismiss the bot's own most recent APPROVE review (#2254). GitHub's `reviewDecision` is derived from the
 *  LATEST review per reviewer, so a stale bot approval left in place after a later commit no longer qualifies
 *  can still satisfy a "require approving reviews" branch-protection rule and let a human merge un-reviewed
 *  code directly on GitHub, bypassing this gate entirely. Best-effort: any failure (no bot review found, the
 *  review already dismissed, a transient API error) returns `dismissed: false` rather than throwing — this is
 *  a cleanup action, not the primary mutation, and must never crash the maintenance pass it runs alongside. */
export async function dismissLatestBotApproval(env: Env, installationId: number, repoFullName: string, pullNumber: number, message: string): Promise<{ dismissed: boolean }> {
  try {
    const { owner, repo } = splitRepo(repoFullName);
    const token = await createInstallationToken(env, installationId);
    const octokit = makeInstallationOctokit(env, token, "live", githubRateLimitAdmissionKeyForInstallation(installationId));
    const botLogin = `${env.GITHUB_APP_SLUG}[bot]`;
    // Reviews are returned oldest-first; the LAST matching entry across ALL pages is the bot's most recent
    // APPROVE. Stopping at page 1 would find (or miss) the wrong review on a PR with >100 total reviews.
    let latestApprovalId: number | undefined;
    for (let page = 1; page <= REVIEW_PAGE_LIMIT; page += 1) {
      const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo, pull_number: pullNumber, per_page: REVIEW_PAGE_SIZE, page });
      const batch = response.data as Array<{ id: number; state?: string; user?: { login?: string | null } | null }>;
      for (const review of batch) {
        if (review.user?.login === botLogin && review.state === "APPROVED") latestApprovalId = review.id;
      }
      if (batch.length < REVIEW_PAGE_SIZE) break;
    }
    if (latestApprovalId === undefined) return { dismissed: false };
    await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals", {
      owner,
      repo,
      pull_number: pullNumber,
      review_id: latestApprovalId,
      message,
      event: "DISMISS",
    });
    return { dismissed: true };
  } catch {
    return { dismissed: false };
  }
}

/** Rebase a PR onto its base via GitHub's update-branch (merges the current base into the PR head). Keeps a
 *  BEHIND PR current before reviewing/merging so the review + required CI run against the merged result —
 *  reviewbot parity. `expectedHeadSha` guards against racing a head that moved since we read it. The PUT
 *  returns 202 (update queued) on success; a caller treats any throw as best-effort (e.g. 422 when already
 *  up to date or the branch is dirty/conflicting — those are handled by the gate, not retried here). */
export async function updatePullRequestBranch(
  env: Env,
  installationId: number,
  repoFullName: string,
  pullNumber: number,
  expectedHeadSha?: string | undefined,
): Promise<void> {
  const { owner, repo } = splitRepo(repoFullName);
  const token = await createInstallationToken(env, installationId);
  const octokit = makeInstallationOctokit(env, token, "live", githubRateLimitAdmissionKeyForInstallation(installationId));
  await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch", {
    owner,
    repo,
    pull_number: pullNumber,
    ...(expectedHeadSha ? { expected_head_sha: expectedHeadSha } : {}),
  });
}

/** Post a plain issue/PR comment (used for the templated close message before closing). */
export async function createIssueComment(env: Env, installationId: number, repoFullName: string, issueNumber: number, body: string): Promise<{ id: number }> {
  const { owner, repo } = splitRepo(repoFullName);
  const token = await createInstallationToken(env, installationId);
  const octokit = makeInstallationOctokit(env, token, "live", githubRateLimitAdmissionKeyForInstallation(installationId));
  const response = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return { id: (response.data as { id: number }).id };
}

/** Close a pull request (sets state=closed) without merging. */
export async function closePullRequest(env: Env, installationId: number, repoFullName: string, pullNumber: number): Promise<{ state: string }> {
  const { owner, repo } = splitRepo(repoFullName);
  const token = await createInstallationToken(env, installationId);
  const octokit = makeInstallationOctokit(env, token, "live", githubRateLimitAdmissionKeyForInstallation(installationId));
  const response = await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: pullNumber,
    state: "closed",
  });
  return { state: (response.data as { state: string }).state };
}

/** The last-closer lookup result. `coveredAllPages` is false when the bounded newest-events window did NOT reach
 *  back to page 1 (a very long timeline), so a `login: null` may mean "no close found" OR "a close exists beyond
 *  the inspected window". The reopen guard uses this to fail CLOSED rather than allow a window-evasion bypass. */
export type LastCloserResult = { login: string | null; coveredAllPages: boolean };

/** Event-agnostic alias for {@link LastCloserResult} — the shape is identical for any single timeline-event-type
 *  lookup (e.g. "closed" or "reopened"); kept as an alias rather than a rename so existing importers of
 *  `LastCloserResult` are unaffected. */
export type LastTimelineActorResult = LastCloserResult;

/** Reopen-prevention (#one-shot-reopen): the login of whoever LAST closed this PR (most recent `closed` event in
 *  the issue-events timeline), or null if none / on error. Lets the reopen handler distinguish a maintainer/bot
 *  close (one-shot — a contributor may not reopen) from a contributor self-close (which they MAY reopen).
 *  `coveredAllPages` reports whether the bounded scan inspected the entire timeline (#audit-2.4). */
export async function getLastCloserLogin(env: Env, installationId: number, repoFullName: string, issueNumber: number): Promise<LastCloserResult> {
  return getLastActorForEvent(env, installationId, repoFullName, issueNumber, "closed");
}

/** Reopen-race guard (#2369): the login of whoever most recently REOPENED this PR (most recent `reopened` event in
 *  the issue-events timeline), or null if none / on error. Lets `maybeRecloseDisallowedReopen` re-verify — right
 *  before it re-closes a disallowed reopen — that the reopen it is reacting to is still the CURRENT reason the PR
 *  is open, rather than blindly undoing a DIFFERENT, later, legitimately-authorized reopen (e.g. a maintainer
 *  reopening again after the original disallowed reopen). Same pagination/fail-conservative semantics as
 *  {@link getLastCloserLogin}. */
export async function getLastReopenerLogin(env: Env, installationId: number, repoFullName: string, issueNumber: number): Promise<LastTimelineActorResult> {
  return getLastActorForEvent(env, installationId, repoFullName, issueNumber, "reopened");
}

/** Shared timeline-scan engine behind {@link getLastCloserLogin} and {@link getLastReopenerLogin}: finds the actor
 *  of the most recent issue-event matching `eventType`, scanning the newest bounded page window rather than the
 *  oldest prefix (see the pagination comments below — identical for either event type). Factored out so the two
 *  callers do not duplicate the pagination/fail-conservative logic. */
async function getLastActorForEvent(env: Env, installationId: number, repoFullName: string, issueNumber: number, eventType: string): Promise<LastTimelineActorResult> {
  try {
    const { owner, repo } = splitRepo(repoFullName);
    const token = await createInstallationToken(env, installationId);
    const octokit = makeInstallationOctokit(env, token, "live", githubRateLimitAdmissionKeyForInstallation(installationId));
    const requestPage = (page: number) =>
      octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/events", { owner, repo, issue_number: issueNumber, per_page: ISSUE_EVENTS_PAGE_SIZE, page });
    const firstResponse = await requestPage(1);
    const firstEvents = firstResponse.data as Array<{ event?: string; actor?: { login?: string | null } | null }>;
    const lastPage = issueEventsLastPage(firstResponse.headers.link);
    if (lastPage === null) {
      // No rel="last" in the Link header. A genuine single page has no rel="next" either — return page 1 directly.
      // But GitHub can paginate WITHOUT emitting rel="last" (only rel="next"); then trusting page 1 alone would let
      // a later maintainer/bot event hide behind the un-enumerated tail and the reopen guard would fail OPEN. So
      // follow rel="next" forward, tracking the latest matching event across pages (events are oldest-first → a
      // later page's event supersedes), bounded by the same page budget. coveredAllPages holds ONLY if we reached
      // the tail within budget; otherwise report not-covered so the caller fails closed. (#audit-rel-last)
      if (!issueEventsHasNextPage(firstResponse.headers.link)) {
        return { login: latestActorInPage(firstEvents, eventType) ?? null, coveredAllPages: true };
      }
      let latestActor = latestActorInPage(firstEvents, eventType);
      let hasNext = true;
      for (let page = 2; hasNext && page <= ISSUE_EVENTS_RECENT_PAGE_LIMIT + 1; page += 1) {
        const response = await requestPage(page);
        const actor = latestActorInPage(response.data as Array<{ event?: string; actor?: { login?: string | null } | null }>, eventType);
        if (actor !== undefined) latestActor = actor;
        hasNext = issueEventsHasNextPage(response.headers.link);
      }
      const coveredAllPages = !hasNext;
      return { login: coveredAllPages ? (latestActor ?? null) : null, coveredAllPages };
    }
    if (lastPage <= 1) return { login: latestActorInPage(firstEvents, eventType) ?? null, coveredAllPages: true };

    // GitHub returns issue-events oldest-first. Use the Link header to inspect the newest bounded window instead
    // of the oldest prefix, so a long self-generated timeline cannot hide a later maintainer/bot event.
    const firstPageToRead = Math.max(2, lastPage - ISSUE_EVENTS_RECENT_PAGE_LIMIT + 1);
    // We inspected the entire timeline only when the window reached page 2 (page 1 is read separately above).
    const coveredAllPages = firstPageToRead === 2;
    for (let page = lastPage; page >= firstPageToRead; page -= 1) {
      const response = await requestPage(page);
      const actor = latestActorInPage(response.data as Array<{ event?: string; actor?: { login?: string | null } | null }>, eventType);
      if (actor !== undefined) return { login: actor, coveredAllPages };
    }
    return { login: coveredAllPages ? (latestActorInPage(firstEvents, eventType) ?? null) : null, coveredAllPages };
  } catch {
    // On error we cannot prove we read the whole timeline — report not-covered so the caller decides conservatively.
    return { login: null, coveredAllPages: false };
  }
}

function latestActorInPage(events: Array<{ event?: string; actor?: { login?: string | null } | null }>, eventType: string): string | null | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const entry = events[i];
    if (entry?.event === eventType) return entry.actor?.login ?? null;
  }
  return undefined;
}

// The last page number from the Link header's rel="last", or null when GitHub did not emit rel="last" (no
// header, a single page, or a paginated response where rel="last" was omitted — the caller follows rel="next"
// forward in that case rather than assuming a single page). (#audit-rel-last)
function issueEventsLastPage(linkHeader: string | undefined): number | null {
  if (!linkHeader) return null;
  const lastLink = linkHeader.split(",").find((link) => /rel="last"/.test(link));
  const page = lastLink?.match(/[?&]page=(\d+)/)?.[1];
  return page ? Number(page) : null;
}

// Whether the Link header advertises a rel="next" page (more events exist beyond the one just fetched).
function issueEventsHasNextPage(linkHeader: string | undefined): boolean {
  return linkHeader !== undefined && linkHeader.split(",").some((link) => /rel="next"/.test(link));
}
