import { getRepository, listIssueSignalSample, listOpenPullRequests, listRecentMergedPullRequests } from "../db/repositories";
import { buildMaintainerNoiseReport, type MaintainerNoiseReport } from "../signals/reward-risk";

// Maintainer triage signal: which queue-noise sources to clear FIRST (open PRs without linked-issue context,
// broad/churn-style diffs, duplicate clusters, contributor-intake pressure). The deterministic builder already
// exists and powers the `@gittensory noise-report` PR command; this load-or-compute wrapper makes the same
// report available to the MCP tool surface (agent / CLI), mirroring the outcome-calibration serving (#1174).
export async function loadMaintainerNoiseReport(env: Env, fullName: string): Promise<MaintainerNoiseReport> {
  const [repo, issues, pullRequests, recentMergedPullRequests] = await Promise.all([
    getRepository(env, fullName),
    listIssueSignalSample(env, fullName),
    listOpenPullRequests(env, fullName),
    listRecentMergedPullRequests(env, fullName),
  ]);
  return buildMaintainerNoiseReport(repo, issues, pullRequests, recentMergedPullRequests, fullName);
}

export function maintainerNoiseSummary(report: MaintainerNoiseReport): string {
  return `Gittensory maintainer noise report for ${report.repoFullName}: ${report.level} noise (score ${report.score}); ${report.noiseSources.length} source(s) to triage.`;
}
