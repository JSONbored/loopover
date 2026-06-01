import { describe, expect, it } from "vitest";
import {
  buildBountyAdvisory,
  buildBurdenForecast,
  buildCollisionReport,
  buildConfigQuality,
  buildContributorOpportunities,
  buildContributorFit,
  buildContributorIntakeHealth,
  buildContributorOutcomeHistory,
  buildContributorProfile,
  buildContributorScoringProfile,
  buildContributorStrategy,
  buildIssueDiscoveryLifecycleReport,
  buildIssueQualityReport,
  buildLabelAudit,
  buildLaneAdvice,
  buildLocalDiffPreflightResult,
  buildMaintainerCutReadiness,
  buildMaintainerLaneReport,
  buildPreflightResult,
  buildPullRequestMaintainerPacket,
  buildPullRequestReviewIntelligence,
  buildPublicPrIntelligenceComment,
  buildQueueHealth,
  buildRegistryChangeReport,
  buildRepoFitRecommendation,
  detectGittensorContributor,
  shouldPublishPrIntelligenceComment,
} from "../../src/signals/engine";
import type {
  BountyRecord,
  CheckSummaryRecord,
  ContributorRepoStatRecord,
  IssueRecord,
  PullRequestFileRecord,
  PullRequestRecord,
  PullRequestReviewRecord,
  RecentMergedPullRequestRecord,
  RegistrySnapshot,
  RepositoryRecord,
  RepositorySettings,
  ScoringModelSnapshotRecord,
} from "../../src/types";

const repo: RepositoryRecord = {
  fullName: "entrius/allways-ui",
  owner: "entrius",
  name: "allways-ui",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "entrius/allways-ui",
    emissionShare: 0.01107,
    issueDiscoveryShare: 0,
    labelMultipliers: { bug: 1.1, enhancement: 1, feature: 1.25, refactor: 0.5 },
    trustedLabelPipeline: true,
    maintainerCut: 0,
    raw: {},
  },
};

const issues: IssueRecord[] = [
  {
    repoFullName: repo.fullName,
    number: 7,
    title: "Dashboard cache refresh fails after reconnect",
    state: "open",
    authorLogin: "reporter",
    labels: ["bug"],
    linkedPrs: [],
  },
  {
    repoFullName: repo.fullName,
    number: 8,
    title: "Add reconnect regression coverage",
    state: "open",
    authorLogin: "reporter",
    labels: ["feature"],
    linkedPrs: [],
  },
];

const pullRequests: PullRequestRecord[] = [
  {
    repoFullName: repo.fullName,
    number: 12,
    title: "Fix dashboard cache refresh after reconnect",
    state: "open",
    authorLogin: "oktofeesh1",
    authorAssociation: "NONE",
    labels: ["bug"],
    linkedIssues: [7],
    updatedAt: "2026-04-01T00:00:00.000Z",
  },
  {
    repoFullName: repo.fullName,
    number: 13,
    title: "Alternative cache reconnect fix",
    state: "open",
    authorLogin: "other",
    authorAssociation: "NONE",
    labels: ["bug"],
    linkedIssues: [7],
  },
];

describe("world-class backend signals", () => {
  it("classifies direct PR lanes from registry configuration", () => {
    const lane = buildLaneAdvice(repo, repo.fullName);
    expect(lane.lane).toBe("direct_pr");
    expect(lane.contributorGuidance).toMatch(/focused PRs/i);
  });

  it("detects duplicate and WIP collision clusters", () => {
    const report = buildCollisionReport(repo.fullName, issues, pullRequests);
    expect(report.summary.highRiskCount).toBeGreaterThan(0);
    expect(report.clusters[0]?.items.map((item) => item.number)).toContain(7);
  });

  it("builds maintainer burden from queue hygiene signals", () => {
    const collisions = buildCollisionReport(repo.fullName, issues, pullRequests);
    const health = buildQueueHealth(repo, issues, pullRequests, collisions);
    expect(health.signals.openPullRequests).toBe(2);
    expect(health.findings.map((finding) => finding.code)).toContain("collision_clusters");
  });

  it("audits configured labels against local observed label usage", () => {
    const quality = buildConfigQuality(repo, issues, pullRequests, repo.fullName);
    expect(quality.notObservedConfiguredLabels).toContain("refactor");
    expect(quality.findings.map((finding) => finding.code)).toContain("configured_labels_not_observed");
  });

  it("profiles contributors and ranks evidence-backed opportunities", () => {
    const profile = buildContributorProfile(
      "oktofeesh1",
      { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" },
      pullRequests,
      [],
    );
    const opportunities = buildContributorOpportunities(profile, [repo], issues, pullRequests);
    expect(profile.trustSignals.level).toBe("new");
    expect(opportunities[0]?.repoFullName).toBe(repo.fullName);
  });

  it("profiles contributors from cached repo stats when sampled PR rows miss their history", () => {
    const repoStats: ContributorRepoStatRecord[] = [
      {
        login: "JSONbored",
        repoFullName: "JSONbored/awesome-claude",
        pullRequests: 49,
        mergedPullRequests: 47,
        openPullRequests: 1,
        issues: 12,
        stalePullRequests: 0,
        unlinkedPullRequests: 1,
        dominantLabels: ["bug", "ci"],
        lastActivityAt: "2026-05-25T00:00:00.000Z",
      },
    ];
    const profile = buildContributorProfile("jsonbored", { login: "JSONbored", topLanguages: ["TypeScript"], source: "github" }, [], [], repoStats);
    const detection = detectGittensorContributor("jsonbored", { ...pullRequests[0]!, authorLogin: "JSONbored" }, [], [], repoStats);

    expect(profile.registeredRepoActivity).toMatchObject({
      pullRequests: 49,
      mergedPullRequests: 47,
      issues: 12,
      reposTouched: ["JSONbored/awesome-claude"],
    });
    expect(profile.trustSignals.level).toBe("established");
    expect(detection).toMatchObject({ detected: true, priorMergedPullRequests: 47, priorIssues: 12 });
  });

  it("prefers Gittensor API contributor totals over broad GitHub cache history", () => {
    const profile = buildContributorProfile(
      "jsonbored",
      { login: "JSONbored", topLanguages: ["Ruby", "Python"], source: "github" },
      [],
      [],
      [
        {
          login: "jsonbored",
          repoFullName: "JSONbored/awesome-claude",
          pullRequests: 183,
          mergedPullRequests: 164,
          openPullRequests: 1,
          issues: 86,
          stalePullRequests: 0,
          unlinkedPullRequests: 0,
          dominantLabels: ["feature"],
        },
      ],
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
        alphaPerDay: 72,
        taoPerDay: 0.3,
        usdPerDay: 92,
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
            repoFullName: "we-promise/sure",
            pullRequests: 47,
            mergedPullRequests: 37,
            openPullRequests: 6,
            closedPullRequests: 4,
            openIssues: 0,
            closedIssues: 0,
            solvedIssues: 0,
            validSolvedIssues: 0,
            isEligible: true,
            isIssueEligible: false,
            credibility: 0.9,
            issueCredibility: 0,
            totalScore: 43,
            baseTotalScore: 549,
          },
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
        ],
        pullRequests: [{ repoFullName: "we-promise/sure", number: 1869, title: "feat(imports): verify Sure NDJSON import readback", state: "MERGED", label: null, score: 13.55, baseScore: 16.73, tokenScore: 128.47 }],
        issueLabels: ["feature", "help wanted"],
      },
    );

    expect(profile.source).toBe("gittensor_api");
    expect(profile.registeredRepoActivity).toMatchObject({ pullRequests: 63, mergedPullRequests: 46, issues: 48 });
    expect(profile.gittensor?.githubId).toBe("49853598");

    const fit = buildContributorFit(profile, [], [], [], [], [
      {
        login: "jsonbored",
        repoFullName: "gittensor/api-official",
        pullRequests: 63,
        mergedPullRequests: 46,
        openPullRequests: 9,
        issues: 48,
        stalePullRequests: 0,
        unlinkedPullRequests: 0,
        dominantLabels: [],
      },
    ]);
    const scoring = buildContributorScoringProfile({ login: "jsonbored", fit, scoringSnapshot: scoringModelSnapshot() });

    expect(fit.summary).toContain("Gittensor API registered-repo PR");
    expect(scoring.evidence).toMatchObject({
      registeredRepoPullRequests: 63,
      mergedPullRequests: 46,
      openPullRequests: 9,
      issueDiscoveryReports: 1,
    });
    expect(scoring.privateSignals.join("\n")).toContain("Gittensor API");
  });

  it("preflights planned PRs without reward language", () => {
    const result = buildPreflightResult(
      {
        repoFullName: repo.fullName,
        title: "Fix dashboard cache refresh after reconnect",
        body: "Fixes #7",
        changedFiles: ["src/cache.ts"],
      },
      repo,
      issues,
      pullRequests,
    );
    expect(result.status).toBe("needs_work");
    expect(JSON.stringify(result)).not.toMatch(/reward|farming/i);
    expect(result.findings.map((finding) => finding.code)).toContain("missing_test_evidence");
  });

  it("gates public comments to detected contributors and sanitizes comment text", () => {
    const currentPr = pullRequests[0]!;
    const priorPr: PullRequestRecord = {
      ...currentPr,
      number: 3,
      state: "closed",
      mergedAt: "2026-05-01T00:00:00.000Z",
    };
    const detection = { ...detectGittensorContributor("oktofeesh1", currentPr, [currentPr, priorPr], []), source: "official_gittensor_api" as const };
    const settings = {
      repoFullName: repo.fullName,
      commentMode: "detected_contributors_only" as const,
      publicSignalLevel: "standard" as const,
      checkRunMode: "off" as const,
      checkRunDetailLevel: "minimal" as const,
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label" as const,
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      privateTrustEnabled: true,
    };
    const collisions = buildCollisionReport(repo.fullName, issues, pullRequests);
    const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
    const preflight = buildPreflightResult(
      { repoFullName: repo.fullName, title: currentPr.title, body: "Fixes #7", linkedIssues: [7] },
      repo,
      issues,
      pullRequests,
    );
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, [
      currentPr,
      priorPr,
    ], []);
    const comment = buildPublicPrIntelligenceComment({ repo, pr: currentPr, profile, detection, queueHealth, collisions, preflight, settings });

    expect(detection.detected).toBe(true);
    expect(shouldPublishPrIntelligenceComment(settings, detection)).toBe(true);
    expect(comment).toContain("<!-- gittensory-pr-intelligence -->");
    expect(comment).not.toMatch(/wallet|raw trust score|ranking|farming|reward/i);
  });

  it("classifies every participation lane boundary", () => {
    const inactive = buildLaneAdvice({ ...repo, registryConfig: { ...repo.registryConfig!, emissionShare: 0 } }, repo.fullName);
    const issueDiscovery = buildLaneAdvice({ ...repo, registryConfig: { ...repo.registryConfig!, issueDiscoveryShare: 1 } }, repo.fullName);
    const split = buildLaneAdvice({ ...repo, registryConfig: { ...repo.registryConfig!, issueDiscoveryShare: 0.4 } }, repo.fullName);
    const unknown = buildLaneAdvice(null, "unknown/repo");

    expect(inactive.lane).toBe("inactive");
    expect(issueDiscovery.lane).toBe("issue_discovery");
    expect(split.lane).toBe("split");
    expect(unknown.lane).toBe("unknown");
  });

  it("keeps config quality useful for fragile and inactive repos", () => {
    const unknownQuality = buildConfigQuality(null, [], [], "unknown/repo");
    const inactiveQuality = buildConfigQuality({ ...repo, registryConfig: { ...repo.registryConfig!, emissionShare: 0 } }, [], [], repo.fullName);
    const noMultiplierQuality = buildConfigQuality({ ...repo, registryConfig: { ...repo.registryConfig!, labelMultipliers: {} } }, [], [], repo.fullName);

    expect(unknownQuality.level).toBe("needs_attention");
    expect(inactiveQuality.findings.map((finding) => finding.code)).toContain("inactive_allocation");
    expect(noMultiplierQuality.findings.map((finding) => finding.code)).toContain("trusted_labels_without_multipliers");
  });

  it("keeps contributor detection and comment modes conservative", () => {
    const currentPr = pullRequests[0]!;
    const settings: RepositorySettings = {
      repoFullName: repo.fullName,
      commentMode: "off",
      publicSignalLevel: "minimal",
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label",
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      privateTrustEnabled: true,
    };
    const undetected = detectGittensorContributor("newbie", currentPr, [currentPr], []);
    const cachedDetected = detectGittensorContributor("oktofeesh1", currentPr, [currentPr, { ...currentPr, number: 10, mergedAt: "2026-05-01T00:00:00.000Z" }], []);

    expect(undetected.detected).toBe(false);
    expect(shouldPublishPrIntelligenceComment(settings, undetected)).toBe(false);
    expect(shouldPublishPrIntelligenceComment({ ...settings, commentMode: "all_prs" }, undetected)).toBe(false);
    expect(shouldPublishPrIntelligenceComment({ ...settings, commentMode: "all_prs" }, cachedDetected)).toBe(false);
    expect(shouldPublishPrIntelligenceComment({ ...settings, commentMode: "all_prs" }, { ...cachedDetected, source: "official_gittensor_api" })).toBe(true);
  });

  it("returns hold/caution opportunities for inactive and issue-discovery lanes", () => {
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, pullRequests, issues);
    const inactiveRepo: RepositoryRecord = {
      ...repo,
      fullName: "owner/inactive",
      registryConfig: { ...repo.registryConfig!, repo: "owner/inactive", emissionShare: 0 },
    };
    const issueDiscoveryRepo: RepositoryRecord = {
      ...repo,
      fullName: "owner/issues-only",
      registryConfig: { ...repo.registryConfig!, repo: "owner/issues-only", issueDiscoveryShare: 1 },
    };
    const issueForInactive: IssueRecord = { ...issues[0]!, repoFullName: inactiveRepo.fullName, number: 70, title: "Inactive issue" };
    const issueForDiscovery: IssueRecord = { ...issues[1]!, repoFullName: issueDiscoveryRepo.fullName, number: 71, title: "Discovery issue" };

    const opportunities = buildContributorOpportunities(profile, [inactiveRepo, issueDiscoveryRepo], [issueForInactive, issueForDiscovery], []);

    expect(opportunities.find((opportunity) => opportunity.repoFullName === inactiveRepo.fullName)?.fit).toBe("hold");
    expect(opportunities.find((opportunity) => opportunity.repoFullName === issueDiscoveryRepo.fullName)?.warnings).toContain("This repo is not a direct-PR-first lane.");
  });

  it("summarizes public comments at minimal signal level", () => {
    const currentPr: PullRequestRecord = { ...pullRequests[0]!, linkedIssues: [], body: "" };
    const detection = { ...detectGittensorContributor("newbie", currentPr, [], []), detected: true, source: "official_gittensor_api" as const, reason: "Official Gittensor API confirms this GitHub user." };
    const collisions = buildCollisionReport(repo.fullName, issues, [currentPr]);
    const queueHealth = buildQueueHealth(repo, issues, [currentPr], collisions);
    const preflight = buildPreflightResult({ repoFullName: repo.fullName, title: currentPr.title, changedFiles: ["README.md"] }, repo, issues, [currentPr]);
    const profile = buildContributorProfile("newbie", { login: "newbie", topLanguages: [], source: "unavailable" }, [], []);
    const settings: RepositorySettings = {
      repoFullName: repo.fullName,
      commentMode: "all_prs",
      publicSignalLevel: "minimal",
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label",
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      privateTrustEnabled: true,
    };

    const comment = buildPublicPrIntelligenceComment({ repo, pr: currentPr, profile, detection, queueHealth, collisions, preflight, settings });

    expect(comment).toContain("Linked issues: Not required by this repo setting");
    expect(comment).toContain("Public profile languages: not available");
    expect(comment).not.toMatch(/trust score|wallet|ranking/i);
  });

  it("separates active and historical bounty lifecycle risk", () => {
    const active: BountyRecord = {
      id: "bounty-1",
      repoFullName: repo.fullName,
      issueNumber: 7,
      status: "Active",
      amountText: "1.0",
      payload: { bounty_amount: 1 },
    };
    const historical: BountyRecord = {
      ...active,
      id: "bounty-2",
      status: "Completed",
      payload: { target_bounty: 2, bounty_amount: 0 },
    };
    const linkedIssue: IssueRecord = { ...issues[0]!, linkedPrs: [12, 13] };

    expect(buildBountyAdvisory(active, repo, null)).toMatchObject({ lifecycle: "active", fundingStatus: "funded", consensusRisk: "high" });
    expect(buildBountyAdvisory(historical, null, linkedIssue)).toMatchObject({ lifecycle: "historical", fundingStatus: "target_only", consensusRisk: "medium" });
  });

  it("covers contributor fit and label audit warning boundaries", () => {
    const noUsageAudit = buildLabelAudit(
      { ...repo, registryConfig: { ...repo.registryConfig!, labelMultipliers: { feature: 1 } } },
      [],
      [],
      [],
      repo.fullName,
    );
    expect(noUsageAudit.findings.map((finding) => finding.code)).toContain("configured_labels_unused");

    const mergedPullRequests = Array.from({ length: 4 }, (_, index): PullRequestRecord => ({
      ...pullRequests[0]!,
      number: 200 + index,
      state: "merged",
      mergedAt: "2026-05-01T00:00:00.000Z",
    }));
    const established = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["Rust"], source: "github" }, mergedPullRequests, []);
    const busyPullRequests = Array.from({ length: 8 }, (_, index): PullRequestRecord => ({
      ...pullRequests[0]!,
      number: 300 + index,
      repoFullName: "owner/split",
      linkedIssues: [index + 1],
    }));
    const splitRepo: RepositoryRecord = {
      ...repo,
      fullName: "owner/split",
      registryConfig: { ...repo.registryConfig!, repo: "owner/split", issueDiscoveryShare: 0.5 },
    };
    const splitIssues = [{ ...issues[0]!, repoFullName: "owner/split", number: 100, labels: ["bug"] }];
    const fit = buildContributorFit(
      established,
      [splitRepo],
      splitIssues,
      busyPullRequests,
      [{ repoFullName: "owner/split", status: "success", sourceKind: "github", primaryLanguage: "TypeScript", openIssuesCount: 1, openPullRequestsCount: 8, recentMergedPullRequestsCount: 0, warnings: [] }],
      [],
    );

    expect(established.trustSignals.level).toBe("established");
    expect(fit.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["no_language_fit", "busy_queue_matches"]));
    expect(fit.opportunities[0]?.warnings).toContain("This repo has a busy open PR queue.");
  });

  it("detects prior non-merged activity as contributor context", () => {
    const currentPr = pullRequests[0]!;
    const priorOpenPr: PullRequestRecord = { ...currentPr, number: 99, mergedAt: undefined };
    const detection = detectGittensorContributor("oktofeesh1", currentPr, [currentPr, priorOpenPr], []);

    expect(detection).toMatchObject({ detected: true, priorPullRequests: 1, priorMergedPullRequests: 0 });
  });

  it("builds private contributor outcome and strategy reports across maintainer and cleanup lanes", () => {
    const ownerRepo: RepositoryRecord = {
      ...repo,
      fullName: "jsonbored/gittensory",
      owner: "jsonbored",
      name: "gittensory",
      registryConfig: { ...repo.registryConfig!, repo: "jsonbored/gittensory", maintainerCut: 0.1 },
    };
    const riskyRepo: RepositoryRecord = {
      ...repo,
      fullName: "owner/risky",
      owner: "owner",
      name: "risky",
      registryConfig: { ...repo.registryConfig!, repo: "owner/risky" },
    };
    const issueDiscoveryRepo: RepositoryRecord = {
      ...repo,
      fullName: "owner/issues",
      owner: "owner",
      name: "issues",
      registryConfig: { ...repo.registryConfig!, repo: "owner/issues", issueDiscoveryShare: 1 },
    };
    const profile = buildContributorProfile("jsonbored", { login: "JSONbored", topLanguages: ["TypeScript"], source: "github" }, [], [], [], {
      source: "gittensor_api",
      githubId: "49853598",
      githubUsername: "JSONbored",
      uid: 29,
      hotkey: "hotkey",
      evaluatedAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
      isEligible: true,
      credibility: 0.76,
      eligibleRepoCount: 2,
      issueDiscoveryScore: 12,
      issueTokenScore: 3,
      issueCredibility: 0.7,
      isIssueEligible: true,
      issueEligibleRepoCount: 1,
      alphaPerDay: 12,
      taoPerDay: 0.05,
      usdPerDay: 18,
      totals: {
        pullRequests: 10,
        mergedPullRequests: 2,
        openPullRequests: 5,
        closedPullRequests: 3,
        openIssues: 12,
        closedIssues: 2,
        solvedIssues: 1,
        validSolvedIssues: 1,
      },
      repositories: [
        {
          repoFullName: ownerRepo.fullName,
          pullRequests: 1,
          mergedPullRequests: 1,
          openPullRequests: 0,
          closedPullRequests: 0,
          openIssues: 0,
          closedIssues: 0,
          solvedIssues: 0,
          validSolvedIssues: 0,
          isEligible: true,
          isIssueEligible: false,
          credibility: 0.95,
          issueCredibility: 0,
          totalScore: 10,
          baseTotalScore: 10,
        },
        {
          repoFullName: riskyRepo.fullName,
          pullRequests: 8,
          mergedPullRequests: 1,
          openPullRequests: 5,
          closedPullRequests: 2,
          openIssues: 12,
          closedIssues: 1,
          solvedIssues: 0,
          validSolvedIssues: 0,
          isEligible: true,
          isIssueEligible: false,
          credibility: 0.4,
          issueCredibility: 0.1,
          totalScore: 6,
          baseTotalScore: 20,
        },
        {
          repoFullName: issueDiscoveryRepo.fullName,
          pullRequests: 1,
          mergedPullRequests: 0,
          openPullRequests: 0,
          closedPullRequests: 1,
          openIssues: 0,
          closedIssues: 1,
          solvedIssues: 1,
          validSolvedIssues: 1,
          isEligible: false,
          isIssueEligible: true,
          credibility: 0.9,
          issueCredibility: 0.95,
          totalScore: 3,
          baseTotalScore: 4,
        },
      ],
      pullRequests: [{ repoFullName: riskyRepo.fullName, number: 44, title: "Risky PR", state: "OPEN", label: "bug", score: 1, baseScore: 1, tokenScore: 1 }],
      issueLabels: ["bug", "feature"],
    });
    const contributorPrs: PullRequestRecord[] = [
      { ...pullRequests[0]!, repoFullName: ownerRepo.fullName, authorLogin: "jsonbored", authorAssociation: "OWNER", number: 1, state: "merged", mergedAt: "2026-05-20T00:00:00.000Z" },
      ...Array.from({ length: 5 }, (_, index): PullRequestRecord => ({
        ...pullRequests[0]!,
        repoFullName: riskyRepo.fullName,
        authorLogin: "jsonbored",
        authorAssociation: "NONE",
        number: 10 + index,
        state: "open",
        linkedIssues: [100 + index],
        updatedAt: "2026-04-01T00:00:00.000Z",
      })),
    ];
    const contributorIssues: IssueRecord[] = Array.from({ length: 12 }, (_, index): IssueRecord => ({
      repoFullName: riskyRepo.fullName,
      number: 100 + index,
      title: `Risky issue ${index}`,
      state: "open",
      authorLogin: "jsonbored",
      labels: ["bug"],
      linkedPrs: [],
    }));
    const repoStats: ContributorRepoStatRecord[] = [
      { login: "jsonbored", repoFullName: riskyRepo.fullName, pullRequests: 8, mergedPullRequests: 1, openPullRequests: 5, issues: 12, stalePullRequests: 1, unlinkedPullRequests: 1, dominantLabels: ["bug"], lastActivityAt: "2026-05-25T00:00:00.000Z" },
      { login: "jsonbored", repoFullName: ownerRepo.fullName, pullRequests: 1, mergedPullRequests: 1, openPullRequests: 0, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["feature"], lastActivityAt: "2026-05-25T00:00:00.000Z" },
    ];

    const repositories = [ownerRepo, riskyRepo, issueDiscoveryRepo];
    const history = buildContributorOutcomeHistory({ login: "jsonbored", profile, repositories, pullRequests: contributorPrs, issues: contributorIssues, repoStats });
    const fit = buildContributorFit(
      profile,
      repositories,
      [{ ...issues[0]!, repoFullName: riskyRepo.fullName, number: 100, title: "Risky issue" }],
      contributorPrs,
      [{ repoFullName: riskyRepo.fullName, status: "success", sourceKind: "github", openIssuesCount: 12, openPullRequestsCount: 5, recentMergedPullRequestsCount: 0, primaryLanguage: "TypeScript", warnings: [] }],
      repoStats,
    );
    const scoring = buildContributorScoringProfile({ login: "jsonbored", fit, scoringSnapshot: scoringModelSnapshot() });
    const strategy = buildContributorStrategy({ login: "jsonbored", fit, scoringProfile: scoring, scoringSnapshot: scoringModelSnapshot(), outcomeHistory: history });
    const ownerRecommendation = buildRepoFitRecommendation({ login: "jsonbored", repo: ownerRepo, repoFullName: ownerRepo.fullName, profile, issues: [], pullRequests: contributorPrs, outcomeHistory: history });
    const riskyRecommendation = buildRepoFitRecommendation({ login: "jsonbored", repo: riskyRepo, repoFullName: riskyRepo.fullName, profile, issues: contributorIssues, pullRequests: contributorPrs, outcomeHistory: history });

    expect(history.reconciliation?.officialAuthoritative).toBe(true);
    expect(history.failurePatterns.map((pattern) => pattern.title)).toEqual(expect.arrayContaining(["Open PR pressure", "Raw issue activity is not solved discovery evidence"]));
    expect(strategy.cleanupFirst.map((entry) => entry.repoFullName)).toContain(riskyRepo.fullName);
    expect(strategy.maintainerLaneRepos.map((entry) => entry.repoFullName)).toContain(ownerRepo.fullName);
    expect(strategy.avoidRepos.map((entry) => entry.repoFullName)).toContain(riskyRepo.fullName);
    expect(ownerRecommendation.recommendation).toBe("maintainer_lane");
    expect(riskyRecommendation.recommendation).toBe("cleanup_first");
  });

  it("covers issue lifecycle, review intelligence, registry diffs, and maintainer forecast boundaries", () => {
    const issueDiscoveryRepo: RepositoryRecord = {
      ...repo,
      registryConfig: { ...repo.registryConfig!, issueDiscoveryShare: 1, maintainerCut: 0 },
    };
    const staleIso = "2025-01-01T00:00:00.000Z";
    const lifecycleIssues: IssueRecord[] = [
      { ...issues[0]!, number: 21, title: "Duplicate report", labels: ["duplicate"], body: "Duplicate body".repeat(20), linkedPrs: [], updatedAt: staleIso },
      { ...issues[0]!, number: 22, title: "Invalid report", labels: ["not planned"], body: "Invalid body".repeat(20), linkedPrs: [], updatedAt: "2026-05-20T00:00:00.000Z" },
      { ...issues[0]!, number: 23, title: "Solved issue", labels: ["bug"], body: "Detailed solved body ".repeat(20), linkedPrs: [33], updatedAt: "2026-05-20T00:00:00.000Z" },
      { ...issues[0]!, number: 24, title: "Closed stale issue", state: "closed", labels: ["feature"], body: "Closed body".repeat(20), linkedPrs: [], updatedAt: staleIso },
      { ...issues[0]!, number: 25, title: "Ready issue", labels: ["feature"], body: "This issue includes a complete reproduction, expected result, actual result, and scoped acceptance criteria. ".repeat(3), linkedPrs: [], updatedAt: "2026-05-20T00:00:00.000Z" },
    ];
    const reviewPr: PullRequestRecord = {
      ...pullRequests[0]!,
      repoFullName: repo.fullName,
      number: 33,
      title: "Fix solved issue",
      authorLogin: "oktofeesh1",
      authorAssociation: "NONE",
      linkedIssues: [23],
      labels: ["bug"],
      body: "Fixes #23",
      updatedAt: "2026-05-25T00:00:00.000Z",
    };
    const recentMerged: RecentMergedPullRequestRecord[] = [
      { repoFullName: repo.fullName, number: 33, title: "Fix solved issue", authorLogin: "oktofeesh1", mergedAt: "2026-05-25T00:00:00.000Z", labels: ["bug"], linkedIssues: [23], changedFiles: ["src/fix.ts"], payload: {} },
    ];
    const files: PullRequestFileRecord[] = [
      { repoFullName: repo.fullName, pullNumber: 33, path: "src/fix.ts", status: "modified", additions: 20, deletions: 2, changes: 22, payload: {} },
      { repoFullName: repo.fullName, pullNumber: 33, path: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1, payload: {} },
    ];
    const reviews: PullRequestReviewRecord[] = [{ id: "review-1", repoFullName: repo.fullName, pullNumber: 33, reviewerLogin: "maintainer", state: "APPROVED", authorAssociation: "MEMBER", submittedAt: "2026-05-25T00:00:00.000Z", payload: {} }];
    const failedChecks: CheckSummaryRecord[] = [{ id: "check-1", repoFullName: repo.fullName, pullNumber: 33, headSha: "sha", name: "test", status: "completed", conclusion: "failure", payload: {} }];
    const lifecycle = buildIssueDiscoveryLifecycleReport(issueDiscoveryRepo, lifecycleIssues, [reviewPr], repo.fullName, recentMerged);
    const quality = buildIssueQualityReport(issueDiscoveryRepo, lifecycleIssues, [reviewPr], repo.fullName, undefined, recentMerged);
    const localPreflight = buildLocalDiffPreflightResult(
      { repoFullName: repo.fullName, title: "Fix solved issue", body: "Fixes #23", changedFiles: ["src/fix.ts"], testFiles: [], changedLineCount: 900, commitMessage: "fix: close #23" },
      issueDiscoveryRepo,
      lifecycleIssues,
      [reviewPr],
      quality,
    );
    const maintainerPacket = buildPullRequestMaintainerPacket({ repo: repo, pullRequest: reviewPr, issues: lifecycleIssues, pullRequests: [reviewPr], files, reviews, checks: failedChecks, recentMergedPullRequests: recentMerged, repoFullName: repo.fullName, pullNumber: 33 });
    const reviewIntel = buildPullRequestReviewIntelligence({ repo, pullRequest: reviewPr, issues: lifecycleIssues, pullRequests: [reviewPr], files, reviews, checks: failedChecks, recentMergedPullRequests: recentMerged, repoFullName: repo.fullName, pullNumber: 33 });
    const missingPacket = buildPullRequestMaintainerPacket({ repo, pullRequest: null, issues: lifecycleIssues, pullRequests: [reviewPr], files: [], reviews: [], checks: [], recentMergedPullRequests: [], repoFullName: repo.fullName, pullNumber: 999 });
    const manyOpenPrs = Array.from({ length: 20 }, (_, index): PullRequestRecord => ({
      ...reviewPr,
      number: 100 + index,
      title: `Unlinked queue item ${index}`,
      linkedIssues: [],
      updatedAt: staleIso,
    }));
    const collisions = buildCollisionReport(repo.fullName, lifecycleIssues, manyOpenPrs);
    const forecast = buildBurdenForecast(repo, lifecycleIssues, manyOpenPrs, collisions, 7);
    const readiness = buildMaintainerCutReadiness({ ...repo, registryConfig: { ...repo.registryConfig!, maintainerCut: 0 } }, lifecycleIssues, manyOpenPrs, repo.fullName, { openPullRequests: 20 });
    const maintainerReport = buildMaintainerLaneReport({ ...repo, registryConfig: { ...repo.registryConfig!, maintainerCut: 0 } }, lifecycleIssues, manyOpenPrs, repo.fullName, collisions, { openPullRequests: 20 });
    const intake = buildContributorIntakeHealth(repo, lifecycleIssues, manyOpenPrs, repo.fullName, collisions, { openPullRequests: 20 });
    const previous: RegistrySnapshot = registrySnapshot("previous", [
      { ...repo.registryConfig!, repo: "owner/changed", emissionShare: 0.1, issueDiscoveryShare: 0, maintainerCut: 0, trustedLabelPipeline: null, labelMultipliers: { bug: 1 }, raw: {} },
      { ...repo.registryConfig!, repo: "owner/removed", raw: {} },
    ]);
    const current: RegistrySnapshot = registrySnapshot("current", [
      { ...repo.registryConfig!, repo: "owner/changed", emissionShare: 0.2, issueDiscoveryShare: 0.5, maintainerCut: 0.1, trustedLabelPipeline: true, labelMultipliers: { feature: 2 }, raw: {} },
      { ...repo.registryConfig!, repo: "owner/added", raw: {} },
    ]);
    const changeReport = buildRegistryChangeReport([current, previous]);

    expect(lifecycle.states.map((state) => state.state)).toEqual(expect.arrayContaining(["duplicate", "invalid", "valid_solved", "closed_not_solved", "open"]));
    expect(quality.issues.map((issue) => issue.status)).toEqual(expect.arrayContaining(["ready", "do_not_use"]));
    expect(localPreflight.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["large_local_diff", "local_diff_missing_tests", "issue_quality_do_not_use"]));
    expect(maintainerPacket.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["checks_need_attention", "missing_test_files"]));
    expect(missingPacket.findings.map((finding) => finding.code)).toContain("pr_not_cached");
    expect(reviewIntel.recommendation).toBe("likely_duplicate");
    expect(forecast.level).toBe("critical");
    expect(readiness.recommendedAction).toBe("fix_config_first");
    expect(maintainerReport.findings.map((finding) => finding.code)).toContain("maintainer_cut_not_configured");
    expect(intake.level).toBe("blocked");
    expect(changeReport).toMatchObject({ addedRepos: ["owner/added"], removedRepos: ["owner/removed"] });
    expect(changeReport.changedRepos[0]?.changes).toEqual(expect.arrayContaining(["label_multipliers changed", "trusted_label_pipeline false -> true"]));
  });
});

function scoringModelSnapshot(): ScoringModelSnapshotRecord {
  return {
    id: "scoring-fixture",
    sourceKind: "test",
    sourceUrl: "fixture://scoring",
    fetchedAt: "2026-05-25T00:00:00.000Z",
    activeModel: "current_density_model",
    constants: {},
    programmingLanguages: {},
    warnings: [],
    payload: {},
  };
}

function registrySnapshot(id: string, repositories: RegistrySnapshot["repositories"]): RegistrySnapshot {
  return {
    id,
    generatedAt: "2026-05-25T00:00:00.000Z",
    fetchedAt: "2026-05-25T00:00:00.000Z",
    source: { kind: "raw-github", url: `fixture://${id}` },
    repoCount: repositories.length,
    totalEmissionShare: repositories.reduce((sum, record) => sum + record.emissionShare, 0),
    warnings: [],
    repositories,
  };
}
