import { createInstallationToken } from "./app";
import { githubRateLimitAdmissionKeyForInstallation, makeInstallationOctokit } from "./client";
import type { AgentActionMode } from "../settings/agent-execution";

type GitHubUser = {
  login?: string | null;
};

function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  // Reject any whitespace (leading, trailing, or per-segment like `owner/ repo`) so a padded slug can never
  // reach a GitHub call — a valid owner/repo name never contains spaces.
  if (parts.length !== 2 || !owner || !repo || /\s/.test(repoFullName)) {
    throw new Error(`Invalid repository full name: ${repoFullName}`);
  }
  return { owner, repo };
}

/**
 * Best-effort assign a single login to a PR (#3182). GitHub requires the ASSIGNEE (not just the caller) to
 * have push/triage access to the repo -- an external contributor almost never does, and the assignees endpoint
 * silently drops an ineligible login from the response rather than erroring. `applied` reflects the actual
 * post-call assignee list, not just a lack of a thrown error, so the caller can detect the silent-drop case and
 * fall back to something that isn't gated by repo membership (see `performAction`'s "assign" case).
 */
export async function ensurePullRequestAssignee(
  env: Env,
  installationId: number,
  repoFullName: string,
  pullNumber: number,
  login: string,
  options: { mode?: AgentActionMode } = {},
): Promise<{ applied: boolean }> {
  const { owner, repo } = parseRepoFullName(repoFullName);

  const token = await createInstallationToken(env, installationId);
  // Non-live mode suppresses the assign write; the GET dedup probe below still runs.
  const octokit = makeInstallationOctokit(env, token, options.mode ?? "live", githubRateLimitAdmissionKeyForInstallation(installationId));
  const existing = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    owner,
    repo,
    issue_number: pullNumber,
  });
  const existingAssignees = (existing.data.assignees ?? []) as GitHubUser[];
  if (existingAssignees.some((assignee) => assignee.login?.toLowerCase() === login.toLowerCase())) {
    return { applied: true };
  }

  const result = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
    owner,
    repo,
    issue_number: pullNumber,
    assignees: [login],
  });
  const resultAssignees = (result.data.assignees ?? []) as GitHubUser[];
  return { applied: resultAssignees.some((assignee) => assignee.login?.toLowerCase() === login.toLowerCase()) };
}
