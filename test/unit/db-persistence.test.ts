import { describe, expect, it } from "vitest";
import {
  getContributorScoringProfile,
  getOpenUpstreamDriftReportByFingerprint,
  listContributorRepoStats,
  listLatestRepoGithubTotalsSnapshots,
  listRepoPullRequestFilePaths,
  persistBountyLifecycleEvent,
  persistRegistryDriftEvents,
  persistRepoGithubTotalsSnapshot,
  updateUpstreamDriftReportIssue,
  upsertContributorRepoStat,
  upsertContributorScoringProfile,
  upsertIssueQualityReport,
  upsertPullRequestFile,
  upsertUpstreamDriftReport,
} from "../../src/db/repositories";
import { buildContributorEvidenceGraph } from "../../src/services/contributor-evidence-graph";
import type { PullRequestFileRecord, PullRequestRecord, RepositoryRecord } from "../../src/types";
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

  it("caps contributor-graph file-path loading and still builds path edges from the capped set", async () => {
    const env = createTestEnv();
    const repoFullName = "owner/big-repo";
    // Seed more than the hard cap (500) of distinct file paths across several authored PRs.
    const seededPaths = 600;
    const pullNumbers = [1, 2, 3, 4, 5, 6];
    for (let index = 0; index < seededPaths; index += 1) {
      const pullNumber = pullNumbers[index % pullNumbers.length]!;
      await upsertPullRequestFile(env, pullRequestFile(repoFullName, pullNumber, `src/path-${String(index).padStart(4, "0")}.ts`));
    }

    // Hard cap: the path-only query never returns more than 500 rows even when more exist.
    const allPaths = await listRepoPullRequestFilePaths(env, repoFullName, { pullNumbers });
    expect(allPaths).toHaveLength(500);
    expect(allPaths.every((entry) => entry.repoFullName === repoFullName && pullNumbers.includes(entry.pullNumber) && entry.path.length > 0)).toBe(true);

    // A smaller requested limit is honored; a too-large limit is clamped down to the cap.
    const smallLimit = await listRepoPullRequestFilePaths(env, repoFullName, { pullNumbers, limit: 50 });
    expect(smallLimit).toHaveLength(50);
    const oversizedLimit = await listRepoPullRequestFilePaths(env, repoFullName, { pullNumbers, limit: 5000 });
    expect(oversizedLimit).toHaveLength(500);

    // Filtering by a subset of pull numbers still respects the cap and only returns matching PRs.
    const subset = await listRepoPullRequestFilePaths(env, repoFullName, { pullNumbers: [1, 2], limit: 500 });
    expect(subset.length).toBeGreaterThan(0);
    expect(subset.every((entry) => entry.pullNumber === 1 || entry.pullNumber === 2)).toBe(true);

    // The capped, path-only set still feeds buildPathEdges correctly via the evidence graph.
    const cappedPaths = await listRepoPullRequestFilePaths(env, repoFullName, { pullNumbers, limit: 500 });
    const graph = buildContributorEvidenceGraph({
      login: "dev",
      generatedAt: "2026-05-30T00:00:00.000Z",
      profile: graphProfile(repoFullName),
      outcomeHistory: graphHistory(),
      roleContexts: [],
      repositories: [graphRepo(repoFullName)],
      pullRequests: pullNumbers.map((number) => graphPr(repoFullName, number)),
      pullRequestFiles: cappedPaths,
    });

    expect(graph.paths.length).toBeGreaterThan(0);
    expect(graph.paths.every((entry) => entry.repoFullName === repoFullName)).toBe(true);
    // Every emitted path edge traces back to a path that survived the cap.
    const cappedPathSet = new Set(cappedPaths.map((entry) => entry.path));
    expect(graph.paths.every((entry) => cappedPathSet.has(entry.path))).toBe(true);
  });
});

function pullRequestFile(repoFullName: string, pullNumber: number, path: string): PullRequestFileRecord {
  return { repoFullName, pullNumber, path, status: "modified", additions: 5, deletions: 1, changes: 6, payload: {} };
}

function graphProfile(repoFullName: string) {
  return {
    login: "dev",
    generatedAt: "2026-05-30T00:00:00.000Z",
    github: { login: "dev", topLanguages: ["TypeScript"], source: "github" },
    source: "github_cache",
    registeredRepoActivity: { pullRequests: 6, mergedPullRequests: 6, issues: 0, reposTouched: [repoFullName], dominantLabels: [] },
    trustSignals: { evidenceScore: 0, level: "new", unlinkedOpenPullRequests: 0, maintainerAssociatedPullRequests: 0 },
  } as unknown as Parameters<typeof buildContributorEvidenceGraph>[0]["profile"];
}

function graphHistory() {
  return {
    login: "dev",
    generatedAt: "2026-05-30T00:00:00.000Z",
    source: "github_cache",
    totals: {},
    repoOutcomes: [],
    successPatterns: [],
    failurePatterns: [],
    summary: "fixture",
  } as unknown as Parameters<typeof buildContributorEvidenceGraph>[0]["outcomeHistory"];
}

function graphRepo(fullName: string): RepositoryRecord {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    fullName,
    owner,
    name,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    defaultBranch: "main",
    registryConfig: { repo: fullName, emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, trustedLabelPipeline: false, maintainerCut: 0, raw: {} },
  };
}

function graphPr(repoFullName: string, number: number): PullRequestRecord {
  return {
    repoFullName,
    number,
    title: `PR ${number}`,
    state: "merged",
    authorLogin: "dev",
    authorAssociation: "CONTRIBUTOR",
    labels: [],
    linkedIssues: [],
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    mergedAt: "2026-05-27T00:00:00.000Z",
  };
}

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
