import { getRepository, listIssueSignalSample, listOpenPullRequests, listRecentMergedPullRequests } from "../db/repositories";
import { buildCollisionReport, buildMaintainerLaneReport, type MaintainerLaneReport } from "../signals/engine";

// Maintainer-lane triage synthesis: the lane recommendation in the context of the configured maintainer cut,
// queue health, config quality, and contributor-intake health — i.e. "how should this repo's maintainer treat
// their own lane right now". The deterministic builder already powers the repo-intelligence response; this
// load-or-compute wrapper makes the same report available to the MCP tool surface (agent / CLI), mirroring the
// outcome-calibration / maintainer-noise serving.
export async function loadMaintainerLaneReport(env: Env, fullName: string): Promise<MaintainerLaneReport> {
  const [repo, issues, pullRequests, recentMergedPullRequests] = await Promise.all([
    getRepository(env, fullName),
    listIssueSignalSample(env, fullName),
    listOpenPullRequests(env, fullName),
    listRecentMergedPullRequests(env, fullName),
  ]);
  const collisions = buildCollisionReport(fullName, issues, pullRequests, recentMergedPullRequests);
  return buildMaintainerLaneReport(repo, issues, pullRequests, fullName, collisions);
}

export function maintainerLaneSummary(report: MaintainerLaneReport): string {
  return `Gittensory maintainer lane for ${report.repoFullName}: maintainer_cut ${report.maintainerCutConfigured ? "configured" : "not configured"}; contributor intake ${report.contributorIntakeHealth.level}.`;
}
