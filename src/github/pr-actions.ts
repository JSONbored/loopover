import { Octokit } from "@octokit/core";
import { createInstallationToken } from "./app";
import type { AutoMergeMethod } from "../types";

const ISSUE_EVENTS_PAGE_SIZE = 100;
const ISSUE_EVENTS_RECENT_PAGE_LIMIT = 10;

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
  const octokit = new Octokit({ auth: token });
  const response = await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner,
    repo,
    pull_number: pullNumber,
    event,
    body,
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
  const octokit = new Octokit({ auth: token });
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
  const octokit = new Octokit({ auth: token });
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
  const octokit = new Octokit({ auth: token });
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
  const octokit = new Octokit({ auth: token });
  const response = await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: pullNumber,
    state: "closed",
  });
  return { state: (response.data as { state: string }).state };
}

/** Reopen-prevention (#one-shot-reopen): the login of whoever LAST closed this PR (most recent `closed` event in
 *  the issue-events timeline), or null if none / on error. Lets the reopen handler distinguish a maintainer/bot
 *  close (one-shot — a contributor may not reopen) from a contributor self-close (which they MAY reopen). */
export async function getLastCloserLogin(env: Env, installationId: number, repoFullName: string, issueNumber: number): Promise<string | null> {
  try {
    const { owner, repo } = splitRepo(repoFullName);
    const token = await createInstallationToken(env, installationId);
    const octokit = new Octokit({ auth: token });
    const requestPage = (page: number) =>
      octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/events", { owner, repo, issue_number: issueNumber, per_page: ISSUE_EVENTS_PAGE_SIZE, page });
    const firstResponse = await requestPage(1);
    const firstEvents = firstResponse.data as Array<{ event?: string; actor?: { login?: string | null } | null }>;
    const lastPage = issueEventsLastPage(firstResponse.headers.link);
    if (lastPage <= 1) return latestCloserInPage(firstEvents) ?? null;

    // GitHub returns issue-events oldest-first. Use the Link header to inspect the newest bounded window instead
    // of the oldest prefix, so a long self-generated timeline cannot hide a later maintainer/bot close.
    const firstPageToRead = Math.max(2, lastPage - ISSUE_EVENTS_RECENT_PAGE_LIMIT + 1);
    for (let page = lastPage; page >= firstPageToRead; page -= 1) {
      const response = await requestPage(page);
      const closer = latestCloserInPage(response.data as Array<{ event?: string; actor?: { login?: string | null } | null }>);
      if (closer !== undefined) return closer;
    }
    return firstPageToRead === 2 ? (latestCloserInPage(firstEvents) ?? null) : null;
  } catch {
    return null;
  }
}

function latestCloserInPage(events: Array<{ event?: string; actor?: { login?: string | null } | null }>): string | null | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const entry = events[i];
    if (entry?.event === "closed") return entry.actor?.login ?? null;
  }
  return undefined;
}

function issueEventsLastPage(linkHeader: string | undefined): number {
  if (!linkHeader) return 1;
  const lastLink = linkHeader.split(",").find((link) => /rel="last"/.test(link));
  const page = lastLink?.match(/[?&]page=(\d+)/)?.[1];
  return page ? Number(page) : 1;
}
