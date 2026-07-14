// Per-repo signal-snapshot generation (#4013 step 2 -- extracted from processors.ts, second step of the
// file's own module-split sequence, after transient-locks.ts). Pure orchestration over already-exported
// src/signals and src/db primitives. loadOpenQueueCounts moved here too (rather than staying in
// processors.ts and being imported back) since its only two callers are generateSignalSnapshots here and
// processors.ts's own buildBurdenForecasts -- keeping it in processors.ts would have made the two files
// import from each other; processors.ts imports it back from here instead, one direction only.

import {
  countOpenIssues,
  countOpenPullRequests,
  getLatestRepoGithubTotalsSnapshot,
  listBountiesByRepo,
  listIssueSignalSample,
  listOpenPullRequests,
  listRecentMergedPullRequests,
  listRepoGithubTotalsSnapshotHistory,
  listRepoLabels,
  listRepositories,
  listSignalSnapshots,
  persistSignalSnapshot,
  replaceCollisionEdges,
  upsertRepoQueueTrendSnapshot,
} from "../db/repositories";
import { computeRepoOutcomePatterns, REPO_OUTCOME_PATTERNS_SIGNAL } from "../services/repo-outcome-patterns";
import { buildQueueTrendReport, QUEUE_TREND_HISTORY_DAYS } from "../services/queue-trends";
import {
  buildCollisionEdges,
  buildCollisionReport,
  buildConfigQuality,
  buildContributorIntakeHealth,
  buildIssueQualityReport,
  buildLabelAudit,
  buildMaintainerCutReadiness,
  buildMaintainerLaneReport,
  buildQueueHealth,
} from "../signals/engine";

export async function loadOpenQueueCounts(
  env: Env,
  repoFullName: string,
): Promise<{ openIssues: number; openPullRequests: number }> {
  const [totals, openIssues, openPullRequests] = await Promise.all([
    getLatestRepoGithubTotalsSnapshot(env, repoFullName),
    countOpenIssues(env, repoFullName),
    countOpenPullRequests(env, repoFullName),
  ]);
  return {
    openIssues: totals?.openIssuesTotal ?? openIssues,
    openPullRequests: totals?.openPullRequestsTotal ?? openPullRequests,
  };
}

export async function generateSignalSnapshots(
  env: Env,
  repoFullName?: string,
): Promise<void> {
  // #5019: this is the function the enqueued generate-signal-snapshots job actually calls, and it
  // independently re-filters by the same field fanOutRepoSignalSnapshotJobs already checked -- both
  // filters must move to isInstalled together, or a job enqueued for an installed-but-not-registered
  // repo would reach here and silently no-op (repositories would come back empty).
  const repositories = (await listRepositories(env)).filter(
    (repo) =>
      repo.isInstalled && (!repoFullName || repo.fullName === repoFullName),
  );
  for (const repo of repositories) {
    const trendSince = new Date(
      Date.now() - QUEUE_TREND_HISTORY_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const [
      issues,
      pullRequests,
      recentMergedPullRequests,
      labels,
      queueCounts,
      bounties,
      totalsHistory,
      queueHealthHistory,
    ] = await Promise.all([
      listIssueSignalSample(env, repo.fullName),
      listOpenPullRequests(env, repo.fullName),
      listRecentMergedPullRequests(env, repo.fullName),
      listRepoLabels(env, repo.fullName),
      loadOpenQueueCounts(env, repo.fullName),
      listBountiesByRepo(env, repo.fullName),
      listRepoGithubTotalsSnapshotHistory(env, repo.fullName, {
        sinceIso: trendSince,
        limit: 120,
      }),
      listSignalSnapshots(env, "queue-health", repo.fullName),
    ]);
    const collisions = buildCollisionReport(
      repo.fullName,
      issues,
      pullRequests,
      recentMergedPullRequests,
    );
    const queueHealth = buildQueueHealth(
      repo,
      issues,
      pullRequests,
      collisions,
      queueCounts,
    );
    const configQuality = buildConfigQuality(
      repo,
      issues,
      pullRequests,
      repo.fullName,
    );
    const labelAudit = buildLabelAudit(
      repo,
      labels,
      issues,
      pullRequests,
      repo.fullName,
    );
    const maintainerLane = buildMaintainerLaneReport(
      repo,
      issues,
      pullRequests,
      repo.fullName,
      collisions,
      queueCounts,
    );
    const maintainerCutReadiness = buildMaintainerCutReadiness(
      repo,
      issues,
      pullRequests,
      repo.fullName,
      queueCounts,
      collisions,
    );
    const contributorIntakeHealth = buildContributorIntakeHealth(
      repo,
      issues,
      pullRequests,
      repo.fullName,
      collisions,
      queueCounts,
    );
    const issueQuality = buildIssueQualityReport(
      repo,
      issues,
      pullRequests,
      repo.fullName,
      bounties,
      collisions,
      recentMergedPullRequests,
    );
    await replaceCollisionEdges(
      env,
      repo.fullName,
      buildCollisionEdges(collisions),
    );
    const generatedAt = new Date().toISOString();
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "queue-health",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: queueHealth as unknown as Record<string, never>,
      generatedAt,
    });
    await upsertRepoQueueTrendSnapshot(env, {
      repoFullName: repo.fullName,
      payload: buildQueueTrendReport({
        repoFullName: repo.fullName,
        totalsSnapshots: totalsHistory,
        queueHealthSnapshots: queueHealthHistory,
        currentQueueHealth: queueHealth,
        generatedAt,
      }) as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "config-quality",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: configQuality as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "label-audit",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: labelAudit as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "maintainer-lane",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: maintainerLane as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "maintainer-cut-readiness",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: maintainerCutReadiness as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "contributor-intake-health",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: contributorIntakeHealth as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "issue-quality",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: issueQuality as unknown as Record<string, never>,
      generatedAt,
    });
    const repoOutcomePatterns = await computeRepoOutcomePatterns(
      env,
      repo.fullName,
      repo,
    );
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: repoOutcomePatterns as unknown as Record<string, never>,
      generatedAt,
    });
  }
}
