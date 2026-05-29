import { Octokit } from "@octokit/core";
import { createInstallationToken } from "./app";

export const PR_INTELLIGENCE_COMMENT_MARKER = "<!-- gittensory-pr-intelligence -->";
export const AGENT_COMMAND_COMMENT_MARKER = "<!-- gittensory-agent-command -->";

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
): Promise<{ id: number; html_url?: string } | null> {
  return createOrUpdateIssueCommentWithMarker(env, installationId, repoFullName, pullNumber, body, PR_INTELLIGENCE_COMMENT_MARKER);
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
  const existing = (comments.data as IssueComment[]).find((comment) => isGittensoryBotComment(comment, botLogin) && comment.body?.includes(marker));
  if (existing) {
    const response = await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    return response.data as { id: number; html_url?: string };
  }
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
