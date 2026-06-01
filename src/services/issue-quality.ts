import { getRepository, listIssueSignalSample, listOpenPullRequests, listRecentMergedPullRequests, listSignalSnapshots } from "../db/repositories";
import { buildIssueQualityReport, type IssueQualityReport } from "../signals/engine";

export type IssueQualityResponse = {
  status: "ready";
  source: "snapshot" | "computed";
  repoFullName: string;
  generatedAt: string;
  report: IssueQualityReport;
};

export async function loadOrComputeIssueQualityResponse(env: Env, fullName: string): Promise<IssueQualityResponse | null> {
  const cached = (await listSignalSnapshots(env, "issue-quality", fullName))[0];
  if (cached) {
    const payload = cached.payload as unknown as IssueQualityReport;
    const generatedAt = cached.generatedAt || (payload.generatedAt as string | undefined) || new Date().toISOString();
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
  const [issues, pullRequests, recentMergedPullRequests] = await Promise.all([listIssueSignalSample(env, fullName), listOpenPullRequests(env, fullName), listRecentMergedPullRequests(env, fullName)]);
  const report = buildIssueQualityReport(repo, issues, pullRequests, fullName, undefined, recentMergedPullRequests);
  return {
    status: "ready",
    source: "computed",
    repoFullName: fullName,
    generatedAt: report.generatedAt,
    report,
  };
}

export async function loadIssueQualityReportMap(env: Env, repositories: Array<{ fullName: string; isRegistered: boolean }>): Promise<Map<string, IssueQualityReport>> {
  const map = new Map<string, IssueQualityReport>();
  await Promise.all(
    repositories.filter((repo) => repo.isRegistered).map(async (repo) => {
      const latest = (await listSignalSnapshots(env, "issue-quality", repo.fullName))[0];
      if (latest) map.set(repo.fullName, latest.payload as unknown as IssueQualityReport);
    }),
  );
  return map;
}
