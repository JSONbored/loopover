import { withInstallationTokenRetry } from "./app";
import { githubRateLimitAdmissionKeyForInstallation, makeInstallationOctokit } from "./client";
import type { AgentActionMode } from "../settings/agent-execution";

type GitHubLabel = {
  name?: string | null;
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

export async function ensurePullRequestLabel(
  env: Env,
  installationId: number,
  repoFullName: string,
  pullNumber: number,
  labelName: string,
  options: { createMissingLabel: boolean; mode?: AgentActionMode },
): Promise<{ applied: boolean; created: boolean }> {
  const { owner, repo } = parseRepoFullName(repoFullName);

  // #6191: retry once with a freshly-minted token on a stale-cached-token (bad_credentials/permission-scope)
  // rejection, self-healing like every other GitHub write path (comments.ts/pr-actions.ts).
  return await withInstallationTokenRetry(env, installationId, async (token) => {
    // Non-live mode suppresses the label create + apply writes; the GET dedup probe below still runs.
    const octokit = makeInstallationOctokit(env, token, options.mode ?? "live", githubRateLimitAdmissionKeyForInstallation(installationId));
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
  });
}

/** Remove a single label from a PR if present. Best-effort — a 404 (label not on the PR) is ignored; any other
 *  GitHub API failure (403/5xx/rate-limit) is re-thrown, matching {@link ensurePullRequestLabel}'s narrow-swallow
 *  convention. Used to keep the mutually-exclusive managed TYPE labels (gittensor:bug/feature/priority) down to
 *  exactly one. */
export async function removePullRequestLabel(env: Env, installationId: number, repoFullName: string, pullNumber: number, labelName: string, mode: AgentActionMode = "live"): Promise<void> {
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseRepoFullName(repoFullName));
  } catch {
    return;
  }
  // #6191: retry once with a freshly-minted token on a stale-cached-token (bad_credentials/permission-scope)
  // rejection, self-healing like every other GitHub write path (comments.ts/pr-actions.ts).
  await withInstallationTokenRetry(env, installationId, async (token) => {
    const octokit = makeInstallationOctokit(env, token, mode, githubRateLimitAdmissionKeyForInstallation(installationId));
    try {
      await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
        owner,
        repo,
        issue_number: pullNumber,
        name: labelName,
      });
    } catch (error) {
      const e = error as { status?: number };
      // Only swallow the documented "label not on the PR" 404; other failures must propagate (#6192).
      if (e.status !== 404) throw error;
    }
  });
}
