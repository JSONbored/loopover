import { withInstallationTokenRetry } from "./app";
import { githubRateLimitAdmissionKeyForInstallation, makeInstallationOctokit } from "./client";
import type { AgentActionMode } from "../settings/agent-execution";

export const PR_PANEL_COMMENT_MARKER = "<!-- gittensory-pr-panel:v1 -->";
export const PR_INTELLIGENCE_COMMENT_MARKER = PR_PANEL_COMMENT_MARKER;
export const AGENT_COMMAND_COMMENT_MARKER = PR_PANEL_COMMENT_MARKER;
const LEGACY_PR_INTELLIGENCE_COMMENT_MARKER = "<!-- gittensory-pr-intelligence -->";
const LEGACY_AGENT_COMMAND_COMMENT_MARKER = "<!-- gittensory-agent-command -->";
/** #7372: the PR-closed maintainer-notify follow-up comment's own marker — deliberately a DIFFERENT comment
 *  thread from the sticky PR panel above (that comment stops being useful the moment the PR closes), so this
 *  must never collapse into `PR_PANEL_COMMENT_MARKER`'s aliases the way the two constants above do. */
export const VISUAL_FOLLOWUP_COMMENT_MARKER = "<!-- loopover:visual-unrelated-followup -->";
// Bound the marker-comment search at 10 pages (up to 1,000 comments), matching src/github's other pagination
// caps (app.ts's MAX_WORKFLOW_RUN_LIST_PAGES, pr-actions.ts's REVIEW_PAGE_LIMIT). The old cap of 3 (300 comments)
// let a PR/issue that accrued >300 comments before LoopOver's own marker comment hide it from this search, so
// createOrUpdateIssueCommentWithMarker POSTed a DUPLICATE instead of PATCHing the existing one (#7232). The
// `batch.length < 100` early-exit below still keeps a short comment list to a single request.
const COMMENT_SEARCH_PAGE_LIMIT = 10;

type IssueComment = {
  id: number;
  body?: string | null;
  html_url?: string;
  user?: {
    type?: string;
    login?: string;
  } | null;
};

export async function createOrUpdatePrIntelligenceComment(
  env: Env,
  installationId: number,
  repoFullName: string,
  pullNumber: number,
  body: string,
  options: { createIfMissing?: boolean | undefined; mode?: AgentActionMode } = {},
): Promise<{ id: number; html_url?: string; changed: boolean } | null> {
  return createOrUpdateIssueCommentWithMarker(env, installationId, repoFullName, pullNumber, body, PR_INTELLIGENCE_COMMENT_MARKER, options);
}

/** The PR-closed maintainer-notify follow-up comment (#7372, review.visual.bugAnalysisNotify) — its own
 *  comment thread, separate from the sticky PR panel above. `createOrUpdate` (not create-only) so a PR that
 *  cycles closed -> reopened -> closed again with a DIFFERENT set of unrelated findings the second time
 *  updates the same comment instead of posting a confusing duplicate; a same-body repeat (a retried `closed`
 *  webhook delivery) is a genuine no-op via the same byte-identical-body skip every other marker comment here
 *  already gets. */
export async function createOrUpdateVisualFollowupComment(
  env: Env,
  installationId: number,
  repoFullName: string,
  pullNumber: number,
  body: string,
  mode: AgentActionMode = "live",
): Promise<{ id: number; html_url?: string; changed: boolean } | null> {
  return createOrUpdateIssueCommentWithMarker(env, installationId, repoFullName, pullNumber, body, VISUAL_FOLLOWUP_COMMENT_MARKER, { mode });
}

export async function createOrUpdateAgentCommandComment(
  env: Env,
  installationId: number,
  repoFullName: string,
  issueNumber: number,
  body: string,
  mode: AgentActionMode = "live",
): Promise<{ id: number; html_url?: string; changed: boolean } | null> {
  return createOrUpdateIssueCommentWithMarker(env, installationId, repoFullName, issueNumber, body, AGENT_COMMAND_COMMENT_MARKER, { mode });
}

// #6724 (review-burst): `changed` distinguishes a genuine no-op (the rendered body was byte-identical to what's
// already posted, PATCH skipped -- see the idempotency comment below) from a real create/update, so a caller can
// avoid double-counting a republish that produced no visible change. `false` ONLY on the proven-identical path;
// every other return (created, updated, or `createIfMissing: false` returning null) is `true`/absent because
// there's no cheap, safe way to prove those didn't change anything.
async function createOrUpdateIssueCommentWithMarker(
  env: Env,
  installationId: number,
  repoFullName: string,
  issueNumber: number,
  body: string,
  marker: string,
  options: { createIfMissing?: boolean | undefined; mode?: AgentActionMode } = {},
): Promise<{ id: number; html_url?: string; changed: boolean } | null> {
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  // Reject anything that is not exactly two non-empty segments -- "owner/repo/extra" would otherwise pass
  // (the destructure silently drops the extra segment), issuing a call against a repo the caller never
  // specified -- and additionally reject whitespace (`owner/ repo`, ` owner/repo`) so a padded slug can never
  // reach a GitHub call. Matches the full segment-count + whitespace guard in parseRepoFullName
  // (assignees.ts / labels.ts, #6613).
  if (parts.length !== 2 || !owner || !repo || /\s/.test(repoFullName))
    throw new Error(`Invalid repository full name: ${repoFullName}`);

  return await withInstallationTokenRetry(env, installationId, async (token) => {
    // Non-live mode suppresses the comment create/update writes; the GET marker-search probe below still runs.
    const octokit = makeInstallationOctokit(env, token, options.mode ?? "live", githubRateLimitAdmissionKeyForInstallation(installationId));
    const botLogin = `${env.GITHUB_APP_SLUG}[bot]`;
    const markers = markerAliases(marker);
    const existing: IssueComment[] = [];
    for (let page = 1; page <= COMMENT_SEARCH_PAGE_LIMIT; page += 1) {
      const response = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
        page,
      });
      const batch = response.data as IssueComment[];
      existing.push(...batch.filter((comment) => isLoopOverBotComment(comment, botLogin) && markers.some((candidate) => comment.body?.includes(candidate))));
      if (batch.length < 100) break;
    }
    const canonical = canonicalMarkerComment(existing);
    if (canonical) {
      // Idempotency (#4): skip the PATCH when the rendered body is byte-identical to what's already posted. The
      // re-gate sweep re-renders the same surface every cycle for an unchanged PR; without this, every cycle PATCHes
      // GitHub (a write + rate-limit cost) for no visible change. Defense-in-depth alongside the head_sha publish
      // marker — also collapses a duplicate webhook delivery for the same commit.
      if (canonical.body === body) {
        await deleteDuplicateMarkerComments(octokit, owner, repo, existing, canonical.id);
        return { id: canonical.id, ...(canonical.html_url !== undefined ? { html_url: canonical.html_url } : {}), changed: false };
      }
      const response = await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        owner,
        repo,
        comment_id: canonical.id,
        body,
      });
      await deleteDuplicateMarkerComments(octokit, owner, repo, existing, canonical.id);
      return { ...(response.data as { id: number; html_url?: string }), changed: true };
    }
    if (options.createIfMissing === false) return null;
    const response = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return { ...(response.data as { id: number; html_url?: string }), changed: true };
  });
}

function isLoopOverBotComment(comment: IssueComment, botLogin: string): boolean {
  return comment.user?.type === "Bot" && comment.user.login?.toLowerCase() === botLogin.toLowerCase();
}

function canonicalMarkerComment(comments: IssueComment[]): IssueComment | undefined {
  return comments.reduce<IssueComment | undefined>((best, comment) => (best === undefined || comment.id < best.id ? comment : best), undefined);
}

async function deleteDuplicateMarkerComments(
  octokit: ReturnType<typeof makeInstallationOctokit>,
  owner: string,
  repo: string,
  comments: IssueComment[],
  canonicalId: number,
): Promise<void> {
  await Promise.allSettled(
    comments
      .filter((comment) => comment.id !== canonicalId)
      .map((comment) =>
        octokit.request("DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}", {
          owner,
          repo,
          comment_id: comment.id,
        }),
      ),
  );
}

// #7372: only PR_PANEL_COMMENT_MARKER (and its two legacy predecessors) collapse into one shared search set —
// PR_INTELLIGENCE_COMMENT_MARKER/AGENT_COMMAND_COMMENT_MARKER are literally that SAME string value (see their
// `= PR_PANEL_COMMENT_MARKER` aliases above), so this preserves their existing behavior exactly. Any OTHER
// marker (e.g. VISUAL_FOLLOWUP_COMMENT_MARKER) searches for itself alone — collapsing it into the panel's own
// alias set here would make createOrUpdateIssueCommentWithMarker find and PATCH the sticky PANEL comment
// instead of that marker's own comment thread, silently corrupting it.
function markerAliases(marker: string): string[] {
  return marker === PR_PANEL_COMMENT_MARKER ? [PR_PANEL_COMMENT_MARKER, LEGACY_PR_INTELLIGENCE_COMMENT_MARKER, LEGACY_AGENT_COMMAND_COMMENT_MARKER] : [marker];
}
