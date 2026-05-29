import { getRepository, listIssueSignalSample, listOpenPullRequests, listSignalSnapshots } from "../db/repositories";
import { buildIssueQualityReport } from "../signals/engine";

export type IssueQualityResponse = {
  status: "ready";
  source: "snapshot" | "computed";
  repoFullName: string;
  generatedAt: string;
  report: Record<string, unknown>;
};

export async function loadOrComputeIssueQualityResponse(env: Env, fullName: string): Promise<IssueQualityResponse | null> {
  const cached = (await listSignalSnapshots(env, "issue-quality", fullName))[0];
  if (cached) {
    const payload = cached.payload as Record<string, unknown>;
    const generatedAt = cached.generatedAt ?? (payload.generatedAt as string | undefined) ?? new Date().toISOString();
    return {
      status: "ready",
      source: "snapshot",
      repoFullName: fullName,
      generatedAt,
      report: payload,
    };
  }
  const repo = await getRepository(env, fullName);
  if (!repo) return null;
  const [issues, pullRequests] = await Promise.all([listIssueSignalSample(env, fullName), listOpenPullRequests(env, fullName)]);
  const report = buildIssueQualityReport(repo, issues, pullRequests, fullName);
  return {
    status: "ready",
    source: "computed",
    repoFullName: fullName,
    generatedAt: report.generatedAt,
    report: report as unknown as Record<string, unknown>,
  };
}
