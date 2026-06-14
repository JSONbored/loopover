import { describe, expect, it } from "vitest";
import {
  buildCollisionEdges,
  buildCollisionReport,
  buildBurdenForecast,
  buildBountyAdvisory,
  buildContributorFit,
  buildContributorOutcomeHistory,
  buildContributorPatternReport,
  buildContributorProfile,
  buildContributorScoringProfile,
  buildContributorStrategy,
  buildContributorIntakeHealth,
  buildIssueDiscoveryLifecycleReport,
  buildIssueQualityReport,
  buildLabelAudit,
  buildLocalDiffPreflightResult,
  buildMaintainerCutReadiness,
  buildMaintainerLaneReport,
  buildMaintainerPacket,
  buildPreflightResult,
  buildPublicPrIntelligenceComment,
  buildPullRequestMaintainerPacket,
  buildPullRequestReviewIntelligence,
  buildQueueHealth,
  buildRegistryChangeReport,
  buildRepoFitRecommendation,
  buildRoleContext,
} from "../../src/signals/engine";
import {
  buildContributorRewardRiskStrategy,
  buildMaintainerNoiseReport,
  buildPullRequestReviewability,
  buildRepoRewardRisk,
} from "../../src/signals/reward-risk";
import type { ContributorRepoStatRecord, IssueRecord, PullRequestRecord, RecentMergedPullRequestRecord, RegistrySnapshot, RepoLabelRecord, RepositoryRecord, ScoringModelSnapshotRecord } from "../../src/types";

const repo: RepositoryRecord = {
  fullName: "JSONbored/gittensory",
  owner: "JSONbored",
  name: "gittensory",
  isInstalled: true,
  isRegistered: true,
  isPrivate: true,
  defaultBranch: "main",
  registryConfig: {
    repo: "JSONbored/gittensory",
    emissionShare: 0.01,
    issueDiscoveryShare: 0,
    labelMultipliers: { bug: 1.2, "status:ready": 0.2, missing: 0.5 },
    trustedLabelPipeline: true,
    maintainerCut: 0,
    raw: {},
  },
};

const issues: IssueRecord[] = [
  {
    repoFullName: repo.fullName,
    number: 1,
    title: "Webhook processing fails on duplicate delivery",
    state: "open",
    authorLogin: "reporter",
    labels: ["bug"],
    linkedPrs: [],
    body: "Duplicate delivery should be idempotent.",
  },
];

const pullRequests: PullRequestRecord[] = [
  {
    repoFullName: repo.fullName,
    number: 10,
    title: "Fix webhook processing duplicate delivery",
    state: "open",
    authorLogin: "oktofeesh1",
    authorAssociation: "NONE",
    labels: ["bug"],
    linkedIssues: [1],
    body: "Fixes #1",
    updatedAt: "2026-05-23T00:00:00.000Z",
  },
  {
    repoFullName: repo.fullName,
    number: 11,
    title: "Alternative webhook processing fix",
    state: "open",
    authorLogin: "other",
    authorAssociation: "MEMBER",
    labels: ["bug"],
    linkedIssues: [1],
    body: "Fixes #1",
    updatedAt: "2026-04-01T00:00:00.000Z",
  },
];

const recentMergedPullRequests: RecentMergedPullRequestRecord[] = [
  {
    repoFullName: repo.fullName,
    number: 9,
    title: "Fix webhook processing duplicate delivery",
    authorLogin: "oktofeesh1",
    labels: ["bug"],
    linkedIssues: [1],
    changedFiles: ["src/github/webhook.ts"],
    mergedAt: "2026-05-22T00:00:00.000Z",
    payload: {},
  },
];

describe("v2 signal builders", () => {
  it("audits trusted label pipeline readiness", () => {
    const labels: RepoLabelRecord[] = [
      { repoFullName: repo.fullName, name: "bug", isConfigured: true, observedCount: 3, payload: {} },
      { repoFullName: repo.fullName, name: "enhancement", isConfigured: false, observedCount: 0, payload: {} },
    ];
    const audit = buildLabelAudit(repo, labels, issues, pullRequests, repo.fullName);
    expect(audit.missingConfiguredLabels).toEqual(["missing", "status:ready"]);
    expect(audit.suspiciousConfiguredLabels).toEqual(["status:ready"]);
    expect(audit.trustedPipelineReady).toBe(false);
  });

  it("uses recent merged PRs and linked issues in collision radar", () => {
    const report = buildCollisionReport(repo.fullName, issues, pullRequests, recentMergedPullRequests);
    expect(report.summary.itemsReviewed).toBe(4);
    expect(report.summary.highRiskCount).toBeGreaterThan(0);
    const edges = buildCollisionEdges(report);
    expect(edges[0]).toMatchObject({ repoFullName: repo.fullName, risk: expect.any(String) });
  });

  it("keeps collision radar bounded for huge issue queues while preserving queue totals", () => {
    const manyIssues = Array.from({ length: 1000 }, (_, index) => ({
      repoFullName: repo.fullName,
      number: index + 1,
      title: `Issue ${index + 1}`,
      state: "open" as const,
      labels: [],
      linkedPrs: [],
    }));
    const linkedPr = { ...pullRequests[0]!, number: 5000, linkedIssues: [999], title: "Fix issue 999" };
    const report = buildCollisionReport(repo.fullName, manyIssues, [linkedPr], []);
    const health = buildQueueHealth(repo, manyIssues, [linkedPr], report);

    expect(report.summary.itemsReviewed).toBe(1001);
    expect(report.clusters).toEqual(expect.arrayContaining([expect.objectContaining({ id: "issue-999" })]));
    expect(health.signals.openIssues).toBe(1000);
    expect(health.signals.openPullRequests).toBe(1);
  });

  it("uses authoritative queue counts when signal inputs are sampled", () => {
    const sampledIssues = issues.slice(0, 1);
    const sampledPullRequests = pullRequests.slice(0, 1);
    const report = buildCollisionReport(repo.fullName, sampledIssues, sampledPullRequests, []);
    const health = buildQueueHealth(repo, sampledIssues, sampledPullRequests, report, { openIssues: 2912, openPullRequests: 169, likelyReviewablePullRequests: 42 });
    const intake = buildContributorIntakeHealth(repo, sampledIssues, sampledPullRequests, repo.fullName, report, { openIssues: 2912, openPullRequests: 169 });
    const lane = buildMaintainerLaneReport(repo, sampledIssues, sampledPullRequests, repo.fullName, report, { openIssues: 2912, openPullRequests: 169 });

    expect(health.signals.openIssues).toBe(2912);
    expect(health.signals.openPullRequests).toBe(169);
    expect(health.signals.likelyReviewablePullRequests).toBe(42);
    expect(health.signals.cachedOpenPullRequests).toBe(1);
    expect(health.signals.likelyReviewablePullRequestsSource).toBe("authoritative");
    expect(intake.queueHealth.signals.openIssues).toBe(2912);
    expect(lane.queueHealth.signals.openPullRequests).toBe(169);
  });

  it("falls back independently when only one authoritative queue count is present", () => {
    const report = buildCollisionReport(repo.fullName, issues, pullRequests, []);
    const issueOnly = buildQueueHealth(repo, issues, pullRequests, report, { openIssues: 50 });
    const prOnly = buildQueueHealth(repo, issues, pullRequests, report, { openPullRequests: 25 });

    expect(issueOnly.signals.openIssues).toBe(50);
    expect(issueOnly.signals.openPullRequests).toBe(pullRequests.length);
    expect(prOnly.signals.openIssues).toBe(issues.length);
    expect(prOnly.signals.openPullRequests).toBe(25);
    expect(prOnly.signals.likelyReviewablePullRequestsSource).toBe("sampled_cache");
  });

  it("adds queue age buckets and likely-reviewable counts", () => {
    const report = buildCollisionReport(repo.fullName, issues, pullRequests, recentMergedPullRequests);
    const health = buildQueueHealth(repo, issues, pullRequests, report);
    expect(health.signals.ageBuckets.over30Days).toBeGreaterThanOrEqual(1);
    expect(health.signals.maintainerAuthoredPullRequests).toBe(1);
    expect(health.signals.likelyReviewablePullRequests).toBeGreaterThanOrEqual(1);
  });

  it("builds contributor fit from language and cached repo stats", () => {
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, pullRequests, issues);
    const fit = buildContributorFit(
      profile,
      [repo],
      issues,
      pullRequests,
      [
        {
          repoFullName: repo.fullName,
          status: "success",
          sourceKind: "github",
          primaryLanguage: "TypeScript",
          openIssuesCount: 1,
          openPullRequestsCount: 2,
          recentMergedPullRequestsCount: 1,
          warnings: [],
        },
      ],
      [
        {
          login: "oktofeesh1",
          repoFullName: repo.fullName,
          pullRequests: 2,
          mergedPullRequests: 1,
          openPullRequests: 1,
          issues: 0,
          stalePullRequests: 0,
          unlinkedPullRequests: 0,
          dominantLabels: ["bug"],
        },
      ],
    );
    expect(fit.languageFit[0]).toMatchObject({ repoFullName: repo.fullName, match: true });
    expect(fit.repoStats[0]).toMatchObject({ mergedPullRequests: 1 });
  });

  it("preflights local diffs without source content", () => {
    const result = buildLocalDiffPreflightResult(
      {
        repoFullName: repo.fullName,
        title: "Fix webhook processing duplicate delivery",
        commitMessage: "fix: resolve duplicate delivery\n\nFixes #1",
        changedFiles: ["src/github/webhook.ts", "test/unit/webhook.test.ts"],
        changedLineCount: 120,
      },
      repo,
      issues,
      pullRequests,
    );
    expect(result.localDiff).toMatchObject({ changedFileCount: 2, codeFileCount: 1, testFileCount: 1, inferredLinkedIssues: [1] });
    expect(JSON.stringify(result)).not.toMatch(/reward|farming|wallet/i);
  });

  it("builds a PR-specific maintainer packet", () => {
    const packet = buildPullRequestMaintainerPacket({
      repo,
      pullRequest: pullRequests[0]!,
      issues,
      pullRequests,
      files: [
        {
          repoFullName: repo.fullName,
          pullNumber: 10,
          path: "src/github/webhook.ts",
          additions: 20,
          deletions: 4,
          changes: 24,
          payload: {},
        },
      ],
      reviews: [
        {
          id: "review-1",
          repoFullName: repo.fullName,
          pullNumber: 10,
          reviewerLogin: "maintainer",
          state: "CHANGES_REQUESTED",
          payload: {},
        },
      ],
      checks: [{ id: "check-1", repoFullName: repo.fullName, pullNumber: 10, name: "test", status: "completed", conclusion: "failure", payload: {} }],
      recentMergedPullRequests,
      repoFullName: repo.fullName,
      pullNumber: 10,
    });
    expect(packet.reviewPriority).toBe("needs_author");
    expect(packet.changeSummary.additions).toBe(20);
    expect(packet.reviewSignals.checkFailureCount).toBe(1);
  });

  it("reports registry changes between snapshots", () => {
    const current = snapshot("new", [
      { repo: "JSONbored/gittensory", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: { bug: 1.1 } },
      { repo: "JSONbored/awesome-claude", emissionShare: 0.01, issueDiscoveryShare: 0, labelMultipliers: {} },
    ]);
    const previous = snapshot("old", [{ repo: "JSONbored/gittensory", emissionShare: 0.01, issueDiscoveryShare: 0, labelMultipliers: {} }]);
    const report = buildRegistryChangeReport([current, previous]);
    expect(report.addedRepos).toEqual(["JSONbored/awesome-claude"]);
    expect(report.changedRepos[0]?.changes).toContain("emission_share 0.01 -> 0.02");
  });

  it("reports changes to fixed base score, default label multiplier, and eligibility mode", () => {
    // Only fixedBaseScore changes; every other compared field is identical. The base
    // score override is the highest-impact registry change, so it must be surfaced.
    const previous = snapshot("old", [{ repo: "JSONbored/gittensory", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, fixedBaseScore: 2 }]);
    const current = snapshot("new", [{ repo: "JSONbored/gittensory", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, fixedBaseScore: 50 }]);
    const report = buildRegistryChangeReport([current, previous]);
    expect(report.changedRepos).toHaveLength(1);
    expect(report.changedRepos[0]?.changes).toContain("fixed_base_score 2 -> 50");
    expect(report.summary).toContain("1 changed");

    // eligibility_mode and default_label_multiplier are tracked too.
    const beforeMode = snapshot("old2", [{ repo: "JSONbored/gittensory", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, eligibilityMode: "branch_required", defaultLabelMultiplier: 1 }]);
    const afterMode = snapshot("new2", [{ repo: "JSONbored/gittensory", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, eligibilityMode: "any_branch", defaultLabelMultiplier: 1.2 }]);
    const modeReport = buildRegistryChangeReport([afterMode, beforeMode]);
    expect(modeReport.changedRepos[0]?.changes).toEqual(
      expect.arrayContaining(["eligibility_mode branch_required -> any_branch", "default_label_multiplier 1 -> 1.2"]),
    );
  });

  it("builds repo-level maintainer packets with fallback actions", () => {
    const packet = buildMaintainerPacket(repo, [], [], repo.fullName);
    const busyPacket = buildMaintainerPacket(repo, issues, pullRequests, repo.fullName);

    expect(packet.suggestedActions).toEqual(["Queue looks manageable from cached Gittensory signals."]);
    expect(busyPacket.pullRequestPackets.map((item) => item.reviewPriority)).toContain("needs_author");
    expect(busyPacket.suggestedActions.length).toBeGreaterThan(1);
  });

  it("covers preflight statuses, review burden levels, and local diff warnings", () => {
    const ready = buildPreflightResult(
      { repoFullName: repo.fullName, title: "Update docs", body: "Fixes #1", changedFiles: ["docs/guide.md"], tests: ["manual docs check"] },
      repo,
      [],
      [],
    );
    const medium = buildPreflightResult(
      { repoFullName: repo.fullName, title: "Small typed change", body: "Fixes #1", changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"], tests: ["vitest"] },
      repo,
      [],
      [],
    );
    const hold = buildPreflightResult({ repoFullName: "unknown/repo", title: "Unknown lane" }, null, [], []);
    const large = buildLocalDiffPreflightResult(
      { repoFullName: repo.fullName, title: "Large diff", body: "Fixes #1", changedFiles: ["src/a.ts"], changedLineCount: 900 },
      repo,
      [],
      [],
    );

    expect(ready.status).toBe("ready");
    expect(ready.reviewBurden).toBe("low");
    expect(medium.reviewBurden).toBe("medium");
    expect(hold.status).toBe("hold");
    expect(large.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["large_local_diff", "local_diff_missing_tests"]));
  });

  it("builds clean, missing, and watch PR maintainer packets", () => {
    const cleanPr = { ...pullRequests[0]!, linkedIssues: [1], body: "Fixes #1" };
    const cleanPacket = buildPullRequestMaintainerPacket({
      repo,
      pullRequest: cleanPr,
      issues: [],
      pullRequests: [cleanPr],
      files: [
        { repoFullName: repo.fullName, pullNumber: cleanPr.number, path: "src/github/webhook.ts", additions: 8, deletions: 2, changes: 10, payload: {} },
        { repoFullName: repo.fullName, pullNumber: cleanPr.number, path: "test/unit/webhook.test.ts", additions: 12, deletions: 0, changes: 12, payload: {} },
      ],
      reviews: [{ id: "approved", repoFullName: repo.fullName, pullNumber: cleanPr.number, state: "APPROVED", payload: {} }],
      checks: [{ id: "ok", repoFullName: repo.fullName, pullNumber: cleanPr.number, name: "test", status: "completed", conclusion: "success", payload: {} }],
      recentMergedPullRequests: [],
      repoFullName: repo.fullName,
      pullNumber: cleanPr.number,
    });
    const watchPacket = buildPullRequestMaintainerPacket({
      repo,
      pullRequest: cleanPr,
      issues: [],
      pullRequests: [cleanPr],
      files: [],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: repo.fullName,
      pullNumber: cleanPr.number,
    });
    const unlinkedPacket = buildPullRequestMaintainerPacket({
      repo,
      pullRequest: { ...cleanPr, linkedIssues: [] },
      issues: [],
      pullRequests: [{ ...cleanPr, linkedIssues: [] }],
      files: [],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: repo.fullName,
      pullNumber: cleanPr.number,
    });
    const missingPacket = buildPullRequestMaintainerPacket({
      repo,
      pullRequest: null,
      issues: [],
      pullRequests: [],
      files: [],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: repo.fullName,
      pullNumber: 404,
    });

    expect(cleanPacket.reviewPriority).toBe("review");
    expect(watchPacket.reviewPriority).toBe("watch");
    expect(unlinkedPacket.findings.map((finding) => finding.code)).toContain("missing_linked_issue");
    expect(missingPacket.findings.map((finding) => finding.code)).toContain("pr_not_cached");
  });

  it("handles registry change report boundaries and all tracked fields", () => {
    const onlyCurrent = snapshot("only", [{ repo: "JSONbored/gittensory", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {} }]);
    const current = snapshot("current", [
      { repo: "JSONbored/gittensory", emissionShare: 0.02, issueDiscoveryShare: 1, labelMultipliers: { bug: 1 } },
    ]);
    current.repositories[0]!.maintainerCut = 0.5;
    current.repositories[0]!.trustedLabelPipeline = true;
    const previous = snapshot("previous", [
      { repo: "JSONbored/gittensory", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {} },
      { repo: "old/repo", emissionShare: 0.01, issueDiscoveryShare: 0, labelMultipliers: {} },
    ]);

    expect(buildRegistryChangeReport([]).summary).toMatch(/No registry snapshots/);
    expect(buildRegistryChangeReport([onlyCurrent]).addedRepos).toEqual(["JSONbored/gittensory"]);
    const changed = buildRegistryChangeReport([current, previous]);
    expect(changed.removedRepos).toEqual(["old/repo"]);
    expect(changed.changedRepos[0]?.changes).toEqual(
      expect.arrayContaining(["issue_discovery_share 0 -> 1", "maintainer_cut 0 -> 0.5", "label_multipliers changed", "trusted_label_pipeline false -> true"]),
    );
  });

  it("keeps collision edge generation stable for short and low-risk clusters", () => {
    const edges = buildCollisionEdges({
      repoFullName: repo.fullName,
      generatedAt: "2026-05-23T00:00:00.000Z",
      summary: { clusterCount: 2, highRiskCount: 0, itemsReviewed: 2 },
      clusters: [
        { id: "single", risk: "low", reason: "Single item", items: [{ type: "issue", number: 1, title: "" }] },
        {
          id: "low-risk",
          risk: "low",
          reason: "Manual low risk",
          items: [
            { type: "issue", number: 1, title: "" },
            { type: "pull_request", number: 2, title: "docs only", body: "docs only" },
          ],
        },
      ],
    });

    expect(edges).toHaveLength(1);
    expect(edges[0]?.risk).toBe("low");
  });

  it("classifies issue quality, burden forecasts, and contributor strategy branches", () => {
    const issueSet: IssueRecord[] = [
      {
        repoFullName: repo.fullName,
        number: 21,
        title: "Ready issue with clear reproduction",
        state: "open",
        body: "This issue has a clear reproduction path, expected behavior, actual behavior, logs, screenshots, and a narrow implementation scope for a contributor.",
        labels: ["bug"],
        linkedPrs: [],
      },
      {
        repoFullName: repo.fullName,
        number: 22,
        title: "Thin report",
        state: "open",
        body: "bad",
        labels: [],
        linkedPrs: [],
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      {
        repoFullName: repo.fullName,
        number: 23,
        title: "Already solved report",
        state: "open",
        body: "This already has linked work.",
        labels: ["bug"],
        linkedPrs: [44],
      },
    ];
    const prSet: PullRequestRecord[] = [
      {
        repoFullName: repo.fullName,
        number: 44,
        title: "Fix already solved report",
        state: "merged",
        mergedAt: "2026-05-01T00:00:00.000Z",
        linkedIssues: [23],
        labels: ["bug"],
        authorLogin: "oktofeesh1",
        body: "Fixes #23",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      {
        repoFullName: repo.fullName,
        number: 45,
        title: "Stale contributor branch",
        state: "open",
        linkedIssues: [],
        labels: ["bug"],
        authorLogin: "oktofeesh1",
        body: "",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ];
    const issueQuality = buildIssueQualityReport(
      { ...repo, registryConfig: { ...repo.registryConfig!, issueDiscoveryShare: 0.5 } },
      issueSet,
      prSet,
      repo.fullName,
    );
    expect(issueQuality.issues.map((issue) => issue.status)).toEqual(expect.arrayContaining(["ready", "needs_proof", "do_not_use"]));
    expect(issueQuality.issues.find((issue) => issue.number === 22)).toMatchObject({ lifecycle: "stale" });
    expect(issueQuality.issues.find((issue) => issue.number === 23)).toMatchObject({ lifecycle: "valid_solved", status: "do_not_use" });

    const lifecycle = buildIssueDiscoveryLifecycleReport(
      { ...repo, registryConfig: { ...repo.registryConfig!, issueDiscoveryShare: 0.5 } },
      [
        ...issueSet,
        { repoFullName: repo.fullName, number: 24, title: "Duplicate", state: "closed", body: "", labels: ["duplicate"], linkedPrs: [] },
        { repoFullName: repo.fullName, number: 25, title: "Closed without solver", state: "closed", body: "", labels: [], linkedPrs: [] },
      ],
      prSet,
      repo.fullName,
    );
    expect(lifecycle.states.map((state) => [state.number, state.state])).toEqual(expect.arrayContaining([[23, "valid_solved"], [24, "duplicate"], [25, "closed_not_solved"]]));

    const selfSolvedLifecycle = buildIssueDiscoveryLifecycleReport(
      { ...repo, registryConfig: { ...repo.registryConfig!, issueDiscoveryShare: 0.5 } },
      [{ repoFullName: repo.fullName, number: 26, title: "Self solved", state: "closed", authorLogin: "selfdev", body: "I will fix this.", labels: [], linkedPrs: [46] }],
      [
        {
          repoFullName: repo.fullName,
          number: 46,
          title: "Fix self solved report",
          state: "merged",
          mergedAt: "2026-05-01T00:00:00.000Z",
          linkedIssues: [26],
          labels: ["bug"],
          authorLogin: "selfdev",
          body: "Fixes #26",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      ],
      repo.fullName,
    );
    expect(selfSolvedLifecycle.states[0]).toMatchObject({ number: 26, state: "solved", solvedByPullRequests: [46] });
    expect(selfSolvedLifecycle.states[0]?.reasons.join(" ")).toMatch(/not valid issue-discovery evidence/);

    const unverifiedMentionLifecycle = buildIssueDiscoveryLifecycleReport(
      { ...repo, registryConfig: { ...repo.registryConfig!, issueDiscoveryShare: 0.5 } },
      [{ repoFullName: repo.fullName, number: 26, title: "Mentioned PR", state: "closed", body: "Maybe PR #123 helps.", labels: [], linkedPrs: [123] }],
      [],
      repo.fullName,
    );
    expect(unverifiedMentionLifecycle.states[0]).toMatchObject({ number: 26, state: "closed_not_solved", solvedByPullRequests: [] });

    const collisions = buildCollisionReport(repo.fullName, issueSet, prSet);
    const forecast = buildBurdenForecast(repo, issueSet, prSet, collisions, 7);
    expect(forecast.horizonDays).toBe(7);
    expect(forecast.forecast.stalePullRequests).toBeGreaterThanOrEqual(1);

    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, prSet, issueSet);
    const fit = buildContributorFit(
      profile,
      [repo, { ...repo, fullName: "unknown/lane", isRegistered: false, registryConfig: null }],
      issueSet,
      prSet,
      [
        { repoFullName: repo.fullName, status: "success", sourceKind: "github", primaryLanguage: "TypeScript", openIssuesCount: 3, openPullRequestsCount: 1, recentMergedPullRequestsCount: 0, warnings: [] },
        { repoFullName: "unknown/lane", status: "skipped", sourceKind: "github", primaryLanguage: "Rust", openIssuesCount: 0, openPullRequestsCount: 10, recentMergedPullRequestsCount: 0, warnings: [] },
      ],
      [
        {
          login: "oktofeesh1",
          repoFullName: repo.fullName,
          pullRequests: 1,
          mergedPullRequests: 3,
          openPullRequests: 1,
          issues: 2,
          stalePullRequests: 0,
          unlinkedPullRequests: 0,
          dominantLabels: ["bug"],
        },
      ],
    );
    const scoringProfile = buildContributorScoringProfile({ login: "oktofeesh1", fit, scoringSnapshot: scoringSnapshot() });
    const strategy = buildContributorStrategy({ login: "oktofeesh1", fit, scoringProfile, scoringSnapshot: scoringSnapshot() });
    expect(scoringProfile.evidence.credibilityAssumption).toBeGreaterThanOrEqual(0.8);
    expect(strategy.nextActions).toContain("Start with the highest-fit repo that has low duplicate and queue pressure.");
    expect(JSON.stringify(strategy)).not.toMatch(/wallet|farming|reward/i);
  });

  it("builds role-aware maintainer lanes, outcome history, and review intelligence", () => {
    const awesomeRepo: RepositoryRecord = {
      ...repo,
      fullName: "JSONbored/awesome-claude",
      owner: "JSONbored",
      name: "awesome-claude",
      registryConfig: { ...repo.registryConfig!, repo: "jsonbored/awesome-claude", maintainerCut: 0 },
    };
    const sureRepo: RepositoryRecord = {
      ...repo,
      fullName: "we-promise/sure",
      owner: "we-promise",
      name: "sure",
      registryConfig: { ...repo.registryConfig!, repo: "we-promise/sure", emissionShare: 0.03 },
    };
    const profile = buildContributorProfile(
      "jsonbored",
      { login: "JSONbored", topLanguages: ["Ruby", "TypeScript"], source: "github" },
      [],
      [],
      [],
      {
        source: "gittensor_api",
        githubId: "49853598",
        githubUsername: "JSONbored",
        uid: 29,
        hotkey: "hotkey",
        isEligible: true,
        credibility: 1,
        eligibleRepoCount: 1,
        issueDiscoveryScore: 0,
        issueTokenScore: 0,
        issueCredibility: 1,
        isIssueEligible: false,
        issueEligibleRepoCount: 0,
        alphaPerDay: 0,
        taoPerDay: 0,
        usdPerDay: 0,
        totals: {
          pullRequests: 63,
          mergedPullRequests: 46,
          openPullRequests: 9,
          closedPullRequests: 8,
          openIssues: 44,
          closedIssues: 4,
          solvedIssues: 1,
          validSolvedIssues: 1,
        },
        repositories: [
          {
            repoFullName: "jsonbored/awesome-claude",
            pullRequests: 0,
            mergedPullRequests: 0,
            openPullRequests: 0,
            closedPullRequests: 0,
            openIssues: 42,
            closedIssues: 0,
            solvedIssues: 0,
            validSolvedIssues: 0,
            isEligible: false,
            isIssueEligible: false,
            credibility: 0,
            issueCredibility: 0,
            totalScore: 0,
            baseTotalScore: 0,
          },
          {
            repoFullName: "we-promise/sure",
            pullRequests: 47,
            mergedPullRequests: 37,
            openPullRequests: 6,
            closedPullRequests: 4,
            openIssues: 0,
            closedIssues: 0,
            solvedIssues: 1,
            validSolvedIssues: 1,
            isEligible: true,
            isIssueEligible: false,
            credibility: 0.902439,
            issueCredibility: 1,
            totalScore: 43,
            baseTotalScore: 681,
          },
        ],
        pullRequests: [],
        issueLabels: ["feature"],
      },
    );
    const repoStats: ContributorRepoStatRecord[] = [
      { login: "jsonbored", repoFullName: "we-promise/sure", pullRequests: 47, mergedPullRequests: 37, openPullRequests: 6, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["bug"] },
    ];
    const history = buildContributorOutcomeHistory({
      login: "jsonbored",
      profile,
      repositories: [awesomeRepo, sureRepo],
      pullRequests: [{ ...pullRequests[0]!, repoFullName: awesomeRepo.fullName, authorLogin: "jsonbored", authorAssociation: "OWNER" }],
      issues: [{ ...issues[0]!, repoFullName: awesomeRepo.fullName, authorLogin: "jsonbored", authorAssociation: "OWNER" }],
      repoStats,
    });
    const role = buildRoleContext({ login: "jsonbored", repo: awesomeRepo, repoFullName: awesomeRepo.fullName, pullRequests, issues, profile });
    const fit = buildContributorFit(profile, [awesomeRepo, sureRepo], issues, pullRequests, [], repoStats);
    const scoringProfile = buildContributorScoringProfile({ login: "jsonbored", fit, scoringSnapshot: scoringSnapshot() });
    const strategy = buildContributorStrategy({ login: "jsonbored", fit, scoringProfile, scoringSnapshot: scoringSnapshot(), outcomeHistory: history });
    const avoidStrategy = buildContributorStrategy({
      login: "jsonbored",
      fit,
      scoringProfile,
      scoringSnapshot: scoringSnapshot(),
      outcomeHistory: {
        ...history,
        repoOutcomes: [
          { repoFullName: "owner/closed", maintainerLane: false, closedPullRequestRate: 0.4, credibility: 1, openPullRequests: 0, strengths: [], risks: [] },
          { repoFullName: "owner/low", maintainerLane: false, closedPullRequestRate: 0.1, credibility: 0.5, openPullRequests: 0, strengths: [], risks: [] },
        ],
      } as any,
    });
    const recommendation = buildRepoFitRecommendation({ login: "jsonbored", repo: awesomeRepo, repoFullName: awesomeRepo.fullName, profile, outcomeHistory: history, issues, pullRequests });
    const intake = buildContributorIntakeHealth(awesomeRepo, issues, pullRequests, awesomeRepo.fullName);
    const lane = buildMaintainerLaneReport(awesomeRepo, issues, pullRequests, awesomeRepo.fullName);
    const cut = buildMaintainerCutReadiness(awesomeRepo, issues, pullRequests, awesomeRepo.fullName);
    const review = buildPullRequestReviewIntelligence({
      repo: awesomeRepo,
      pullRequest: { ...pullRequests[0]!, repoFullName: awesomeRepo.fullName, authorLogin: "jsonbored", authorAssociation: "OWNER" },
      issues,
      pullRequests,
      files: [],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: awesomeRepo.fullName,
      pullNumber: 10,
      profile,
      outcomeHistory: history,
    });

    expect(role).toMatchObject({ role: "owner", maintainerLane: true, normalContributorEvidenceAllowed: false });
    expect(history.repoOutcomes.filter((outcome) => outcome.repoFullName.toLowerCase() === "jsonbored/awesome-claude")).toHaveLength(1);
    expect(history.repoOutcomes.find((outcome) => outcome.repoFullName === "jsonbored/awesome-claude")).toMatchObject({ successLevel: "maintainer_context" });
    expect(history.reconciliation).toMatchObject({ officialAuthoritative: true, totals: { effective: { pullRequests: 63, mergedPullRequests: 46 } } });
    expect(history.reconciliation?.repos.find((entry) => entry.repoFullName.toLowerCase() === "jsonbored/awesome-claude")).toMatchObject({
      maintainerLane: true,
      discrepancyReasons: expect.arrayContaining([
        expect.stringContaining("Official PR total"),
        expect.stringContaining("Maintainer-owned repo history"),
      ]),
    });
    expect(buildContributorPatternReport(history, "failure").patterns.map((pattern) => pattern.title)).toContain("Raw issue activity is not solved discovery evidence");
    expect(strategy.maintainerLaneRepos).toEqual(expect.arrayContaining([expect.objectContaining({ repoFullName: "jsonbored/awesome-claude" })]));
    expect(avoidStrategy.avoidRepos).toEqual([
      expect.objectContaining({ repoFullName: "owner/closed", reason: "Closed PR rate is 40%." }),
      expect.objectContaining({ repoFullName: "owner/low", reason: "Official repo credibility is 0.5." }),
    ]);
    expect(recommendation.recommendation).toBe("maintainer_lane");
    expect(intake.level).toEqual(expect.stringMatching(/healthy|watch|strained|blocked/));
    expect(lane.summary).toContain("Maintainer lane");
    expect(cut.recommendedAction).toEqual(expect.stringMatching(/consider_small_cut|fix_config_first|leave_disabled|review_existing_cut/));
    expect(review.recommendation).toBe("maintainer_lane");
    expect(JSON.stringify({ strategy, review })).not.toMatch(/wallet|farming|reward/i);
  });

  it("labels GitHub-only contributor reconciliation as context", () => {
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, pullRequests, issues);
    const history = buildContributorOutcomeHistory({
      login: "oktofeesh1",
      profile,
      repositories: [repo],
      pullRequests,
      issues,
      repoStats: [{ login: "oktofeesh1", repoFullName: repo.fullName, pullRequests: 2, mergedPullRequests: 1, openPullRequests: 1, issues: 1, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["feature"], lastActivityAt: "2026-05-30T00:00:00.000Z" }],
    });

    expect(history.reconciliation).toMatchObject({ officialAuthoritative: false, source: "github_cache" });
    expect(history.reconciliation?.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "official_source_unavailable" })]));
    expect(history.reconciliation?.repos[0]?.discrepancyReasons).toEqual(expect.arrayContaining([expect.stringContaining("Official source unavailable")]));
  });

  it("derives cache-only totals consistently and login-scoped (pullRequests = merged + open + closed)", () => {
    const widgetRepo: RepositoryRecord = {
      fullName: "acme/widgets",
      owner: "acme",
      name: "widgets",
      isInstalled: true,
      isRegistered: true,
      isPrivate: false,
      defaultBranch: "main",
      registryConfig: { repo: "acme/widgets", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, trustedLabelPipeline: false, maintainerCut: 0, raw: {} },
    };
    const mk = (number: number, state: string, extra: Partial<PullRequestRecord> = {}): PullRequestRecord => ({
      repoFullName: "acme/widgets",
      number,
      title: `PR ${number}`,
      state,
      authorLogin: "dev",
      authorAssociation: "NONE",
      labels: [],
      linkedIssues: [],
      body: "",
      updatedAt: "2026-05-01T00:00:00.000Z",
      ...extra,
    });
    const prs = [mk(1, "merged", { mergedAt: "2026-05-01T00:00:00.000Z" }), mk(2, "open"), mk(3, "closed")];
    const profile = buildContributorProfile("dev", { login: "dev", topLanguages: ["TypeScript"], source: "github" }, prs, []);
    // repoStats includes a DIFFERENT login that must not leak into this contributor's totals.
    const repoStats: ContributorRepoStatRecord[] = [
      { login: "dev", repoFullName: "acme/widgets", pullRequests: 3, mergedPullRequests: 1, openPullRequests: 1, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: [] },
      { login: "stranger", repoFullName: "acme/tools", pullRequests: 5, mergedPullRequests: 0, openPullRequests: 5, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: [] },
    ];
    const history = buildContributorOutcomeHistory({ login: "dev", profile, repositories: [widgetRepo], pullRequests: prs, issues: [], repoStats });

    const t = history.totals;
    // Invariant, login-scoping, and bounded rate were all broken by the mixed-source fallbacks.
    expect(t.pullRequests).toBe(t.mergedPullRequests + t.openPullRequests + t.closedPullRequests);
    expect(t.issues).toBe(t.openIssues + t.closedIssues);
    expect(t.closedPullRequestRate).toBeLessThanOrEqual(1);
    expect(t.openPullRequests).toBe(1); // the stranger's 5 open PRs are excluded
  });

  it("uses aggregate repo-stat issues for cache-only outcome totals when issue rows are absent", () => {
    const docsRepo: RepositoryRecord = {
      fullName: "acme/docs",
      owner: "acme",
      name: "docs",
      isInstalled: true,
      isRegistered: true,
      isPrivate: false,
      defaultBranch: "main",
      registryConfig: { repo: "acme/docs", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, trustedLabelPipeline: false, maintainerCut: 0, raw: {} },
    };
    const repoStats: ContributorRepoStatRecord[] = [
      { login: "statdev", repoFullName: "acme/docs", pullRequests: 0, mergedPullRequests: 0, openPullRequests: 0, issues: 7, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["docs"] },
    ];
    const profile = buildContributorProfile("statdev", { login: "statdev", topLanguages: ["Markdown"], source: "github" }, [], [], repoStats);
    const history = buildContributorOutcomeHistory({ login: "statdev", profile, repositories: [docsRepo], pullRequests: [], issues: [], repoStats });

    expect(profile.registeredRepoActivity.issues).toBe(7);
    expect(history.repoOutcomes.find((entry) => entry.repoFullName === "acme/docs")).toMatchObject({ issues: 7, openIssues: 0, closedIssues: 7 });
    expect(history.totals).toMatchObject({ issues: 7, openIssues: 0, closedIssues: 7 });
    expect(history.reconciliation?.repos.find((entry) => entry.repoFullName === "acme/docs")?.cached).toMatchObject({ issues: 7, openIssues: 0, closedIssues: 7 });
  });

  it("derives solved and valid-solved issue-discovery counts from cache when official data is absent", () => {
    const mkRepo = (fullName: string, issueDiscoveryShare: number): RepositoryRecord => {
      const [owner, name] = fullName.split("/") as [string, string];
      return {
        fullName,
        owner,
        name,
        isInstalled: true,
        isRegistered: true,
        isPrivate: false,
        defaultBranch: "main",
        registryConfig: { repo: fullName, emissionShare: 0.02, issueDiscoveryShare, labelMultipliers: {}, trustedLabelPipeline: false, maintainerCut: 0, raw: {} },
      };
    };
    const mkIssue = (repoFullName: string, number: number, prNumber: number): IssueRecord => ({
      repoFullName,
      number,
      title: `Issue ${number}`,
      state: "closed",
      authorLogin: "cachedev",
      labels: [],
      linkedPrs: [prNumber],
      updatedAt: "2026-05-20T00:00:00.000Z",
    });
    const mkSolvingPr = (repoFullName: string, number: number, issueNumber: number): PullRequestRecord => ({
      repoFullName,
      number,
      title: `Fix #${issueNumber}`,
      state: "merged",
      mergedAt: "2026-05-21T00:00:00.000Z",
      authorLogin: "cachedev",
      authorAssociation: "NONE",
      labels: [],
      linkedIssues: [issueNumber],
      body: `Fixes #${issueNumber}`,
      updatedAt: "2026-05-21T00:00:00.000Z",
    });
    // acme/widgets is an issue-discovery lane, but self-solved loops only get solved credit; acme/tools is direct-PR (solved).
    const repositories = [mkRepo("acme/widgets", 1), mkRepo("acme/tools", 0)];
    const poisonedIssue: IssueRecord = {
      ...mkIssue("acme/widgets", 9, 102),
      state: "open",
      title: "Open self-linked report",
    };
    const poisonedPr: PullRequestRecord = {
      ...mkSolvingPr("acme/widgets", 102, 999),
      linkedIssues: [],
      body: "Previously merged work",
    };
    const allIssues = [mkIssue("acme/widgets", 7, 100), mkIssue("acme/tools", 8, 101), poisonedIssue];
    const prs = [mkSolvingPr("acme/widgets", 100, 7), mkSolvingPr("acme/tools", 101, 8), poisonedPr];
    const profile = buildContributorProfile("cachedev", { login: "cachedev", topLanguages: ["TypeScript"], source: "github" }, prs, allIssues);
    const history = buildContributorOutcomeHistory({ login: "cachedev", profile, repositories, pullRequests: prs, issues: allIssues, repoStats: [] });

    const discovery = history.repoOutcomes.find((entry) => entry.repoFullName === "acme/widgets");
    const direct = history.repoOutcomes.find((entry) => entry.repoFullName === "acme/tools");
    // Without the cache fallback these were hardcoded to 0 even though the contributor's own
    // merged PRs solved their issues. Open issues with only contributor-controlled issue-body
    // PR text must not inflate the cached solved evidence.
    expect(discovery).toMatchObject({ solvedIssues: 1, validSolvedIssues: 0, openIssues: 1 });
    expect(direct).toMatchObject({ solvedIssues: 1, validSolvedIssues: 0 });
    expect(history.totals.solvedIssues).toBe(2);
    expect(history.totals.validSolvedIssues).toBe(0);
    expect(history.reconciliation?.repos.find((entry) => entry.repoFullName === "acme/widgets")?.cached).toMatchObject({ solvedIssues: 1, validSolvedIssues: 0, openIssues: 1 });
    expect(discovery?.strengths.join(" ")).not.toMatch(/valid solved issue-discovery report/);
  });

  it("keeps cached reconciliation stats separate from official profile counts", () => {
    const profile = buildContributorProfile(
      "jsonbored",
      { login: "JSONbored", topLanguages: ["TypeScript"], source: "github" },
      [],
      [],
      [
        {
          login: "jsonbored",
          repoFullName: "JSONbored/awesome-claude",
          pullRequests: 10,
          mergedPullRequests: 8,
          openPullRequests: 1,
          issues: 5,
          stalePullRequests: 0,
          unlinkedPullRequests: 0,
          dominantLabels: ["feature"],
        },
      ],
      {
        source: "gittensor_api",
        githubId: "49853598",
        githubUsername: "JSONbored",
        isEligible: true,
        credibility: 1,
        eligibleRepoCount: 1,
        issueDiscoveryScore: 0,
        issueTokenScore: 0,
        issueCredibility: 1,
        isIssueEligible: true,
        issueEligibleRepoCount: 1,
        alphaPerDay: 0,
        taoPerDay: 0,
        usdPerDay: 0,
        totals: { pullRequests: 10, mergedPullRequests: 8, openPullRequests: 1, closedPullRequests: 1, openIssues: 3, closedIssues: 2, solvedIssues: 1, validSolvedIssues: 1 },
        repositories: [
          {
            repoFullName: "JSONbored/awesome-claude",
            pullRequests: 10,
            mergedPullRequests: 8,
            openPullRequests: 1,
            closedPullRequests: 1,
            openIssues: 3,
            closedIssues: 2,
            solvedIssues: 1,
            validSolvedIssues: 1,
            isEligible: true,
            isIssueEligible: true,
            credibility: 1,
            issueCredibility: 1,
            totalScore: 10,
            baseTotalScore: 10,
          },
        ],
        pullRequests: [],
        issueLabels: ["feature"],
      },
    );
    const officialStats: ContributorRepoStatRecord[] = [
      { login: "jsonbored", repoFullName: "JSONbored/awesome-claude", pullRequests: 10, mergedPullRequests: 8, openPullRequests: 1, issues: 5, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["feature"] },
    ];
    const cachedRepoStats: ContributorRepoStatRecord[] = [
      { login: "jsonbored", repoFullName: "jsonbored/Awesome-Claude", pullRequests: 2, mergedPullRequests: 1, openPullRequests: 1, issues: 4, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["bug"] },
      { login: "jsonbored", repoFullName: "entrius/gittensor", pullRequests: 1, mergedPullRequests: 0, openPullRequests: 1, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["bug"] },
    ];
    const history = buildContributorOutcomeHistory({
      login: "jsonbored",
      profile,
      repositories: [],
      pullRequests: [
        { ...pullRequests[0]!, repoFullName: "JSONbored/awesome-claude", number: 1, authorLogin: "jsonbored", state: "closed", mergedAt: "2026-05-01T00:00:00.000Z" },
        { ...pullRequests[0]!, repoFullName: "jsonbored/Awesome-Claude", number: 2, authorLogin: "jsonbored", state: "open", mergedAt: null },
        { ...pullRequests[0]!, repoFullName: "entrius/gittensor", number: 3, authorLogin: "jsonbored", state: "open", mergedAt: null },
      ],
      issues: [{ ...issues[0]!, repoFullName: "JSONbored/awesome-claude", number: 3, authorLogin: "jsonbored", authorAssociation: "OWNER", state: "open" }],
      repoStats: officialStats,
      cachedRepoStats,
    });

    const matchingRepos = history.reconciliation?.repos.filter((entry) => entry.repoFullName.toLowerCase() === "jsonbored/awesome-claude") ?? [];
    expect(matchingRepos).toHaveLength(1);
    expect(matchingRepos[0]).toMatchObject({
      maintainerLane: true,
      official: { pullRequests: 10, mergedPullRequests: 8, openPullRequests: 1, closedPullRequests: 1, issues: 5, openIssues: 3, closedIssues: 2, solvedIssues: 1, validSolvedIssues: 1 },
      cached: { pullRequests: 2, mergedPullRequests: 1, openPullRequests: 1, closedPullRequests: 0, issues: 4, openIssues: 1, closedIssues: 3 },
    });
    expect(matchingRepos[0]?.discrepancyReasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Official PR total"),
        expect.stringContaining("Official merged PR total"),
        expect.stringContaining("Official issue total"),
        expect.stringContaining("Official open issue count"),
        expect.stringContaining("Official valid-solved issue count"),
        expect.stringContaining("Maintainer-owned repo history"),
      ]),
    );
    expect(history.reconciliation?.totals.cached).toMatchObject({ pullRequests: 3, mergedPullRequests: 1, openPullRequests: 2, closedPullRequests: 0, issues: 4, openIssues: 1, closedIssues: 3 });
    expect(history.reconciliation?.repos.find((entry) => entry.repoFullName === "entrius/gittensor")).toMatchObject({
      official: undefined,
      cached: { pullRequests: 1, openPullRequests: 1 },
      effective: { pullRequests: 0, openPullRequests: 0 },
      discrepancyReasons: expect.arrayContaining([expect.stringContaining("Official source omits this repo")]),
    });
  });

  it("uses cached issue associations for reconciliation maintainer lanes", () => {
    const issueOnly: IssueRecord = { repoFullName: "entrius/allways", number: 88, title: "Maintainer filed issue", state: "open", authorLogin: "memberdev", authorAssociation: "MEMBER", labels: ["bug"], linkedPrs: [] };
    const profile = buildContributorProfile("memberdev", { login: "memberdev", topLanguages: ["TypeScript"], source: "github" }, [], [issueOnly]);
    const history = buildContributorOutcomeHistory({ login: "memberdev", profile, repositories: [], pullRequests: [], issues: [issueOnly], repoStats: [] });

    expect(history.reconciliation?.repos[0]).toMatchObject({
      repoFullName: "entrius/allways",
      maintainerLane: true,
      discrepancyReasons: expect.arrayContaining([expect.stringContaining("Maintainer-owned repo history")]),
    });
  });

  it("classifies role context from GitHub associations, official activity, cache activity, and unknown state", () => {
    const memberPr: PullRequestRecord = {
      ...pullRequests[0]!,
      repoFullName: "org/project",
      authorLogin: "dev",
      authorAssociation: "MEMBER",
    };
    const collaboratorIssue: IssueRecord = {
      ...issues[0]!,
      repoFullName: "org/project",
      authorLogin: "helper",
      authorAssociation: "COLLABORATOR",
    };
    const officialProfile = buildContributorProfile(
      "officialdev",
      { login: "officialdev", topLanguages: [], source: "github" },
      [],
      [],
      [],
      {
        source: "gittensor_api",
        githubId: "1",
        githubUsername: "officialdev",
        uid: 1,
        hotkey: undefined,
        isEligible: false,
        credibility: 0,
        eligibleRepoCount: 0,
        issueDiscoveryScore: 0,
        issueTokenScore: 0,
        issueCredibility: 0,
        isIssueEligible: false,
        issueEligibleRepoCount: 0,
        alphaPerDay: 0,
        taoPerDay: 0,
        usdPerDay: 0,
        totals: {
          pullRequests: 1,
          mergedPullRequests: 0,
          openPullRequests: 1,
          closedPullRequests: 0,
          openIssues: 0,
          closedIssues: 0,
          solvedIssues: 0,
          validSolvedIssues: 0,
        },
        repositories: [
          {
            repoFullName: "org/project",
            pullRequests: 1,
            mergedPullRequests: 0,
            openPullRequests: 1,
            closedPullRequests: 0,
            openIssues: 0,
            closedIssues: 0,
            solvedIssues: 0,
            validSolvedIssues: 0,
            isEligible: false,
            isIssueEligible: false,
            credibility: 0,
            issueCredibility: 0,
            totalScore: 0,
            baseTotalScore: 0,
          },
        ],
        pullRequests: [],
        issueLabels: [],
      },
    );
    const cachedProfile = buildContributorProfile("cacheddev", { login: "cacheddev", topLanguages: [], source: "github" }, [{ ...memberPr, authorLogin: "cacheddev", authorAssociation: "NONE" }], []);

    expect(buildRoleContext({ login: "dev", repo: null, repoFullName: "org/project", pullRequests: [memberPr], issues: [] })).toMatchObject({
      role: "org_member",
      maintainerLane: true,
      source: "github_association",
      association: "MEMBER",
    });
    expect(buildRoleContext({ login: "helper", repo: null, repoFullName: "org/project", pullRequests: [], issues: [collaboratorIssue] })).toMatchObject({
      role: "collaborator",
      maintainerLane: true,
      source: "github_association",
      association: "COLLABORATOR",
    });
    expect(buildRoleContext({ login: "officialdev", repo: null, repoFullName: "org/project", profile: officialProfile })).toMatchObject({
      role: "outside_contributor",
      maintainerLane: false,
      source: "gittensor_api",
    });
    expect(buildRoleContext({ login: "cacheddev", repo: null, repoFullName: "org/project", pullRequests: [{ ...memberPr, authorLogin: "cacheddev", authorAssociation: "NONE" }], issues: [], profile: cachedProfile })).toMatchObject({
      role: "outside_contributor",
      source: "cache",
    });
    expect(buildRoleContext({ login: "newdev", repo: null, repoFullName: "org/project", pullRequests: [], issues: [] })).toMatchObject({
      role: "unknown",
      source: "unknown",
      normalContributorEvidenceAllowed: true,
    });
    // Maintainer association must survive a repoFullName casing mismatch between the
    // canonical name (e.g. the official source's "Org/Project") and the cached PR's
    // "org/project". Case-sensitive matching here would drop the association and
    // wrongly mark the maintainer's repo as outside-contributor evidence.
    expect(buildRoleContext({ login: "dev", repo: null, repoFullName: "Org/Project", pullRequests: [memberPr], issues: [] })).toMatchObject({
      role: "org_member",
      maintainerLane: true,
      source: "github_association",
      association: "MEMBER",
    });
  });

  it("branches repo fit recommendations across pursue, avoid, cleanup, unknown, and maintainer lanes", () => {
    const cleanRepo: RepositoryRecord = {
      ...repo,
      fullName: "org/clean",
      owner: "org",
      name: "clean",
      registryConfig: { ...repo.registryConfig!, repo: "org/clean", labelMultipliers: {} },
    };
    const profile = buildContributorProfile("dev", { login: "dev", topLanguages: ["TypeScript"], source: "github" }, [], []);
    const noHistory = buildContributorOutcomeHistory({ login: "dev", profile, repositories: [cleanRepo], pullRequests: [], issues: [], repoStats: [] });
    const riskyProfile = buildContributorProfile(
      "riskdev",
      { login: "riskdev", topLanguages: ["TypeScript"], source: "github" },
      [],
      [],
      [],
      {
        source: "gittensor_api",
        githubId: "2",
        githubUsername: "riskdev",
        uid: 2,
        hotkey: undefined,
        isEligible: false,
        credibility: 0.7,
        eligibleRepoCount: 0,
        issueDiscoveryScore: 0,
        issueTokenScore: 0,
        issueCredibility: 0,
        isIssueEligible: false,
        issueEligibleRepoCount: 0,
        alphaPerDay: 0,
        taoPerDay: 0,
        usdPerDay: 0,
        totals: {
          pullRequests: 10,
          mergedPullRequests: 2,
          openPullRequests: 5,
          closedPullRequests: 3,
          openIssues: 0,
          closedIssues: 0,
          solvedIssues: 0,
          validSolvedIssues: 0,
        },
        repositories: [
          {
            repoFullName: "org/clean",
            pullRequests: 10,
            mergedPullRequests: 2,
            openPullRequests: 5,
            closedPullRequests: 3,
            openIssues: 0,
            closedIssues: 0,
            solvedIssues: 0,
            validSolvedIssues: 0,
            isEligible: false,
            isIssueEligible: false,
            credibility: 0.7,
            issueCredibility: 0,
            totalScore: 0,
            baseTotalScore: 0,
          },
        ],
        pullRequests: [],
        issueLabels: [],
      },
    );
    const cleanupHistory = buildContributorOutcomeHistory({ login: "riskdev", profile: riskyProfile, repositories: [cleanRepo], pullRequests: [], issues: [], repoStats: [] });
    const collisionIssue: IssueRecord = { ...issues[0]!, repoFullName: cleanRepo.fullName, number: 42, title: "Improve sync reliability", linkedPrs: [] };
    const collidingPrs: PullRequestRecord[] = [
      { ...pullRequests[0]!, repoFullName: cleanRepo.fullName, number: 1, title: "Improve sync reliability", authorLogin: "other-a", authorAssociation: "NONE", linkedIssues: [42] },
      { ...pullRequests[1]!, repoFullName: cleanRepo.fullName, number: 2, title: "Improve sync reliability alternative", authorLogin: "other-b", authorAssociation: "NONE", linkedIssues: [42] },
    ];
    const ownerProfile = buildContributorProfile("org", { login: "org", topLanguages: [], source: "github" }, [], []);

    expect(buildRepoFitRecommendation({ login: "dev", repo: cleanRepo, repoFullName: cleanRepo.fullName, profile, outcomeHistory: noHistory, issues: [], pullRequests: [] }).recommendation).toBe("pursue");
    expect(buildRepoFitRecommendation({ login: "dev", repo: cleanRepo, repoFullName: cleanRepo.fullName, profile, outcomeHistory: noHistory, issues: [collisionIssue], pullRequests: collidingPrs }).recommendation).toBe("avoid_for_now");
    expect(buildRepoFitRecommendation({ login: "riskdev", repo: cleanRepo, repoFullName: cleanRepo.fullName, profile: riskyProfile, outcomeHistory: cleanupHistory, issues: [], pullRequests: [] }).recommendation).toBe("cleanup_first");
    expect(buildRepoFitRecommendation({ login: "dev", repo: null, repoFullName: "missing/repo", profile, outcomeHistory: noHistory, issues: [], pullRequests: [] }).recommendation).toBe("unknown");
    expect(buildRepoFitRecommendation({ login: "org", repo: cleanRepo, repoFullName: cleanRepo.fullName, profile: ownerProfile, outcomeHistory: noHistory, issues: [], pullRequests: [] }).recommendation).toBe("maintainer_lane");
  });

  it("covers maintainer-cut readiness and contributor outcome pressure branches", () => {
    const cleanRepo: RepositoryRecord = {
      ...repo,
      fullName: "org/ready",
      owner: "org",
      name: "ready",
      registryConfig: { ...repo.registryConfig!, repo: "org/ready", labelMultipliers: {}, maintainerCut: 0 },
    };
    const paidRepo: RepositoryRecord = {
      ...cleanRepo,
      registryConfig: { ...cleanRepo.registryConfig!, maintainerCut: 0.05 },
    };
    const fragileRepo: RepositoryRecord = {
      ...cleanRepo,
      registryConfig: { ...cleanRepo.registryConfig!, emissionShare: 0, labelMultipliers: { missing: 0.2, absent: 0.1, stale: 0.1, unused: 0.1 } },
    };
    const riskProfile = buildContributorProfile(
      "riskdev",
      { login: "riskdev", topLanguages: [], source: "github" },
      [],
      [],
      [],
      {
        source: "gittensor_api",
        githubId: "3",
        githubUsername: "riskdev",
        uid: 3,
        hotkey: undefined,
        isEligible: false,
        credibility: 0.6,
        eligibleRepoCount: 0,
        issueDiscoveryScore: 0,
        issueTokenScore: 0,
        issueCredibility: 0,
        isIssueEligible: false,
        issueEligibleRepoCount: 0,
        alphaPerDay: 0,
        taoPerDay: 0,
        usdPerDay: 0,
        totals: {
          pullRequests: 10,
          mergedPullRequests: 3,
          openPullRequests: 3,
          closedPullRequests: 4,
          openIssues: 0,
          closedIssues: 0,
          solvedIssues: 0,
          validSolvedIssues: 0,
        },
        repositories: [
          {
            repoFullName: cleanRepo.fullName,
            pullRequests: 10,
            mergedPullRequests: 3,
            openPullRequests: 3,
            closedPullRequests: 4,
            openIssues: 0,
            closedIssues: 0,
            solvedIssues: 0,
            validSolvedIssues: 0,
            isEligible: false,
            isIssueEligible: false,
            credibility: 0.6,
            issueCredibility: 0,
            totalScore: 0,
            baseTotalScore: 0,
          },
        ],
        pullRequests: [],
        issueLabels: [],
      },
    );
    const history = buildContributorOutcomeHistory({ login: "riskdev", profile: riskProfile, repositories: [cleanRepo], pullRequests: [], issues: [], repoStats: [] });
    const failureTitles = buildContributorPatternReport(history, "failure").patterns.map((pattern) => pattern.title);

    expect(buildMaintainerCutReadiness(null, [], [], "missing/repo")).toMatchObject({ ready: false, recommendedAction: "leave_disabled" });
    expect(buildMaintainerCutReadiness(paidRepo, [], [], paidRepo.fullName)).toMatchObject({ maintainerCut: 0.05, recommendedAction: "review_existing_cut" });
    expect(buildMaintainerCutReadiness(fragileRepo, [], [], fragileRepo.fullName)).toMatchObject({ ready: false, recommendedAction: "fix_config_first" });
    expect(buildMaintainerCutReadiness(cleanRepo, [], [], cleanRepo.fullName)).toMatchObject({ ready: true, recommendedAction: "consider_small_cut" });
    expect(failureTitles).toEqual(expect.arrayContaining(["Closed PR credibility pressure", "Repo-specific closed PR risk", "Repo-specific open PR pressure"]));
  });

  it("builds private reward/risk strategy with cleanup leverage, lane blockers, and maintainer-lane actions", () => {
    const directRepo: RepositoryRecord = {
      ...repo,
      fullName: "we-promise/sure",
      owner: "we-promise",
      name: "sure",
      registryConfig: { ...repo.registryConfig!, repo: "we-promise/sure", emissionShare: 0.03, issueDiscoveryShare: 0, labelMultipliers: {} },
    };
    const issueOnlyRepo: RepositoryRecord = {
      ...repo,
      fullName: "entrius/allways",
      owner: "entrius",
      name: "allways",
      registryConfig: { ...repo.registryConfig!, repo: "entrius/allways", emissionShare: 0.05, issueDiscoveryShare: 1, labelMultipliers: { bug: 1.25 } },
    };
    const splitRepo: RepositoryRecord = {
      ...repo,
      fullName: "entrius/das-github-mirror",
      owner: "entrius",
      name: "das-github-mirror",
      registryConfig: { ...repo.registryConfig!, repo: "entrius/das-github-mirror", emissionShare: 0.02, issueDiscoveryShare: 0.35, labelMultipliers: { bug: 1.1 } },
    };
    const inactiveRepo: RepositoryRecord = {
      ...repo,
      fullName: "owner/inactive",
      owner: "owner",
      name: "inactive",
      registryConfig: { ...repo.registryConfig!, repo: "owner/inactive", emissionShare: 0, issueDiscoveryShare: 0, labelMultipliers: {} },
    };
    const maintainerRepo: RepositoryRecord = {
      ...repo,
      fullName: "JSONbored/awesome-claude",
      owner: "JSONbored",
      name: "awesome-claude",
      registryConfig: { ...repo.registryConfig!, repo: "JSONbored/awesome-claude", emissionShare: 0.01, issueDiscoveryShare: 0 },
    };
    const unregisteredProject: RepositoryRecord = {
      ...repo,
      fullName: "JSONbored/gittensory",
      owner: "JSONbored",
      name: "gittensory",
      isRegistered: false,
      registryConfig: null,
    };
    const profile = buildContributorProfile(
      "jsonbored",
      { login: "jsonbored", topLanguages: ["Ruby", "TypeScript"], source: "github" },
      [],
      [],
      [],
      {
        source: "gittensor_api",
        githubId: "49853598",
        githubUsername: "jsonbored",
        uid: 29,
        hotkey: undefined,
        isEligible: true,
        credibility: 1,
        eligibleRepoCount: 1,
        issueDiscoveryScore: 0,
        issueTokenScore: 0,
        issueCredibility: 1,
        isIssueEligible: false,
        issueEligibleRepoCount: 0,
        alphaPerDay: 0,
        taoPerDay: 0,
        usdPerDay: 0,
        totals: {
          pullRequests: 12,
          mergedPullRequests: 5,
          openPullRequests: 7,
          closedPullRequests: 0,
          openIssues: 0,
          closedIssues: 0,
          solvedIssues: 0,
          validSolvedIssues: 0,
        },
        repositories: [
          {
            repoFullName: "we-promise/sure",
            pullRequests: 9,
            mergedPullRequests: 5,
            openPullRequests: 7,
            closedPullRequests: 0,
            openIssues: 0,
            closedIssues: 0,
            solvedIssues: 0,
            validSolvedIssues: 0,
            isEligible: true,
            isIssueEligible: false,
            credibility: 1,
            issueCredibility: 1,
            totalScore: 0,
            baseTotalScore: 0,
          },
        ],
        pullRequests: [],
        issueLabels: [],
      },
    );
    const history = buildContributorOutcomeHistory({
      login: "jsonbored",
      profile,
      repositories: [directRepo, issueOnlyRepo, maintainerRepo, unregisteredProject],
      pullRequests: [{ ...pullRequests[0]!, repoFullName: maintainerRepo.fullName, authorLogin: "jsonbored", authorAssociation: "OWNER" }],
      issues: [],
      repoStats: [],
    });
    const fit = buildContributorFit(profile, [directRepo, issueOnlyRepo, maintainerRepo, unregisteredProject], issues, pullRequests, [], []);
    const scoringProfile = buildContributorScoringProfile({ login: "jsonbored", fit, scoringSnapshot: scoringSnapshot() });
    const direct = buildRepoRewardRisk({
      login: "jsonbored",
      repo: directRepo,
      repoFullName: directRepo.fullName,
      profile,
      outcomeHistory: history,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues,
      pullRequests,
    });
    const issueOnly = buildRepoRewardRisk({
      login: "jsonbored",
      repo: issueOnlyRepo,
      repoFullName: issueOnlyRepo.fullName,
      profile,
      outcomeHistory: history,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues,
      pullRequests: [],
    });
    const split = buildRepoRewardRisk({
      login: "jsonbored",
      repo: splitRepo,
      repoFullName: splitRepo.fullName,
      profile,
      outcomeHistory: history,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: [],
    });
    const inactive = buildRepoRewardRisk({
      login: "jsonbored",
      repo: inactiveRepo,
      repoFullName: inactiveRepo.fullName,
      profile,
      outcomeHistory: history,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: [],
    });
    const maintainer = buildRepoRewardRisk({
      login: "jsonbored",
      repo: maintainerRepo,
      repoFullName: maintainerRepo.fullName,
      profile,
      outcomeHistory: history,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: [{ ...pullRequests[0]!, repoFullName: maintainerRepo.fullName, authorLogin: "jsonbored", authorAssociation: "OWNER" }],
    });
    const strategy = buildContributorRewardRiskStrategy({
      login: "jsonbored",
      fit,
      scoringProfile,
      scoringSnapshot: scoringSnapshot(),
      outcomeHistory: history,
      repositories: [directRepo, issueOnlyRepo, maintainerRepo, unregisteredProject],
      allIssues: issues,
      allPullRequests: pullRequests,
      recentMergedPullRequests,
    });

    expect(direct.currentPreview.scoreEstimate.openPrMultiplier).toBe(0);
    expect(direct.afterCleanupPreview.scoreEstimate.openPrMultiplier).toBe(1);
    expect(direct.scoreBlockers).toContain("Open PR count exceeds the current threshold assumption.");
    expect(direct.actions[0]?.actionKind).toBe("cleanup_existing_prs");
    expect(issueOnly.rewardUpside.relevantLane).toBe("issue_discovery");
    expect(issueOnly.scoreBlockers).toContain("Direct PR-side lane value is disabled for this repo.");
    expect(issueOnly.actions.map((action) => action.actionKind)).toContain("file_issue_discovery");
    expect(split.lane.lane).toBe("split");
    expect(split.rewardUpside.relevantLane).toBe("direct_pr");
    expect(split.actions.map((action) => action.actionKind)).toEqual(expect.arrayContaining(["open_new_direct_pr", "file_issue_discovery"]));
    expect(inactive.rewardUpside.relevantLane).toBe("none");
    expect(inactive.scoreBlockers).toContain("Repository allocation is inactive.");
    expect(maintainer.roleContext.maintainerLane).toBe(true);
    expect(maintainer.actions.map((action) => action.actionKind)).toEqual(expect.arrayContaining(["maintainer_lane_improve_repo", "maintainer_cut_readiness"]));
    expect(strategy.repoAnalyses.map((analysis) => analysis.repoFullName)).not.toContain("JSONbored/gittensory");
    expect(strategy.topActions[0]?.actionKind).toBe("cleanup_existing_prs");
    expect(JSON.stringify(strategy)).not.toMatch(/wallet|hotkey|guaranteed payout|farming/i);
  });

  it("builds maintainer noise and PR reviewability without public shaming fields", () => {
    const noise = buildMaintainerNoiseReport(repo, issues, pullRequests, recentMergedPullRequests, repo.fullName);
    const reviewability = buildPullRequestReviewability({
      repo,
      pullRequest: { ...pullRequests[0]!, linkedIssues: [] },
      issues,
      pullRequests,
      files: [{ repoFullName: repo.fullName, pullNumber: 10, path: "src/github/webhook.ts", additions: 200, deletions: 20, changes: 220, payload: {} }],
      reviews: [{ id: "changes", repoFullName: repo.fullName, pullNumber: 10, state: "CHANGES_REQUESTED", payload: {} }],
      checks: [{ id: "failed", repoFullName: repo.fullName, pullNumber: 10, name: "test", status: "completed", conclusion: "failure", payload: {} }],
      recentMergedPullRequests,
      repoFullName: repo.fullName,
      pullNumber: 10,
    });

    expect(noise.noiseSources.length).toBeGreaterThan(0);
    expect(noise.maintainerActions).toEqual(expect.arrayContaining(["likely_duplicate"]));
    expect(reviewability.action).toEqual(expect.stringMatching(/needs_author|likely_duplicate|watch/));
    expect(reviewability.noiseSources).toEqual(expect.arrayContaining(["Missing linked issue or no-issue rationale.", "Code changes do not include cached test files."]));
    expect(JSON.stringify({ noise, reviewability })).not.toMatch(/wallet|hotkey|raw trust score|ranking/i);
  });

  it("branches PR reviewability maintainer actions for clean, closed, maintainer, and watch cases", () => {
    const cleanPr = { ...pullRequests[0]!, linkedIssues: [1], authorAssociation: "NONE" };
    const clean = buildPullRequestReviewability({
      repo,
      pullRequest: cleanPr,
      issues: [],
      pullRequests: [cleanPr],
      files: [
        { repoFullName: repo.fullName, pullNumber: 10, path: "src/github/webhook.ts", additions: 20, deletions: 2, changes: 22, payload: {} },
        { repoFullName: repo.fullName, pullNumber: 10, path: "test/unit/webhook.test.ts", additions: 25, deletions: 0, changes: 25, payload: {} },
      ],
      reviews: [{ id: "approved", repoFullName: repo.fullName, pullNumber: 10, state: "APPROVED", payload: {} }],
      checks: [{ id: "ok", repoFullName: repo.fullName, pullNumber: 10, name: "test", status: "completed", conclusion: "success", payload: {} }],
      recentMergedPullRequests: [],
      repoFullName: repo.fullName,
      pullNumber: 10,
    });
    const closed = buildPullRequestReviewability({
      repo,
      pullRequest: { ...cleanPr, state: "closed" },
      issues: [],
      pullRequests: [{ ...cleanPr, state: "closed" }],
      files: [],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: repo.fullName,
      pullNumber: 10,
    });
    const maintainer = buildPullRequestReviewability({
      repo,
      pullRequest: { ...cleanPr, authorAssociation: "OWNER" },
      issues: [],
      pullRequests: [{ ...cleanPr, authorAssociation: "OWNER" }],
      files: [],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: repo.fullName,
      pullNumber: 10,
    });
    const watch = buildPullRequestReviewability({
      repo,
      pullRequest: { ...cleanPr, linkedIssues: [] },
      issues: [],
      pullRequests: [{ ...cleanPr, linkedIssues: [] }],
      files: [{ repoFullName: repo.fullName, pullNumber: 10, path: "src/large.ts", additions: 900, deletions: 0, changes: 900, payload: {} }],
      reviews: [],
      checks: [{ id: "failed", repoFullName: repo.fullName, pullNumber: 10, name: "test", status: "completed", conclusion: "failure", payload: {} }],
      recentMergedPullRequests: [],
      repoFullName: repo.fullName,
      pullNumber: 10,
    });

    expect(clean.action).toBe("review_now");
    expect(closed.action).toBe("close_or_redirect");
    expect(maintainer.action).toBe("maintainer_lane");
    expect(watch.action).toBe("watch");
    expect(clean.maintainerNextSteps[0]).toContain("Review");
    expect(closed.maintainerNextSteps[0]).toContain("Redirect");
    expect(maintainer.maintainerNextSteps[0]).toContain("stewardship");
    expect(watch.maintainerNextSteps[0]).toContain("Watch");
  });

  it("covers defensive signal branches for empty text, unmatched languages, active bounties, and public comment fallbacks", () => {
    const emptyCollision = buildCollisionReport(
      repo.fullName,
      [
        { repoFullName: repo.fullName, number: 1, title: "", state: "open", labels: [], linkedPrs: [], body: "" },
        { repoFullName: repo.fullName, number: 2, title: "ab", state: "open", labels: [], linkedPrs: [], body: "" },
      ],
      [],
    );
    expect(emptyCollision.summary.clusterCount).toBe(0);

    const noLanguageProfile = buildContributorProfile("newdev", { login: "newdev", topLanguages: ["Rust"], source: "github" }, [], []);
    const noLanguageFit = buildContributorFit(
      noLanguageProfile,
      [repo],
      [],
      [],
      [{ repoFullName: repo.fullName, status: "success", sourceKind: "github", primaryLanguage: "TypeScript", openIssuesCount: 0, openPullRequestsCount: 0, recentMergedPullRequestsCount: 0, warnings: [] }],
      [],
    );
    expect(noLanguageFit.findings.map((finding) => finding.code)).toContain("no_language_fit");

    const activeBounty = buildBountyAdvisory(
      { id: "bounty-active", repoFullName: repo.fullName, issueNumber: 1, status: "Active", payload: { bounty_alpha: "1.0000" } },
      repo,
      { repoFullName: repo.fullName, number: 1, title: "Funded", state: "open", labels: [], linkedPrs: [1, 2] },
    );
    expect(activeBounty).toMatchObject({ lifecycle: "active", fundingStatus: "funded", consensusRisk: "medium" });

    const comment = buildPublicPrIntelligenceComment({
      repo,
      pr: { ...pullRequests[0]!, authorLogin: undefined, linkedIssues: [] },
      profile: noLanguageProfile,
      detection: { detected: true, source: "github_cache" as const, reason: "cached", priorPullRequests: 0, priorMergedPullRequests: 0, priorIssues: 0 },
      queueHealth: buildQueueHealth(repo, [], [], buildCollisionReport(repo.fullName, [], [])),
      collisions: buildCollisionReport(repo.fullName, [], []),
      preflight: buildPreflightResult({ repoFullName: repo.fullName, title: "Docs", body: "No linked issue", changedFiles: ["README.md"], tests: ["manual"] }, repo, [], []),
      settings: {
        repoFullName: repo.fullName,
        commentMode: "detected_contributors_only",
        publicAudienceMode: "oss_maintainer",
        publicSignalLevel: "standard",
        checkRunMode: "off",
        checkRunDetailLevel: "minimal",
        gateCheckMode: "off",
        gatePack: "gittensor",
        linkedIssueGateMode: "advisory",
        duplicatePrGateMode: "advisory",
        qualityGateMode: "advisory",
        qualityGateMinScore: null,
        autoLabelEnabled: true,
        gittensorLabel: "gittensor",
        createMissingLabel: true,
        publicSurface: "comment_and_label",
        includeMaintainerAuthors: false,
        requireLinkedIssue: false,
        backfillEnabled: true,
        privateTrustEnabled: true,
        aiReviewMode: "off",
        aiReviewByok: false,
      },
    });
    expect(comment).toContain("Author: `unknown`");
    expect(comment).toContain("Public profile only");
    expect(comment).not.toMatch(/wallet|raw trust score|ranking/i);
  });
});

function snapshot(
  id: string,
  repositories: Array<{
    repo: string;
    emissionShare: number;
    issueDiscoveryShare: number;
    labelMultipliers: Record<string, number>;
    fixedBaseScore?: number | null;
    defaultLabelMultiplier?: number | null;
    eligibilityMode?: string | null;
  }>,
): RegistrySnapshot {
  return {
    id,
    generatedAt: "2026-05-23T00:00:00.000Z",
    fetchedAt: "2026-05-23T00:00:00.000Z",
    source: { kind: "raw-github", url: "https://example.test" },
    repoCount: repositories.length,
    totalEmissionShare: repositories.reduce((sum, repo) => sum + repo.emissionShare, 0),
    warnings: [],
    repositories: repositories.map((repo) => ({
      ...repo,
      trustedLabelPipeline: false,
      maintainerCut: 0,
      raw: {},
    })),
  };
}

function scoringSnapshot(): ScoringModelSnapshotRecord {
  return {
    id: "scoring-fixture",
    sourceKind: "test",
    sourceUrl: "fixture://scoring",
    fetchedAt: "2026-05-23T00:00:00.000Z",
    activeModel: "current_density_model",
    constants: {},
    programmingLanguages: {},
    warnings: [],
    payload: {},
  };
}
