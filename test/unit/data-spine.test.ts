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
  listLatestSignalSnapshotsForTargets,
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
  updatePullRequestSlopAssessment,
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
    for (let index = 0; index < 501; index += 1) {
      await upsertPullRequestFile(env, {
        repoFullName: "JSONbored/gittensory",
        pullNumber: 6,
        path: `docs/file-${index}.md`,
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: { filename: `docs/file-${index}.md` },
      });
    }
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 6,
      path: "scripts/deploy.sh",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: { filename: "scripts/deploy.sh" },
    });
    expect(await listPullRequestFiles(env, "JSONbored/gittensory", 6)).toHaveLength(502);
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
      authMode: "local",
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
      slopGateMode: "off",
      autonomy: {}, // #773 deny-by-default: no autonomy configured for a missing repo
    });
    // gatePack (#692) round-trips and defaults to gittensor.
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", gatePack: "oss-anti-slop" });
    expect((await getRepositorySettings(env, "owner/repo")).gatePack).toBe("oss-anti-slop");
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", gatePack: "gittensor", linkedIssueGateMode: "block" });
    expect(await getRepositorySettings(env, "owner/repo")).toMatchObject({ gatePack: "gittensor", linkedIssueGateMode: "block" });
    await upsertRepositorySettings(env, { repoFullName: "owner/defaultpack" });
    expect((await getRepositorySettings(env, "owner/defaultpack")).gatePack).toBe("gittensor");
    // slop gate (#530/#532) round-trips and defaults to off.
    await upsertRepositorySettings(env, { repoFullName: "owner/sloprepo", slopGateMode: "block", slopGateMinScore: 55, slopAiAdvisory: true });
    const slopSettings = await getRepositorySettings(env, "owner/sloprepo");
    expect(slopSettings.slopGateMode).toBe("block");
    expect(slopSettings.slopGateMinScore).toBe(55);
    expect(slopSettings.slopAiAdvisory).toBe(true); // AI advisory opt-in round-trips
    expect((await getRepositorySettings(env, "owner/defaultpack")).slopGateMode).toBe("off");
    expect((await getRepositorySettings(env, "owner/defaultpack")).slopAiAdvisory).toBe(false); // defaults off
    // Persist-on-UPDATE: re-upserting an existing row must persist slop_* (these were previously missing
    // from the onConflictDoUpdate SET clause, so updates silently dropped them).
    await upsertRepositorySettings(env, { repoFullName: "owner/sloprepo", slopGateMode: "advisory", slopGateMinScore: 40, slopAiAdvisory: false });
    const updated = await getRepositorySettings(env, "owner/sloprepo");
    expect(updated.slopGateMode).toBe("advisory");
    expect(updated.slopGateMinScore).toBe(40);
    // #773 agent autonomy round-trips (insert + update), drops invalid entries, and defaults to {}.
    await upsertRepositorySettings(env, { repoFullName: "owner/autonomyrepo", autonomy: { merge: "auto_with_approval", label: "auto", deploy: "auto" } as never });
    expect((await getRepositorySettings(env, "owner/autonomyrepo")).autonomy).toEqual({ merge: "auto_with_approval", label: "auto" });
    await upsertRepositorySettings(env, { repoFullName: "owner/autonomyrepo", autonomy: { merge: "observe" } });
    expect((await getRepositorySettings(env, "owner/autonomyrepo")).autonomy).toEqual({ merge: "observe" }); // update persists
    expect((await getRepositorySettings(env, "owner/defaultpack")).autonomy).toEqual({}); // deny-by-default
    // #774 autoMaintain round-trips, clamps requireApprovals, and defaults to squash/1.
    await upsertRepositorySettings(env, { repoFullName: "owner/automaintainrepo", autoMaintain: { requireApprovals: 99, mergeMethod: "rebase" } });
    expect((await getRepositorySettings(env, "owner/automaintainrepo")).autoMaintain).toEqual({ requireApprovals: 10, mergeMethod: "rebase" });
    await upsertRepositorySettings(env, { repoFullName: "owner/automaintainrepo", autoMaintain: { requireApprovals: 0, mergeMethod: "merge" } });
    expect((await getRepositorySettings(env, "owner/automaintainrepo")).autoMaintain).toEqual({ requireApprovals: 0, mergeMethod: "merge" }); // update persists
    expect((await getRepositorySettings(env, "owner/defaultpack")).autoMaintain).toEqual({ requireApprovals: 1, mergeMethod: "squash" }); // defaults
    // #776 kill-switch + dry-run round-trip (insert + update) and default false.
    await upsertRepositorySettings(env, { repoFullName: "owner/saferepo", agentPaused: true, agentDryRun: true });
    expect(await getRepositorySettings(env, "owner/saferepo")).toMatchObject({ agentPaused: true, agentDryRun: true });
    await upsertRepositorySettings(env, { repoFullName: "owner/saferepo", agentPaused: false });
    expect((await getRepositorySettings(env, "owner/saferepo")).agentPaused).toBe(false); // update persists
    expect(await getRepositorySettings(env, "owner/defaultpack")).toMatchObject({ agentPaused: false, agentDryRun: false }); // defaults
    // #4372 per-repo global-freeze-override round-trip (insert + update) and default false.
    await upsertRepositorySettings(env, { repoFullName: "owner/saferepo", agentGlobalFreezeOverride: true });
    expect((await getRepositorySettings(env, "owner/saferepo")).agentGlobalFreezeOverride).toBe(true);
    await upsertRepositorySettings(env, { repoFullName: "owner/saferepo", agentGlobalFreezeOverride: false });
    expect((await getRepositorySettings(env, "owner/saferepo")).agentGlobalFreezeOverride).toBe(false); // update persists
    expect((await getRepositorySettings(env, "owner/defaultpack")).agentGlobalFreezeOverride).toBe(false); // default
    // #2270 per-contributor open PR/issue caps: no row and no cap set both default to null (disabled).
    expect(await getRepositorySettings(env, "missing/repo")).toMatchObject({ contributorOpenPrCap: null, contributorOpenIssueCap: null });
    expect(await getRepositorySettings(env, "owner/defaultpack")).toMatchObject({ contributorOpenPrCap: null, contributorOpenIssueCap: null });
    // Round-trips on insert and persists on update.
    await upsertRepositorySettings(env, { repoFullName: "owner/caprepo", contributorOpenPrCap: 2, contributorOpenIssueCap: 5 });
    expect(await getRepositorySettings(env, "owner/caprepo")).toMatchObject({ contributorOpenPrCap: 2, contributorOpenIssueCap: 5 });
    await upsertRepositorySettings(env, { repoFullName: "owner/caprepo", contributorOpenPrCap: 3, contributorOpenIssueCap: null });
    expect(await getRepositorySettings(env, "owner/caprepo")).toMatchObject({ contributorOpenPrCap: 3, contributorOpenIssueCap: null }); // update persists + can clear
    await upsertRepositorySettings(env, { repoFullName: "owner/caprepo", contributorOpenPrCap: 101, contributorOpenIssueCap: 150 });
    expect(await getRepositorySettings(env, "owner/caprepo")).toMatchObject({ contributorOpenPrCap: 100, contributorOpenIssueCap: 100 }); // clamps to the live-check sample budget
    // A cap must be a positive whole number: fractional, non-positive, and non-finite values are all
    // dropped to null rather than silently coerced (there's no such thing as "allow 2.5 open PRs").
    await upsertRepositorySettings(env, { repoFullName: "owner/badcaprepo", contributorOpenPrCap: 2.5 as never });
    expect((await getRepositorySettings(env, "owner/badcaprepo")).contributorOpenPrCap).toBeNull();
    await upsertRepositorySettings(env, { repoFullName: "owner/badcaprepo", contributorOpenPrCap: 0 });
    expect((await getRepositorySettings(env, "owner/badcaprepo")).contributorOpenPrCap).toBeNull();
    await upsertRepositorySettings(env, { repoFullName: "owner/badcaprepo", contributorOpenPrCap: Number.NaN as never });
    expect((await getRepositorySettings(env, "owner/badcaprepo")).contributorOpenPrCap).toBeNull();
    // contributorCapLabel (#2270) round-trips and defaults to "over-contributor-limit".
    expect((await getRepositorySettings(env, "missing/repo")).contributorCapLabel).toBe("over-contributor-limit");
    await upsertRepositorySettings(env, { repoFullName: "owner/caprepo", contributorCapLabel: "spam-cap" });
    expect((await getRepositorySettings(env, "owner/caprepo")).contributorCapLabel).toBe("spam-cap");
    await upsertRepositorySettings(env, { repoFullName: "owner/caprepo", contributorCapLabel: "renamed-cap" });
    expect((await getRepositorySettings(env, "owner/caprepo")).contributorCapLabel).toBe("renamed-cap"); // update persists
    // #2552 force-rebase-before-merge window: no row and no override both default to null (never force).
    expect((await getRepositorySettings(env, "missing/repo")).requireFreshRebaseWindowMinutes).toBeNull();
    expect((await getRepositorySettings(env, "owner/defaultpack")).requireFreshRebaseWindowMinutes).toBeNull();
    // Round-trips on insert and persists on update; a fractional/non-positive value drops to null.
    await upsertRepositorySettings(env, { repoFullName: "owner/rebasewindowrepo", requireFreshRebaseWindowMinutes: 15 });
    expect((await getRepositorySettings(env, "owner/rebasewindowrepo")).requireFreshRebaseWindowMinutes).toBe(15);
    await upsertRepositorySettings(env, { repoFullName: "owner/rebasewindowrepo", requireFreshRebaseWindowMinutes: 30 });
    expect((await getRepositorySettings(env, "owner/rebasewindowrepo")).requireFreshRebaseWindowMinutes).toBe(30); // update persists
    await upsertRepositorySettings(env, { repoFullName: "owner/rebasewindowrepo", requireFreshRebaseWindowMinutes: 2.5 as never });
    expect((await getRepositorySettings(env, "owner/rebasewindowrepo")).requireFreshRebaseWindowMinutes).toBeNull();
    // REGRESSION: this is a minutes-based freshness window, not a live-verification-sample-bounded count like
    // contributorOpenPrCap above -- it must NOT inherit that unrelated cap's 100 ceiling.
    await upsertRepositorySettings(env, { repoFullName: "owner/rebasewindowrepo", requireFreshRebaseWindowMinutes: 500 });
    expect((await getRepositorySettings(env, "owner/rebasewindowrepo")).requireFreshRebaseWindowMinutes).toBe(500);
    // #1936 minimum account-age gate: no row and no override both default to null (never enforced); round-trips,
    // and (REGRESSION, same reasoning as requireFreshRebaseWindowMinutes above) is not capped at 100.
    expect((await getRepositorySettings(env, "missing/repo")).accountAgeThresholdDays).toBeNull();
    await upsertRepositorySettings(env, { repoFullName: "owner/accountagerepo", accountAgeThresholdDays: 365 });
    expect((await getRepositorySettings(env, "owner/accountagerepo")).accountAgeThresholdDays).toBe(365);
    // #2463 review-nag cooldown + shared exemption list: no row and no override both default to off/3/5/the
    // default label/empty exemption list.
    expect(await getRepositorySettings(env, "missing/repo")).toMatchObject({
      reviewNagPolicy: "off",
      reviewNagMaxPings: 3,
      reviewNagCooldownDays: 5,
      reviewNagLabel: "review-nag-cooldown",
      autoCloseExemptLogins: [],
    });
    expect(await getRepositorySettings(env, "owner/defaultpack")).toMatchObject({ reviewNagPolicy: "off", autoCloseExemptLogins: [] });
    // Round-trips on insert and persists on update.
    await upsertRepositorySettings(env, {
      repoFullName: "owner/nagrepo",
      reviewNagPolicy: "close",
      reviewNagMaxPings: 5,
      reviewNagCooldownDays: 10,
      reviewNagLabel: "too-many-pings",
      autoCloseExemptLogins: ["Trusted-Regular"],
    });
    expect(await getRepositorySettings(env, "owner/nagrepo")).toMatchObject({
      reviewNagPolicy: "close",
      reviewNagMaxPings: 5,
      reviewNagCooldownDays: 10,
      reviewNagLabel: "too-many-pings",
      autoCloseExemptLogins: ["Trusted-Regular"],
    });
    await upsertRepositorySettings(env, { repoFullName: "owner/nagrepo", reviewNagPolicy: "hold", autoCloseExemptLogins: [] });
    expect(await getRepositorySettings(env, "owner/nagrepo")).toMatchObject({ reviewNagPolicy: "hold", autoCloseExemptLogins: [] }); // update persists + can clear
    // An invalid policy string is dropped to "off"; a non-positive/fractional ping count or cooldown falls
    // back to its default rather than being silently coerced.
    await upsertRepositorySettings(env, { repoFullName: "owner/badnagrepo", reviewNagPolicy: "delete-everything" as never, reviewNagMaxPings: -1, reviewNagCooldownDays: 2.5 as never });
    expect(await getRepositorySettings(env, "owner/badnagrepo")).toMatchObject({ reviewNagPolicy: "off", reviewNagMaxPings: 3, reviewNagCooldownDays: 5 });
    await upsertRepositorySettings(env, { repoFullName: "owner/bigwindowrepo", reviewNagMaxPings: 1_000, reviewNagCooldownDays: 1_000_000_000 });
    expect(await getRepositorySettings(env, "owner/bigwindowrepo")).toMatchObject({ reviewNagMaxPings: 1_000, reviewNagCooldownDays: 365 });
    await env.DB.prepare("update repository_settings set review_nag_cooldown_days = ? where repo_full_name = ?").bind(1_000_000_000, "owner/bigwindowrepo").run();
    expect(await getRepositorySettings(env, "owner/bigwindowrepo")).toMatchObject({ reviewNagMaxPings: 1_000, reviewNagCooldownDays: 365 });
    expect(updated.slopAiAdvisory).toBe(false);
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
      authMode: "local",
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

  it("persists a per-PR slop assessment, round-trips it via the cached record, and keeps latest-wins (PR2)", async () => {
    const env = createTestEnv();
    await upsertPullRequestFromGitHub(env, "owner/sloppr", { number: 5, title: "Churn", state: "open", user: { login: "alice" }, labels: [], body: "x" });
    // Unassessed by default (slop off, or PR not yet processed).
    expect((await getPullRequest(env, "owner/sloppr", 5))?.slopRisk ?? null).toBeNull();
    expect((await getPullRequest(env, "owner/sloppr", 5))?.slopBand ?? null).toBeNull();

    await updatePullRequestSlopAssessment(env, "owner/sloppr", 5, { slopRisk: 72, slopBand: "high" });
    const assessed = await getPullRequest(env, "owner/sloppr", 5);
    expect(assessed?.slopRisk).toBe(72);
    expect(assessed?.slopBand).toBe("high");

    // Latest assessment wins on the next run.
    await updatePullRequestSlopAssessment(env, "owner/sloppr", 5, { slopRisk: 10, slopBand: "low" });
    expect((await getPullRequest(env, "owner/sloppr", 5))?.slopBand).toBe("low");

    // Slop-off processing can clear a previously persisted dashboard assessment.
    await updatePullRequestSlopAssessment(env, "owner/sloppr", 5, { slopRisk: null, slopBand: null });
    const cleared = await getPullRequest(env, "owner/sloppr", 5);
    expect(cleared?.slopRisk).toBeNull();
    expect(cleared?.slopBand).toBeNull();

    // No-op (no throw) when the PR row does not exist yet.
    await expect(updatePullRequestSlopAssessment(env, "owner/sloppr", 999, { slopRisk: 5, slopBand: "low" })).resolves.toBeUndefined();
  });
});

describe("listLatestSignalSnapshotsForTargets (#3202 — bulk latest-per-target lookup)", () => {
  it("returns an empty map without querying the DB for an empty target-key list", async () => {
    const env = createTestEnv();
    expect(await listLatestSignalSnapshotsForTargets(env, "queue-health", [])).toEqual(new Map());
  });

  it("resolves the LATEST snapshot per target key in one call, ignores other signal types, and omits an unmatched key", async () => {
    const env = createTestEnv();
    await persistSignalSnapshot(env, { id: "a-old", signalType: "repo-doc-refresh-attempt", targetKey: "owner/a", payload: {}, generatedAt: "2026-01-01T00:00:00.000Z" });
    await persistSignalSnapshot(env, { id: "a-new", signalType: "repo-doc-refresh-attempt", targetKey: "owner/a", payload: {}, generatedAt: "2026-06-01T00:00:00.000Z" });
    await persistSignalSnapshot(env, { id: "b-only", signalType: "repo-doc-refresh-attempt", targetKey: "owner/b", payload: {}, generatedAt: "2026-03-01T00:00:00.000Z" });
    // Same target key, but a DIFFERENT signal type -- must not leak into the result.
    await persistSignalSnapshot(env, { id: "a-other-signal", signalType: "queue-health", targetKey: "owner/a", payload: {}, generatedAt: "2026-12-01T00:00:00.000Z" });

    const result = await listLatestSignalSnapshotsForTargets(env, "repo-doc-refresh-attempt", ["owner/a", "owner/b", "owner/c"]);

    expect(result.size).toBe(2);
    expect(result.get("owner/a")).toMatchObject({ id: "a-new", generatedAt: "2026-06-01T00:00:00.000Z" });
    expect(result.get("owner/b")).toMatchObject({ id: "b-only", generatedAt: "2026-03-01T00:00:00.000Z" });
    expect(result.has("owner/c")).toBe(false);
  });

  it("batches target-key lookups to stay under D1 bound-parameter limits", async () => {
    const env = createTestEnv();
    const targetKeys = Array.from({ length: 95 }, (_, index) => `owner/repo-${index}`);
    for (const [index, targetKey] of targetKeys.entries()) {
      await persistSignalSnapshot(env, {
        id: `batched-${index}`,
        signalType: "repo-doc-refresh-attempt",
        targetKey,
        payload: {},
        generatedAt: `2026-06-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    const db = env.DB;
    const boundCounts: number[] = [];
    env.DB = {
      ...db,
      prepare(sql: string) {
        const statement = db.prepare(sql);
        return {
          ...statement,
          bind(...values: Parameters<typeof statement.bind>) {
            if (sql.includes("FROM signal_snapshots") && sql.includes("target_key IN")) {
              boundCounts.push(values.length);
              if (values.length > 91) throw new Error(`too many bound parameters: ${values.length}`);
            }
            return statement.bind(...values);
          },
        };
      },
    } as D1Database;

    const result = await listLatestSignalSnapshotsForTargets(env, "repo-doc-refresh-attempt", targetKeys);

    expect(result.size).toBe(95);
    expect(result.get("owner/repo-0")?.id).toBe("batched-0");
    expect(result.get("owner/repo-94")?.id).toBe("batched-94");
    expect(boundCounts).toEqual([91, 6]);
  });
});
