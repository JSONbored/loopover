import { describe, expect, it } from "vitest";
import {
  getInstallationHealth,
  getIssue,
  getPullRequest,
  getRepository,
  getRepositorySettings,
  getRepoSyncState,
  listCheckSummaries,
  listCollisionEdges,
  listContributorIssues,
  listContributorPullRequests,
  listContributorRecentMergedPullRequests,
  listContributorRepoStats,
  listInstallationHealth,
  listInstallations,
  listIssueSignalSample,
  listOpenIssues,
  listPullRequestFiles,
  listPullRequestReviews,
  listRecentMergedPullRequests,
  listRepoLabels,
  listRepoSyncStates,
  listSignalSnapshots,
  countOpenIssues,
  persistRepoSnapshot,
  persistSignalSnapshot,
  replaceCollisionEdges,
  upsertCheckSummary,
  upsertContributor,
  upsertContributorRepoStat,
  upsertInstallation,
  upsertInstallationHealth,
  upsertIssueFromGitHub,
  upsertPullRequestFromGitHub,
  upsertPullRequestFile,
  upsertPullRequestReview,
  upsertRecentMergedPullRequest,
  upsertRepoLabel,
  upsertRepoSyncState,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("data spine repositories", () => {
  it("persists and reads sync, label, contributor, PR detail, collision, and installation records", async () => {
    const env = createTestEnv();
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        target_type: "User",
        repository_selection: "selected",
        permissions: { checks: "write", metadata: "read", pull_requests: "read" },
        events: ["issues", "pull_request", "repository"],
      },
    });
    expect(await listInstallations(env)).toMatchObject([{ id: 123, accountLogin: "JSONbored" }]);

    await upsertRepoSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      status: "partial",
      sourceKind: "github",
      primaryLanguage: "TypeScript",
      defaultBranch: "main",
      isPrivate: true,
      openIssuesCount: 3,
      openPullRequestsCount: 2,
      recentMergedPullRequestsCount: 1,
      labelsSyncedAt: "2026-05-23T00:00:00.000Z",
      warnings: ["truncated"],
    });
    expect(await getRepoSyncState(env, "JSONbored/gittensory")).toMatchObject({ status: "partial", warnings: ["truncated"] });
    expect(await listRepoSyncStates(env)).toHaveLength(1);

    await upsertRepoLabel(env, {
      repoFullName: "JSONbored/gittensory",
      name: "bug",
      color: "cc0000",
      description: "Bug",
      isConfigured: true,
      observedCount: 4,
      payload: { name: "bug" },
    });
    expect(await listRepoLabels(env, "JSONbored/gittensory")).toMatchObject([{ name: "bug", isConfigured: true, observedCount: 4 }]);

    await persistRepoSnapshot(env, {
      id: "snapshot-1",
      repoFullName: "JSONbored/gittensory",
      snapshotKind: "github-backfill",
      sourceKind: "github",
      fetchedAt: "2026-05-23T00:00:00.000Z",
      primaryLanguage: "TypeScript",
      defaultBranch: "main",
      openIssuesCount: 3,
      openPullRequestsCount: 2,
      recentMergedPullRequestsCount: 1,
      payload: { ok: true },
    });

    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 5,
      path: "src/index.ts",
      status: "modified",
      additions: 10,
      deletions: 2,
      changes: 12,
      payload: { filename: "src/index.ts" },
    });
    await upsertPullRequestReview(env, {
      id: "review-1",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 5,
      reviewerLogin: "maintainer",
      state: "APPROVED",
      submittedAt: "2026-05-23T00:00:00.000Z",
      payload: { id: 1 },
    });
    await upsertCheckSummary(env, {
      id: "check-1",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 5,
      headSha: "abc",
      name: "test",
      status: "completed",
      conclusion: "success",
      payload: { name: "test" },
    });
    expect(await listPullRequestFiles(env, "JSONbored/gittensory", 5)).toMatchObject([{ path: "src/index.ts", changes: 12 }]);
    expect(await listPullRequestReviews(env, "JSONbored/gittensory", 5)).toMatchObject([{ reviewerLogin: "maintainer" }]);
    expect(await listCheckSummaries(env, "JSONbored/gittensory", 5)).toMatchObject([{ name: "test", conclusion: "success" }]);

    await upsertRecentMergedPullRequest(env, {
      repoFullName: "JSONbored/gittensory",
      number: 4,
      title: "Fix index handler",
      authorLogin: "oktofeesh1",
      mergedAt: "2026-05-22T00:00:00.000Z",
      labels: ["bug"],
      linkedIssues: [2],
      changedFiles: ["src/index.ts"],
      payload: { number: 4 },
    });
    expect(await listRecentMergedPullRequests(env, "JSONbored/gittensory")).toMatchObject([{ number: 4, linkedIssues: [2] }]);

    await upsertContributor(env, {
      login: "oktofeesh1",
      githubProfile: { login: "oktofeesh1" },
      topLanguages: ["TypeScript"],
      publicRepos: 10,
      followers: 2,
      source: "github",
    });
    await upsertContributorRepoStat(env, {
      login: "oktofeesh1",
      repoFullName: "JSONbored/gittensory",
      pullRequests: 2,
      mergedPullRequests: 1,
      openPullRequests: 1,
      issues: 3,
      stalePullRequests: 0,
      unlinkedPullRequests: 0,
      dominantLabels: ["bug"],
      lastActivityAt: "2026-05-23T00:00:00.000Z",
    });
    expect(await listContributorRepoStats(env, "oktofeesh1")).toMatchObject([{ repoFullName: "JSONbored/gittensory", dominantLabels: ["bug"] }]);
    expect(await listContributorRepoStats(env, "OKTOFEESH1")).toMatchObject([{ repoFullName: "JSONbored/gittensory", dominantLabels: ["bug"] }]);
    expect(await listContributorRecentMergedPullRequests(env, "OKTOFEESH1")).toMatchObject([{ repoFullName: "JSONbored/gittensory", number: 4 }]);
    await env.DB.prepare(
      "insert into contributor_repo_stats (id, login, repo_full_name, pull_requests, merged_pull_requests, open_pull_requests, issues, stale_pull_requests, unlinked_pull_requests, dominant_labels_json, last_activity_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("legacy-case-stat", "OKTOFEESH1", "JSONbored/gittensory", 9, 8, 1, 7, 0, 0, '["ci"]', "2026-05-24T00:00:00.000Z")
      .run();
    expect(await listContributorRepoStats(env, "oktofeesh1")).toMatchObject([{ repoFullName: "JSONbored/gittensory", pullRequests: 9, mergedPullRequests: 8, issues: 7 }]);

    await replaceCollisionEdges(env, "JSONbored/gittensory", [
      {
        id: "edge-1",
        repoFullName: "JSONbored/gittensory",
        leftType: "issue",
        leftNumber: 2,
        leftTitle: "Fix index handler",
        rightType: "pull_request",
        rightNumber: 5,
        rightTitle: "Fix index handler",
        risk: "high",
        reason: "Same issue.",
        sharedTerms: ["index", "handler"],
      },
    ]);
    expect(await listCollisionEdges(env, "JSONbored/gittensory")).toMatchObject([{ risk: "high", sharedTerms: ["index", "handler"] }]);

    await persistSignalSnapshot(env, {
      id: "signal-1",
      signalType: "queue-health",
      targetKey: "JSONbored/gittensory",
      repoFullName: "JSONbored/gittensory",
      payload: { ok: true },
    });
    expect(await listSignalSnapshots(env, "queue-health", "JSONbored/gittensory")).toMatchObject([{ signalType: "queue-health" }]);

    await upsertInstallationHealth(env, {
      installationId: 123,
      accountLogin: "JSONbored",
      repositorySelection: "selected",
      installedReposCount: 1,
      registeredInstalledCount: 1,
      status: "healthy",
      missingPermissions: [],
      missingEvents: [],
      permissions: { checks: "write" },
      events: ["issues", "pull_request", "repository"],
      checkedAt: "2026-05-23T00:00:00.000Z",
    });
    expect(await getInstallationHealth(env, 123)).toMatchObject({ status: "healthy" });
    expect(await listInstallationHealth(env)).toHaveLength(1);
  });

  it("keeps repository readers defensive around missing rows and unknown stored enum values", async () => {
    const env = createTestEnv();
    await upsertInstallation(env, {});
    expect(await listInstallations(env)).toEqual([]);

    await upsertInstallation(env, { installation: { id: 999 } });
    expect(await listInstallations(env)).toMatchObject([{ id: 999, accountLogin: "unknown", accountId: 0, targetType: "unknown", permissions: {}, events: [] }]);

    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo" });
    expect(await getRepository(env, "owner/repo")).toMatchObject({ owner: "owner", isInstalled: false, isPrivate: false });
    expect(await getRepository(env, "OWNER/REPO")).toMatchObject({ fullName: "owner/repo" });
    expect(await getRepository(env, "missing/repo")).toBeNull();
    expect(await getRepositorySettings(env, "missing/repo")).toMatchObject({
      commentMode: "detected_contributors_only",
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      publicSurface: "comment_and_label",
      gatePack: "gittensor",
    });
    // gatePack (#692) round-trips and defaults to gittensor.
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", gatePack: "oss-anti-slop" });
    expect((await getRepositorySettings(env, "owner/repo")).gatePack).toBe("oss-anti-slop");
    await upsertRepositorySettings(env, { repoFullName: "owner/defaultpack" });
    expect((await getRepositorySettings(env, "owner/defaultpack")).gatePack).toBe("gittensor");
    expect(await getRepoSyncState(env, "missing/repo")).toBeNull();
    expect(await getPullRequest(env, "owner/repo", 404)).toBeNull();
    expect(await getIssue(env, "owner/repo", 404)).toBeNull();

    await upsertRepoSyncState(env, {
      repoFullName: "owner/repo",
      status: "success",
      sourceKind: "test",
      openIssuesCount: 0,
      openPullRequestsCount: 0,
      recentMergedPullRequestsCount: 0,
      warnings: [],
    });
    await env.DB.prepare("update repo_sync_state set status = ?, source_kind = ? where repo_full_name = ?").bind("weird", "weird", "owner/repo").run();
    expect(await getRepoSyncState(env, "owner/repo")).toMatchObject({ status: "never_synced", sourceKind: "github" });

    await replaceCollisionEdges(env, "owner/repo", [
      {
        id: "edge-weird",
        repoFullName: "owner/repo",
        leftType: "pull_request",
        leftNumber: 1,
        leftTitle: "Left",
        rightType: "recent_merged_pull_request",
        rightNumber: 2,
        rightTitle: "Right",
        risk: "medium",
        reason: "Medium overlap.",
        sharedTerms: [],
      },
    ]);
    await env.DB.prepare("update collision_edges set left_type = ?, risk = ? where id = ?").bind("not-real", "not-real", "edge-weird").run();
    expect(await listCollisionEdges(env, "owner/repo")).toMatchObject([{ leftType: "issue", rightType: "recent_merged_pull_request", risk: "low" }]);

    await upsertInstallationHealth(env, {
      installationId: 999,
      accountLogin: "unknown",
      repositorySelection: undefined,
      installedReposCount: 0,
      registeredInstalledCount: 0,
      status: "broken",
      missingPermissions: ["checks"],
      missingEvents: ["pull_request"],
      permissions: {},
      events: [],
      checkedAt: "2026-05-23T00:00:00.000Z",
    });
    await env.DB.prepare("update installation_health set status = ? where installation_id = ?").bind("weird", 999).run();
    expect(await getInstallationHealth(env, 999)).toMatchObject({ status: "needs_attention" });
  });

  it("extracts linked issue and PR references while ignoring malformed labels", async () => {
    const env = createTestEnv();
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 1,
      title: "Fix issue references",
      state: "open",
      user: { login: "JSONbored" },
      labels: [{}, { name: "bug" }],
      body: "Fixes #10 and closes #bad and resolves #11",
    });
    await upsertIssueFromGitHub(env, "owner/repo", {
      number: 10,
      title: "Issue with PR references",
      state: "open",
      user: { login: "JSONbored" },
      labels: [{}, { name: "bug" }],
      body: "Related PR #1 and pull request #2.",
    });
    await upsertIssueFromGitHub(env, "owner/repo", {
      number: 11,
      title: "Long issue body",
      state: "open",
      user: { login: "JSONbored" },
      labels: [],
      body: "a".repeat(5000),
      created_at: "2026-05-20T00:00:00.000Z",
      updated_at: "2026-05-21T00:00:00.000Z",
    });

    expect(await getPullRequest(env, "owner/repo", 1)).toMatchObject({ labels: ["bug"], linkedIssues: [10, 11] });
    expect(await getIssue(env, "owner/repo", 10)).toMatchObject({ labels: ["bug"], linkedPrs: [1, 2] });
    expect((await getIssue(env, "owner/repo", 11))?.body).toHaveLength(4000);
    expect(await countOpenIssues(env, "owner/repo")).toBe(2);
    expect(await listOpenIssues(env, "owner/repo")).toEqual(expect.arrayContaining([expect.objectContaining({ number: 10 }), expect.objectContaining({ number: 11 })]));
    expect(await listIssueSignalSample(env, "owner/repo", 1)).toHaveLength(1);
    expect(await listContributorPullRequests(env, "jsonbored")).toMatchObject([{ repoFullName: "owner/repo", number: 1 }]);
    expect(await listContributorIssues(env, "JSONBORED")).toEqual(expect.arrayContaining([expect.objectContaining({ repoFullName: "owner/repo", number: 10 }), expect.objectContaining({ repoFullName: "owner/repo", number: 11 })]));
  });
});
