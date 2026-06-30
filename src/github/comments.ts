import { withInstallationTokenRetry } from "./app";
import { makeInstallationOctokit } from "./client";
import type { AgentActionMode } from "../settings/agent-execution";

export const PR_PANEL_COMMENT_MARKER = "<!-- gittensory-pr-panel:v1 -->";
export const PR_INTELLIGENCE_COMMENT_MARKER = PR_PANEL_COMMENT_MARKER;
export const AGENT_COMMAND_COMMENT_MARKER = PR_PANEL_COMMENT_MARKER;
const LEGACY_PR_INTELLIGENCE_COMMENT_MARKER = "<!-- gittensory-pr-intelligence -->";
const LEGACY_AGENT_COMMAND_COMMENT_MARKER = "<!-- gittensory-agent-command -->";
const COMMENT_SEARCH_PAGE_LIMIT = 3;

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
): Promise<{ id: number; html_url?: string } | null> {
  return createOrUpdateIssueCommentWithMarker(env, installationId, repoFullName, pullNumber, body, PR_INTELLIGENCE_COMMENT_MARKER, options);
}

export async function createOrUpdateAgentCommandComment(
  env: Env,
  installationId: number,
  repoFullName: string,
  issueNumber: number,
  body: string,
  mode: AgentActionMode = "live",
): Promise<{ id: number; html_url?: string } | null> {
  return createOrUpdateIssueCommentWithMarker(env, installationId, repoFullName, issueNumber, body, AGENT_COMMAND_COMMENT_MARKER, { mode });
}

async function createOrUpdateIssueCommentWithMarker(
  env: Env,
  installationId: number,
  repoFullName: string,
  issueNumber: number,
  body: string,
  marker: string,
  options: { createIfMissing?: boolean | undefined; mode?: AgentActionMode } = {},
): Promise<{ id: number; html_url?: string } | null> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository full name: ${repoFullName}`);

  return await withInstallationTokenRetry(env, installationId, async (token) => {
    // Non-live mode suppresses the comment create/update writes; the GET marker-search probe below still runs.
    const octokit = makeInstallationOctokit(env, token, options.mode ?? "live");
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
      existing.push(...batch.filter((comment) => isGittensoryBotComment(comment, botLogin) && markers.some((candidate) => comment.body?.includes(candidate))));
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
        return { id: canonical.id, ...(canonical.html_url !== undefined ? { html_url: canonical.html_url } : {}) };
      }
      const response = await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        owner,
        repo,
        comment_id: canonical.id,
        body,
      });
      await deleteDuplicateMarkerComments(octokit, owner, repo, existing, canonical.id);
      return response.data as { id: number; html_url?: string };
    }
    if (options.createIfMissing === false) return null;
    const response = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return response.data as { id: number; html_url?: string };
  });
}

function isGittensoryBotComment(comment: IssueComment, botLogin: string): boolean {
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

function markerAliases(_marker: string): string[] {
  return [PR_PANEL_COMMENT_MARKER, LEGACY_PR_INTELLIGENCE_COMMENT_MARKER, LEGACY_AGENT_COMMAND_COMMENT_MARKER];
}
