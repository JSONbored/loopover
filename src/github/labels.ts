import { createInstallationToken } from "./app";
import { makeInstallationOctokit } from "./client";
import type { AgentActionMode } from "../settings/agent-execution";

type GitHubLabel = {
  name?: string | null;
};

export async function ensurePullRequestLabel(
  env: Env,
  installationId: number,
  repoFullName: string,
  pullNumber: number,
  labelName: string,
  options: { createMissingLabel: boolean; mode?: AgentActionMode },
): Promise<{ applied: boolean; created: boolean }> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository full name: ${repoFullName}`);

  const token = await createInstallationToken(env, installationId);
  // Non-live mode suppresses the label create + apply writes; the GET dedup probe below still runs.
  const octokit = makeInstallationOctokit(env, token, options.mode ?? "live");
  const existing = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/labels", {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const labels = existing.data as GitHubLabel[];
  if (labels.some((label) => label.name?.toLowerCase() === labelName.toLowerCase())) {
    return { applied: false, created: false };
  }

  let created = false;
  if (options.createMissingLabel) {
    try {
      await octokit.request("POST /repos/{owner}/{repo}/labels", {
        owner,
        repo,
        name: labelName,
        color: "7ee787",
        description: "Gittensor contributor context",
      });
      created = true;
    } catch (error) {
      const e = error as { status?: number; message?: string };
      // Only swallow the specific "already_exists" duplicate; other 422s (e.g. invalid name) must propagate.
      if (e.status !== 422 || !e.message?.includes("already_exists")) throw error;
    }
  }

  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
    owner,
    repo,
    issue_number: pullNumber,
    labels: [labelName],
  });
  return { applied: true, created };
}

/** Remove a single label from a PR if present. Best-effort — a 404 (label not on the PR) is ignored. Used to
 *  keep the mutually-exclusive managed TYPE labels (gittensor:bug/feature/priority) down to exactly one. */
export async function removePullRequestLabel(env: Env, installationId: number, repoFullName: string, pullNumber: number, labelName: string, mode: AgentActionMode = "live"): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return;
  const token = await createInstallationToken(env, installationId);
  const octokit = makeInstallationOctokit(env, token, mode);
  await octokit
    .request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { owner, repo, issue_number: pullNumber, name: labelName })
    .catch(() => undefined);
}
