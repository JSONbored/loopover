import { withInstallationTokenRetry } from "./app";
import { githubRateLimitAdmissionKeyForInstallation, makeInstallationOctokit } from "./client";
import type { AgentActionMode } from "../settings/agent-execution";

// Mirrors parseRepoFullName in labels.ts / assignees.ts (#7425): each GitHub-write module keeps its own copy
// rather than importing a shared one, matching the existing house convention for this tiny pure check.
function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || /\s/.test(repoFullName)) {
    throw new Error(`Invalid repository full name: ${repoFullName}`);
  }
  return { owner, repo };
}

export type CreateInstallationIssueInput = {
  title: string;
  body: string;
  labels?: string[] | undefined;
};

export type CreatedInstallationIssue = { number: number; url: string };

/**
 * Create a GitHub issue via the installation-token path — the local GitHub App key OR the Orb broker,
 * whichever this deployment is configured for (createInstallationToken/withInstallationTokenRetry already pick
 * the right one transparently, see src/orb/broker-client.ts) — instead of a flat operator PAT. Every other
 * GitHub write in this codebase (labels, comments, check-runs) already goes through this path; issue creation
 * was the one write left needing a separately-configured PAT with its own write access to whichever repo was
 * targeted, rather than following "wherever this App/Orb-installation is installed" (#7425).
 *
 * Returns null only when the write itself was suppressed by a non-live mode or GitHub's response omits the
 * fields a caller needs (mirrors createOrUpdateNamedCheckRun's publishedOutcome, src/github/app.ts) — a genuine
 * GitHub API failure (permission gap, 5xx, rate limit) is NOT swallowed here; it propagates via Octokit's
 * throw-on-non-2xx so callers can distinguish "nothing to do" from "the write actually failed" and degrade
 * however fits their own contract.
 */
export async function createInstallationIssue(
  env: Env,
  installationId: number,
  repoFullName: string,
  issue: CreateInstallationIssueInput,
  mode: AgentActionMode = "live",
): Promise<CreatedInstallationIssue | null> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  return withInstallationTokenRetry(env, installationId, async (token) => {
    const octokit = makeInstallationOctokit(env, token, mode, githubRateLimitAdmissionKeyForInstallation(installationId));
    const response = await octokit.request("POST /repos/{owner}/{repo}/issues", {
      owner,
      repo,
      title: issue.title,
      body: issue.body,
      ...(issue.labels && issue.labels.length > 0 ? { labels: issue.labels } : {}),
    });
    const data = response.data as { number?: number; html_url?: string; dryRunSuppressed?: boolean };
    if (data.dryRunSuppressed) return null;
    return data.number && data.html_url ? { number: data.number, url: data.html_url } : null;
  });
}
