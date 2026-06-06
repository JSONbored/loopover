import { Octokit } from "@octokit/core";
import { createInstallationToken } from "./app";

export const PR_PANEL_COMMENT_MARKER = "<!-- gittensory-pr-panel:v1 -->";
export const PR_INTELLIGENCE_COMMENT_MARKER = PR_PANEL_COMMENT_MARKER;
export const AGENT_COMMAND_COMMENT_MARKER = PR_PANEL_COMMENT_MARKER;
const LEGACY_PR_INTELLIGENCE_COMMENT_MARKER = "<!-- gittensory-pr-intelligence -->";
const LEGACY_AGENT_COMMAND_COMMENT_MARKER = "<!-- gittensory-agent-command -->";

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
  options: { createIfMissing?: boolean | undefined } = {},
): Promise<{ id: number; html_url?: string } | null> {
  return createOrUpdateIssueCommentWithMarker(env, installationId, repoFullName, pullNumber, body, PR_INTELLIGENCE_COMMENT_MARKER, options);
}

export async function createOrUpdateAgentCommandComment(
  env: Env,
  installationId: number,
  repoFullName: string,
  issueNumber: number,
  body: string,
): Promise<{ id: number; html_url?: string } | null> {
  return createOrUpdateIssueCommentWithMarker(env, installationId, repoFullName, issueNumber, body, AGENT_COMMAND_COMMENT_MARKER);
}

async function createOrUpdateIssueCommentWithMarker(
  env: Env,
  installationId: number,
  repoFullName: string,
  issueNumber: number,
  body: string,
  marker: string,
  options: { createIfMissing?: boolean | undefined } = {},
): Promise<{ id: number; html_url?: string } | null> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository full name: ${repoFullName}`);

  const token = await createInstallationToken(env, installationId);
  const octokit = new Octokit({ auth: token });
  const comments = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const botLogin = `${env.GITHUB_APP_SLUG}[bot]`;
  const markers = markerAliases(marker);
  const existing = (comments.data as IssueComment[]).find((comment) => isGittensoryBotComment(comment, botLogin) && markers.some((candidate) => comment.body?.includes(candidate)));
  if (existing) {
    const response = await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
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
}

function isGittensoryBotComment(comment: IssueComment, botLogin: string): boolean {
  return comment.user?.type === "Bot" && comment.user.login?.toLowerCase() === botLogin.toLowerCase();
}

function markerAliases(_marker: string): string[] {
  return [PR_PANEL_COMMENT_MARKER, LEGACY_PR_INTELLIGENCE_COMMENT_MARKER, LEGACY_AGENT_COMMAND_COMMENT_MARKER];
}
