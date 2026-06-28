import { getRepository, listIssueSignalSample, listOpenPullRequests, listRepoLabels } from "../db/repositories";
import { buildLabelAudit, type LabelAudit } from "../signals/engine";

// Maintainer label-policy health: whether the repo's configured (.gittensory.yml / dashboard) label set matches
// the live GitHub labels and is trustworthy for label-multiplier scoring — surfacing missing configured labels,
// suspicious status/source-style labels, and the overall trusted-label-pipeline readiness. The deterministic
// builder already powers the repo-intelligence response; this load-or-compute wrapper makes the same audit
// available to the MCP tool surface (agent / CLI), mirroring the maintainer-noise / maintainer-lane serving.
export async function loadLabelAudit(env: Env, fullName: string): Promise<LabelAudit> {
  const [repo, labels, issues, pullRequests] = await Promise.all([
    getRepository(env, fullName),
    listRepoLabels(env, fullName),
    listIssueSignalSample(env, fullName),
    listOpenPullRequests(env, fullName),
  ]);
  return buildLabelAudit(repo, labels, issues, pullRequests, fullName);
}

export function labelAuditSummary(report: LabelAudit): string {
  return `Gittensory label audit for ${report.repoFullName}: trusted-label pipeline ${report.trustedPipelineReady ? "ready" : "not ready"}; ${report.missingConfiguredLabels.length} missing, ${report.suspiciousConfiguredLabels.length} suspicious configured label(s).`;
}
