import { withInstallationTokenRetry } from "./app";
import { githubRateLimitAdmissionKeyForInstallation, makeInstallationOctokit } from "./client";
import type { AgentActionMode } from "../settings/agent-execution";

// Mirrors parseRepoFullName in labels.ts / assignees.ts / issues.ts (#7427): each GitHub-write module keeps its
// own copy rather than importing a shared one, matching the existing house convention for this tiny pure check.
function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || /\s/.test(repoFullName)) {
    throw new Error(`Invalid repository full name: ${repoFullName}`);
  }
  return { owner, repo };
}

export type InstallationMilestone = { number: number; title: string; description: string | null; dueOn: string | null };

export type CreateInstallationMilestoneInput = { title: string; description?: string | undefined; dueOn?: string | undefined };

/**
 * List OPEN milestones via the installation-token/Orb-broker path (#7427) -- the same auth path createInstallationIssue
 * (issues.ts, #7425) uses. Capped to GitHub's max per_page (100) with no further pagination: unlike e.g.
 * cancelInFlightWorkflowRunsForHeadSha's bounded multi-page workflow-run loop, there is no realistic scenario
 * where a repo has more than 100 OPEN milestones, so a second page is not worth the added complexity here.
 */
export async function listOpenInstallationMilestones(env: Env, installationId: number, repoFullName: string, mode: AgentActionMode = "live"): Promise<InstallationMilestone[]> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  return withInstallationTokenRetry(env, installationId, async (token) => {
    const octokit = makeInstallationOctokit(env, token, mode, githubRateLimitAdmissionKeyForInstallation(installationId));
    const response = await octokit.request("GET /repos/{owner}/{repo}/milestones", { owner, repo, state: "open", per_page: 100 });
    const data = response.data as Array<{ number?: number; title?: string; description?: string | null; due_on?: string | null }>;
    return data
      .filter((entry): entry is { number: number; title: string; description?: string | null; due_on?: string | null } => typeof entry.number === "number" && typeof entry.title === "string")
      .map((entry) => ({ number: entry.number, title: entry.title, description: entry.description ?? null, dueOn: entry.due_on ?? null }));
  });
}

/**
 * Create a milestone via the same installation-token/Orb-broker path. Returns null (never throws for a
 * suppressed/malformed write) when the write is suppressed by a non-live mode or GitHub's response omits the
 * fields a caller needs -- mirrors createInstallationIssue's identical contract (issues.ts). A genuine GitHub
 * API failure (permission gap, 5xx, rate limit) is NOT swallowed here; it propagates via Octokit's
 * throw-on-non-2xx, matching that same contract.
 */
export async function createInstallationMilestone(env: Env, installationId: number, repoFullName: string, input: CreateInstallationMilestoneInput, mode: AgentActionMode = "live"): Promise<InstallationMilestone | null> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  return withInstallationTokenRetry(env, installationId, async (token) => {
    const octokit = makeInstallationOctokit(env, token, mode, githubRateLimitAdmissionKeyForInstallation(installationId));
    const response = await octokit.request("POST /repos/{owner}/{repo}/milestones", {
      owner,
      repo,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.dueOn ? { due_on: input.dueOn } : {}),
    });
    const data = response.data as { number?: number; title?: string; description?: string | null; due_on?: string | null; dryRunSuppressed?: boolean };
    if (data.dryRunSuppressed) return null;
    return data.number && data.title ? { number: data.number, title: data.title, description: data.description ?? null, dueOn: data.due_on ?? null } : null;
  });
}
