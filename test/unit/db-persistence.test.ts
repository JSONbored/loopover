import { describe, expect, it } from "vitest";
import {
  getContributorScoringProfile,
  getOpenUpstreamDriftReportByFingerprint,
  listContributorRepoStats,
  listLatestRepoGithubTotalsSnapshots,
  persistBountyLifecycleEvent,
  persistRegistryDriftEvents,
  persistRepoGithubTotalsSnapshot,
  updateUpstreamDriftReportIssue,
  upsertContributorRepoStat,
  upsertContributorScoringProfile,
  upsertIssueQualityReport,
  upsertUpstreamDriftReport,
} from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("database persistence helpers", () => {
  it("round-trips drift, quality, lifecycle, and scoring persistence helpers", async () => {
    const env = createTestEnv();
    await upsertUpstreamDriftReport(env, {
      id: "drift-1",
      fingerprint: "registry:abc",
      severity: "high",
      status: "open",
      summary: "Registry contract changed",
      affectedAreas: ["registry", "source"],
      previousRulesetId: null,
      currentRulesetId: "ruleset-2",
      payload: { changed: true },
      generatedAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:01:00.000Z",
    });

    expect(await getOpenUpstreamDriftReportByFingerprint(env, "registry:abc")).toMatchObject({
      fingerprint: "registry:abc",
      status: "open",
      affectedAreas: ["registry", "source"],
    });

    await updateUpstreamDriftReportIssue(env, "registry:abc", { number: 42, url: "https://github.com/JSONbored/gittensory/issues/42" });
    expect(await getOpenUpstreamDriftReportByFingerprint(env, "registry:abc")).toMatchObject({
      issueNumber: 42,
      issueUrl: "https://github.com/JSONbored/gittensory/issues/42",
    });

    await upsertContributorScoringProfile(env, {
      login: "JSONbored",
      scoringModelSnapshotId: "scoring-1",
      payload: { scoreability: "ready" },
      generatedAt: "2026-05-30T00:02:00.000Z",
    });
    expect(await getContributorScoringProfile(env, "JSONbored")).toMatchObject({
      login: "JSONbored",
      payload: { scoreability: "ready" },
    });

    await upsertIssueQualityReport(env, {
      id: "quality-1",
      repoFullName: "JSONbored/gittensory",
      issueNumber: 7,
      payload: { score: 92 },
      generatedAt: "2026-05-30T00:03:00.000Z",
    });
    await persistRegistryDriftEvents(env, [
      {
        id: "registry-event-1",
        repoFullName: "JSONbored/gittensory",
        driftType: "changed",
        detail: "Emission changed",
        previousSnapshotId: "old",
        currentSnapshotId: "new",
        payload: { emissionShare: 0.01 },
        generatedAt: "2026-05-30T00:04:00.000Z",
      },
    ]);
    await persistBountyLifecycleEvent(env, {
      id: "bounty-event-1",
      bountyId: "bounty-1",
      repoFullName: "JSONbored/gittensory",
      issueNumber: 7,
      status: "Completed",
      payload: { target_alpha: "74.0000" },
      generatedAt: "2026-05-30T00:05:00.000Z",
    });

    await expect(
      env.DB.prepare("select payload_json from issue_quality_reports where repo_full_name = ? and issue_number = ?")
        .bind("JSONbored/gittensory", 7)
        .first<{ payload_json: string }>(),
    ).resolves.toMatchObject({ payload_json: JSON.stringify({ score: 92 }) });
    await expect(env.DB.prepare("select count(*) as count from registry_drift_events").first<{ count: number }>()).resolves.toMatchObject({ count: 1 });
    await expect(env.DB.prepare("select count(*) as count from bounty_lifecycle_events").first<{ count: number }>()).resolves.toMatchObject({ count: 1 });
  });

  it("returns latest totals per repo and merges duplicate contributor stats case-insensitively", async () => {
    const env = createTestEnv();
    await persistRepoGithubTotalsSnapshot(env, totalsSnapshot("totals-old", "owner/b", "2026-05-29T00:00:00.000Z", 1));
    await persistRepoGithubTotalsSnapshot(env, totalsSnapshot("totals-new", "owner/b", "2026-05-30T00:00:00.000Z", 3));
    await persistRepoGithubTotalsSnapshot(env, totalsSnapshot("totals-a", "owner/a", "2026-05-30T00:00:00.000Z", 2));

    expect(await listLatestRepoGithubTotalsSnapshots(env)).toMatchObject([
      { repoFullName: "owner/a", openIssuesTotal: 2 },
      { repoFullName: "owner/b", openIssuesTotal: 3 },
    ]);

    await upsertContributorRepoStat(env, contributorStat("jsonbored", "owner/repo", 2, ["bug"], "2026-05-29T00:00:00.000Z"));
    await env.DB.prepare(
      "insert into contributor_repo_stats (id, login, repo_full_name, pull_requests, merged_pull_requests, open_pull_requests, issues, stale_pull_requests, unlinked_pull_requests, dominant_labels_json, last_activity_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("jsonbored#OWNER/REPO", "jsonbored", "OWNER/REPO", 5, 4, 1, 3, 2, 1, JSON.stringify(["docs", "bug"]), "2026-05-30T00:00:00.000Z", "2026-05-30T00:01:00.000Z")
      .run();

    expect(await listContributorRepoStats(env, "JSONbored")).toEqual([
      expect.objectContaining({
        repoFullName: "OWNER/REPO",
        pullRequests: 5,
        mergedPullRequests: 4,
        dominantLabels: ["bug", "docs"],
        lastActivityAt: "2026-05-30T00:00:00.000Z",
      }),
    ]);
  });
});

function totalsSnapshot(id: string, repoFullName: string, fetchedAt: string, openIssuesTotal: number) {
  return {
    id,
    repoFullName,
    openIssuesTotal,
    openPullRequestsTotal: 1,
    mergedPullRequestsTotal: 2,
    closedUnmergedPullRequestsTotal: 0,
    labelsTotal: 3,
    sourceKind: "test" as const,
    fetchedAt,
    rateLimitRemaining: null,
    rateLimitResetAt: null,
    payload: { repoFullName },
  };
}

function contributorStat(login: string, repoFullName: string, pullRequests: number, dominantLabels: string[], lastActivityAt: string) {
  return {
    login,
    repoFullName,
    pullRequests,
    mergedPullRequests: 1,
    openPullRequests: 1,
    issues: 1,
    stalePullRequests: 0,
    unlinkedPullRequests: 0,
    dominantLabels,
    lastActivityAt,
  };
}
