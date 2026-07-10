import { describe, expect, it } from "vitest";
import {
  buildBountyAdvisory,
  buildBurdenForecast,
  classifyBountyLifecycle,
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
  buildPublicCommentSignalBundle,
  buildPullRequestMaintainerPacket,
  buildPullRequestReviewIntelligence,
  buildPublicPrIntelligenceComment,
  buildQueueHealth,
  buildRegistryChangeReport,
  buildRepoFitRecommendation,
  detectGittensorContributor,
  isPullRequestInDuplicateCluster,
  shouldPublishPrIntelligenceComment,
  type CollisionReport,
} from "../../src/signals/engine";
import { GITTENSOR_HOME_URL } from "../../src/github/footer";
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
    for (const opportunity of opportunities) {
      expect(opportunity.multiplierTier).toBe("community");
      expect(opportunity.availability).toBe("ready");
    }
  });

  it("matches contributor prior-activity and repo issues case-insensitively (regression for #1787)", () => {
    const mixedRepo: RepositoryRecord = {
      ...repo,
      fullName: "Entrius/Allways-UI",
      registryConfig: { ...repo.registryConfig!, repo: "Entrius/Allways-UI" },
    };
    const mixedIssue: IssueRecord = {
      ...issues[0]!,
      repoFullName: "entrius/allways-ui",
      number: 99,
      title: "Case-variant repo issue",
      linkedPrs: [],
    };
    const profile = buildContributorProfile(
      "oktofeesh1",
      { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" },
      [{ ...pullRequests[0]!, repoFullName: "entrius/allways-ui", linkedIssues: [] }],
      [],
    );
    const opportunities = buildContributorOpportunities(profile, [mixedRepo], [mixedIssue], []);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.reasons).toContain("Contributor has prior activity in this registered repo.");
    expect(opportunities[0]?.score).toBeGreaterThanOrEqual(70);
  });

  it("matches contributor label history case-insensitively when scoring opportunities", () => {
    const profile = buildContributorProfile(
      "oktofeesh1",
      { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" },
      [],
      [],
      [{ login: "oktofeesh1", repoFullName: repo.fullName, pullRequests: 3, mergedPullRequests: 2, openPullRequests: 1, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["Bug", "CI"], lastActivityAt: "2026-05-25T00:00:00.000Z" }],
    );
    const caseVariantIssue: IssueRecord = {
      ...issues[0]!,
      number: 88,
      title: "Crash on duplicate webhook delivery",
      labels: ["bug"],
      linkedPrs: [],
    };
    const unrelatedIssue: IssueRecord = {
      ...issues[0]!,
      number: 89,
      title: "Polish contributor onboarding docs",
      labels: ["docs"],
      linkedPrs: [],
    };
    const opportunities = buildContributorOpportunities(profile, [repo], [unrelatedIssue, caseVariantIssue], []);
    expect(opportunities[0]?.issueNumber).toBe(88);
    expect(opportunities[0]?.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/labels overlap contributor history: bug/i)]));
    expect(opportunities[0]?.score).toBeGreaterThan(opportunities.find((entry) => entry.issueNumber === 89)?.score ?? 0);
  });

  it("ranks grabbable maintainer-created issues above community issues and downgrades maintainer WIP (#699/#186)", () => {
    const profile = buildContributorProfile("scout", { login: "scout", topLanguages: ["TypeScript"], source: "github" }, [], []);
    const maintainerOpen: IssueRecord = {
      repoFullName: repo.fullName,
      number: 40,
      title: "Maintainer-created: implement reconnect backoff",
      state: "open",
      authorLogin: "entrius",
      authorAssociation: "OWNER",
      labels: ["feature"],
      linkedPrs: [],
    };
    const maintainerWip: IssueRecord = {
      repoFullName: repo.fullName,
      number: 41,
      title: "Maintainer-created: internal refactor",
      state: "open",
      authorLogin: "entrius",
      authorAssociation: "OWNER",
      labels: ["feature", "WIP"],
      linkedPrs: [],
    };
    const community: IssueRecord = {
      repoFullName: repo.fullName,
      number: 42,
      title: "Community-reported: same feature label",
      state: "open",
      authorLogin: "outsider",
      authorAssociation: "NONE",
      labels: ["feature"],
      linkedPrs: [],
    };

    const opportunities = buildContributorOpportunities(profile, [repo], [maintainerOpen, maintainerWip, community], []);
    const byNumber = new Map(opportunities.map((opportunity) => [opportunity.issueNumber, opportunity]));

    const open = byNumber.get(40)!;
    expect(open.multiplierTier).toBe("maintainer_created");
    expect(open.availability).toBe("ready");
    expect(open.reasons).toContain("Maintainer-created issue — typically the highest contribution multiplier on Gittensor.");
    expect(open.warnings).toContain("Maintainer-authored; confirm it is open for outside contribution before starting.");

    const wip = byNumber.get(41)!;
    expect(wip.multiplierTier).toBe("maintainer_created");
    expect(wip.availability).toBe("maintainer_wip");
    expect(wip.fit).toBe("hold");
    expect(wip.warnings).toContain("Maintainer-authored and labelled in-progress/internal; not a recommended outside-contributor target without confirmation.");

    const open42 = byNumber.get(42)!;
    expect(open42.multiplierTier).toBe("community");

    // Same labels/lane: the grabbable maintainer-created issue outscores the community one and the WIP one.
    expect(open.score).toBeGreaterThan(open42.score);
    expect(open.score).toBeGreaterThan(wip.score);
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

  it("flags missing test evidence for native-source-only preflight input (#2722 class regression)", () => {
    // buildPreflightResult's own isCodeFile mirror (kept in sync with local-branch.ts) omitted native/PHP
    // extensions, so a native-source-only PR was never flagged "missing_test_evidence" here.
    const result = buildPreflightResult(
      {
        repoFullName: repo.fullName,
        title: "Add native comparator",
        body: "Fixes #7",
        changedFiles: ["src/native/add.c", "src/native/add.cpp", "include/native/add.h", "src/objc/View.m", "src/legacy/Bridge.php"],
      },
      repo,
      issues,
      pullRequests,
    );
    expect(result.findings.map((finding) => finding.code)).toContain("missing_test_evidence");
  });

  it("does not flag missing test evidence when native-source changes ship with a test file", () => {
    const result = buildPreflightResult(
      {
        repoFullName: repo.fullName,
        title: "Add native comparator with coverage",
        body: "Fixes #7",
        changedFiles: ["src/native/add.c", "src/native/add.cpp"],
        tests: ["test/unit/native-add.test.ts"],
      },
      repo,
      issues,
      pullRequests,
    );
    expect(result.findings.map((finding) => finding.code)).not.toContain("missing_test_evidence");
  });

  it("flags missing test evidence for Kotlin-script source (isTestPath already knows .kts tests)", () => {
    const result = buildPreflightResult(
      {
        repoFullName: repo.fullName,
        title: "Tune Gradle Kotlin build script",
        body: "Fixes #7",
        changedFiles: ["app/Build.kts"],
      },
      repo,
      issues,
      pullRequests,
    );
    expect(result.findings.map((finding) => finding.code)).toContain("missing_test_evidence");
  });

  it("does not flag missing test evidence for generated Dart part files (engine delegates to path-matchers)", () => {
    const result = buildPreflightResult(
      {
        repoFullName: repo.fullName,
        title: "Regenerate freezed models",
        body: "Fixes #7",
        changedFiles: ["lib/models/user.g.dart", "lib/models/user.freezed.dart"],
      },
      repo,
      issues,
      pullRequests,
    );
    expect(result.findings.map((finding) => finding.code)).not.toContain("missing_test_evidence");
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
      publicAudienceMode: "gittensor_only" as const,
      publicSignalLevel: "standard" as const,
      checkRunMode: "off" as const,
      checkRunDetailLevel: "minimal" as const,
      gateCheckMode: "off" as const,
      regateSweepOrderMode: "staleness" as const,
      reviewCheckMode: "disabled" as const,
      gatePack: "gittensor" as const,
      linkedIssueGateMode: "advisory" as const,
      duplicatePrGateMode: "advisory" as const,
      qualityGateMode: "advisory" as const,
      slopGateMode: "off" as const,
      mergeReadinessGateMode: "off" as const,
      manifestPolicyGateMode: "off" as const,
      selfAuthoredLinkedIssueGateMode: "advisory" as const,
      linkedIssueSatisfactionGateMode: "off" as const,
      firstTimeContributorGrace: false,
      slopAiAdvisory: false,
      qualityGateMinScore: null,
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label" as const,
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      aiReviewMode: "off" as const,
      aiReviewByok: false,
      aiReviewAllAuthors: false, closeOwnerAuthors: false,
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
    expect(comment).toContain("<!-- gittensory-pr-panel:v1 -->");
    expect(comment).not.toMatch(/wallet|raw trust score|ranking|farming|reward/i);
  });

  it("scopes the earn-footer CTA to the repo miner page only when the repo is registered", () => {
    const currentPr = pullRequests[0]!;
    const settings = {
      repoFullName: repo.fullName,
      commentMode: "detected_contributors_only" as const,
      publicAudienceMode: "gittensor_only" as const,
      publicSignalLevel: "standard" as const,
      checkRunMode: "off" as const,
      checkRunDetailLevel: "minimal" as const,
      gateCheckMode: "off" as const,
      regateSweepOrderMode: "staleness" as const,
      reviewCheckMode: "disabled" as const,
      gatePack: "gittensor" as const,
      linkedIssueGateMode: "advisory" as const,
      duplicatePrGateMode: "advisory" as const,
      qualityGateMode: "advisory" as const,
      slopGateMode: "off" as const,
      mergeReadinessGateMode: "off" as const,
      manifestPolicyGateMode: "off" as const,
      selfAuthoredLinkedIssueGateMode: "advisory" as const,
      linkedIssueSatisfactionGateMode: "off" as const,
      firstTimeContributorGrace: false,
      slopAiAdvisory: false,
      qualityGateMinScore: null,
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label" as const,
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      aiReviewMode: "off" as const,
      aiReviewByok: false,
      aiReviewAllAuthors: false, closeOwnerAuthors: false,
    };
    const collisions = buildCollisionReport(repo.fullName, issues, pullRequests);
    const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
    const preflight = buildPreflightResult({ repoFullName: repo.fullName, title: currentPr.title, body: "Fixes #7", linkedIssues: [7] }, repo, issues, pullRequests);
    const repoEarnPage = `${GITTENSOR_HOME_URL}/miners/repository?name=${encodeURIComponent(repo.fullName)}&tab=miners`;
    const homeCta = `(${GITTENSOR_HOME_URL})`;

    // Detected contributor → full panel. Registered repo links the repo miner page; unregistered repo
    // must NOT (the page has no miner data for an unregistered repo) and falls back to the home URL.
    const priorPr: PullRequestRecord = { ...currentPr, number: 3, state: "closed", mergedAt: "2026-05-01T00:00:00.000Z" };
    const detected = { ...detectGittensorContributor("oktofeesh1", currentPr, [currentPr, priorPr], []), source: "official_gittensor_api" as const };
    const detectedProfile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, [currentPr, priorPr], []);
    expect(detected.detected).toBe(true);

    const registeredComment = buildPublicPrIntelligenceComment({ repo, pr: currentPr, profile: detectedProfile, detection: detected, queueHealth, collisions, preflight, settings });
    expect(registeredComment).toContain(repoEarnPage);

    const unregisteredRepo = { ...repo, isRegistered: false, registryConfig: null };
    const unregisteredComment = buildPublicPrIntelligenceComment({ repo: unregisteredRepo, pr: currentPr, profile: detectedProfile, detection: detected, queueHealth, collisions, preflight, settings });
    expect(unregisteredComment).not.toContain("/miners/repository");
    expect(unregisteredComment).toContain(homeCta);

    // Non-detected contributor → minimal invite. Same registration gating must hold there.
    const undetected = detectGittensorContributor("brand-new-outsider", currentPr, [], []);
    const undetectedProfile = buildContributorProfile("brand-new-outsider", { login: "brand-new-outsider", topLanguages: [], source: "github" }, [], []);
    expect(undetected.detected).toBe(false);

    const minimalRegistered = buildPublicPrIntelligenceComment({ repo, pr: currentPr, profile: undetectedProfile, detection: undetected, queueHealth, collisions, preflight, settings });
    expect(minimalRegistered).toContain(repoEarnPage);

    const minimalUnregistered = buildPublicPrIntelligenceComment({ repo: unregisteredRepo, pr: currentPr, profile: undetectedProfile, detection: undetected, queueHealth, collisions, preflight, settings });
    expect(minimalUnregistered).not.toContain("/miners/repository");
    expect(minimalUnregistered).toContain(homeCta);
  });

  it("builds a compact, source-free public AI signal bundle", () => {
    const sourceMarker = "SECRET_SOURCE_LINE_should_never_reach_ai_provider";
    const currentPr: PullRequestRecord = {
      ...pullRequests[0]!,
      title: `Implement ${sourceMarker}`,
      body: `Diff context: ${sourceMarker}\nfunction stealMe() { return "wallet hotkey payout"; }`,
    };
    const detection = { ...detectGittensorContributor("oktofeesh1", currentPr, [currentPr], []), source: "official_gittensor_api" as const };
    const settings: RepositorySettings = {
      repoFullName: repo.fullName,
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      gateCheckMode: "off",
      regateSweepOrderMode: "staleness",
      reviewCheckMode: "disabled",
      gatePack: "gittensor",
      linkedIssueGateMode: "advisory",
      duplicatePrGateMode: "advisory",
      qualityGateMode: "advisory",
      slopGateMode: "off",
      mergeReadinessGateMode: "off",
      manifestPolicyGateMode: "off",
      selfAuthoredLinkedIssueGateMode: "advisory",
      linkedIssueSatisfactionGateMode: "off",
      firstTimeContributorGrace: false,
      slopAiAdvisory: false,
      qualityGateMinScore: null,
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label",
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      aiReviewMode: "off" as const,
      aiReviewByok: false,
      aiReviewAllAuthors: false, closeOwnerAuthors: false,
    };
    const collisions = buildCollisionReport(repo.fullName, issues, pullRequests);
    const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
    const preflight = buildPreflightResult(
      { repoFullName: repo.fullName, title: currentPr.title, body: currentPr.body ?? undefined, linkedIssues: [] },
      repo,
      issues,
      pullRequests,
    );
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, [currentPr], []);

    const bundle = buildPublicCommentSignalBundle({ repo, pr: currentPr, profile, detection, queueHealth, collisions, preflight, settings });
    const serialized = JSON.stringify(bundle);

    // Carries only deterministic structured signals.
    expect(bundle.confirmedMiner).toBe(true);
    expect(bundle).toMatchObject({ queueLevel: expect.any(String), reviewBurden: expect.any(String) });
    expect(typeof bundle.collisionClusters).toBe("number");
    // Invariant: never ships PR source contents (title/body/diff) or forbidden public language.
    expect(serialized).not.toContain(sourceMarker);
    expect(serialized).not.toMatch(/wallet|hotkey|payout|raw trust score|farming/i);

    // Alternate branches: missing PR author falls back to the profile login, requireLinkedIssue
    // short-circuits the linked-issue finding filter, and "minimal" caps the finding titles at 2.
    const anonymousPr: PullRequestRecord = { ...currentPr, authorLogin: null };
    const minimalBundle = buildPublicCommentSignalBundle({
      repo,
      pr: anonymousPr,
      profile,
      detection,
      queueHealth,
      collisions,
      preflight,
      settings: { ...settings, requireLinkedIssue: true, publicSignalLevel: "minimal" },
    });
    expect(minimalBundle.requireLinkedIssue).toBe(true);
    expect((minimalBundle.publicFindingTitles as string[]).length).toBeLessThanOrEqual(2);
    expect(typeof minimalBundle.role).toBe("string");
  });

  it("regression (#4606): buildPublicCommentSignalBundle agrees with the public panel on linkedIssueGateMode alone", () => {
    // A repo that opts into the linked-issue gate purely via `.gittensory.yml` (linkedIssueGateMode !== "off")
    // and never touches the legacy `requireLinkedIssue` boolean must still surface `missing_linked_issue` in
    // the AI-rewrite signal bundle -- previously the bundle checked `requireLinkedIssue` alone and silently
    // dropped the finding in exactly this configuration.
    const currentPr: PullRequestRecord = {
      ...pullRequests[0]!,
      linkedIssues: [],
      title: "Improve dashboard cache refresh handling",
      body: "Rewrites the refresh path to avoid a stale cache after reconnect.",
    };
    const detection = detectGittensorContributor("oktofeesh1", currentPr, [currentPr], []);
    const settings: RepositorySettings = {
      repoFullName: repo.fullName,
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      gateCheckMode: "off",
      regateSweepOrderMode: "staleness",
      reviewCheckMode: "disabled",
      gatePack: "gittensor",
      linkedIssueGateMode: "block",
      duplicatePrGateMode: "advisory",
      qualityGateMode: "advisory",
      slopGateMode: "off",
      mergeReadinessGateMode: "off",
      manifestPolicyGateMode: "off",
      selfAuthoredLinkedIssueGateMode: "advisory",
      linkedIssueSatisfactionGateMode: "off",
      firstTimeContributorGrace: false,
      slopAiAdvisory: false,
      qualityGateMinScore: null,
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label",
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      aiReviewMode: "off" as const,
      aiReviewByok: false,
      aiReviewAllAuthors: false,
      closeOwnerAuthors: false,
    };
    const collisions = buildCollisionReport(repo.fullName, issues, [currentPr]);
    const queueHealth = buildQueueHealth(repo, issues, [currentPr], collisions);
    const preflight = buildPreflightResult({ repoFullName: repo.fullName, title: currentPr.title, body: currentPr.body ?? undefined, linkedIssues: [] }, repo, issues, [currentPr]);
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, [currentPr], []);
    // Sanity: the scenario actually produces the finding this test is about (no accidental no-issue rationale match).
    expect(preflight.findings.some((finding) => finding.code === "missing_linked_issue")).toBe(true);

    const blockedBundle = buildPublicCommentSignalBundle({ repo, pr: currentPr, profile, detection, queueHealth, collisions, preflight, settings });
    expect(blockedBundle.requireLinkedIssue).toBe(false);
    expect(blockedBundle.publicFindingTitles as string[]).toContain("No linked issue detected");

    // The other side of the same `||`: when the gate is fully off AND requireLinkedIssue is false, the
    // finding is correctly dropped from the bundle -- this was already correct before the fix.
    const gateOffBundle = buildPublicCommentSignalBundle({
      repo,
      pr: currentPr,
      profile,
      detection,
      queueHealth,
      collisions,
      preflight,
      settings: { ...settings, linkedIssueGateMode: "off" },
    });
    expect(gateOffBundle.publicFindingTitles as string[]).not.toContain("No linked issue detected");
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

  it("flags non-positive, non-finite, or non-numeric label multipliers as a config error", () => {
    const badRepo = {
      ...repo,
      registryConfig: {
        ...repo.registryConfig!,
        labelMultipliers: { bug: -1, stale: 0, broken: Number.NaN, weird: "x" as unknown as number, good: 1.2, penalty: 0.5 },
      },
    };
    // Observe every configured label so the unrelated "not observed" penalty does not also fire.
    const observed = [{ ...issues[0]!, labels: ["bug", "stale", "broken", "weird", "good", "penalty"] }];
    const quality = buildConfigQuality(badRepo, observed, [], repo.fullName);
    const invalid = quality.findings.find((finding) => finding.code === "invalid_label_multipliers");
    expect(invalid).toBeDefined();
    // Each bad multiplier is named with its value (sorted); valid ones are not listed.
    expect(invalid?.detail).toMatch(/broken=NaN, bug=-1, stale=0, weird=x/);
    expect(invalid?.detail).not.toMatch(/good|penalty/);
    // Four invalid entries deduct the capped 30 points; valid ones do not contribute.
    const baseline = buildConfigQuality({ ...badRepo, registryConfig: { ...badRepo.registryConfig!, labelMultipliers: { good: 1.2, penalty: 0.5 } } }, observed, [], repo.fullName).score;
    expect(quality.score).toBe(baseline - 30);
  });

  it("does not flag valid positive label multipliers, including penalty (<1) multipliers", () => {
    const okRepo = { ...repo, registryConfig: { ...repo.registryConfig!, labelMultipliers: { feature: 1.25, refactor: 0.5 } } };
    const quality = buildConfigQuality(okRepo, [{ ...issues[0]!, labels: ["feature", "refactor"] }], [], repo.fullName);
    expect(quality.findings.map((finding) => finding.code)).not.toContain("invalid_label_multipliers");
  });

  it("treats a repo with no labelMultipliers key as having no invalid multipliers", () => {
    const noLabelsRepo = { ...repo, registryConfig: { ...repo.registryConfig!, labelMultipliers: undefined as unknown as Record<string, number> } };
    const quality = buildConfigQuality(noLabelsRepo, [], [], repo.fullName);
    expect(quality.findings.map((finding) => finding.code)).not.toContain("invalid_label_multipliers");
  });

  it("keeps contributor detection and comment modes conservative", () => {
    const currentPr = pullRequests[0]!;
    const settings: RepositorySettings = {
      repoFullName: repo.fullName,
      commentMode: "off",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "minimal",
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      gateCheckMode: "off",
      regateSweepOrderMode: "staleness",
      reviewCheckMode: "disabled",
      gatePack: "gittensor",
      linkedIssueGateMode: "advisory",
      duplicatePrGateMode: "advisory",
      qualityGateMode: "advisory",
      slopGateMode: "off",
      mergeReadinessGateMode: "off",
      manifestPolicyGateMode: "off",
      selfAuthoredLinkedIssueGateMode: "advisory",
      linkedIssueSatisfactionGateMode: "off",
      firstTimeContributorGrace: false,
      slopAiAdvisory: false,
      qualityGateMinScore: null,
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label",
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      aiReviewMode: "off" as const,
      aiReviewByok: false,
      aiReviewAllAuthors: false, closeOwnerAuthors: false,
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
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "minimal",
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      gateCheckMode: "off",
      regateSweepOrderMode: "staleness",
      reviewCheckMode: "disabled",
      gatePack: "gittensor",
      linkedIssueGateMode: "advisory",
      duplicatePrGateMode: "advisory",
      qualityGateMode: "advisory",
      slopGateMode: "off",
      mergeReadinessGateMode: "off",
      manifestPolicyGateMode: "off",
      selfAuthoredLinkedIssueGateMode: "advisory",
      linkedIssueSatisfactionGateMode: "off",
      firstTimeContributorGrace: false,
      slopAiAdvisory: false,
      qualityGateMinScore: null,
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label",
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      aiReviewMode: "off" as const,
      aiReviewByok: false,
      aiReviewAllAuthors: false, closeOwnerAuthors: false,
    };

    const comment = buildPublicPrIntelligenceComment({ repo, pr: currentPr, profile, detection, queueHealth, collisions, preflight, settings });

    expect(comment).toContain("| Linked issue | ⚠️ Missing | No linked issue or no-issue rationale found. | Explain no-issue PR. |");
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

    expect(buildBountyAdvisory(active, repo, null)).toMatchObject({ lifecycle: "active", isActiveOpportunity: true, fundingStatus: "funded", consensusRisk: "high" });
    expect(buildBountyAdvisory(historical, null, linkedIssue)).toMatchObject({ lifecycle: "completed", isActiveOpportunity: false, fundingStatus: "target_only", consensusRisk: "medium" });
  });

  it("classifies the full bounty lifecycle: active, historical, completed, cancelled, stale, ambiguous", () => {
    const base = { repoFullName: repo.fullName, issueNumber: 7, payload: { bounty_amount: "1.0000" } };
    const openIssue: IssueRecord = { ...issues[0]!, state: "open", linkedPrs: [] };
    const closedIssue: IssueRecord = { ...issues[0]!, state: "closed", linkedPrs: [] };

    const active: BountyRecord = { ...base, id: "active", status: "Open", updatedAt: new Date().toISOString() };
    const historical: BountyRecord = { ...base, id: "historical", status: "Archived" };
    const completed: BountyRecord = { ...base, id: "completed", status: "Paid out" };
    const cancelled: BountyRecord = { ...base, id: "cancelled", status: "Withdrawn" };
    const stale: BountyRecord = { ...base, id: "stale", status: "Active", updatedAt: "2020-01-01T00:00:00.000Z" };
    const ambiguousStatus: BountyRecord = { ...base, id: "ambiguous-status", status: "Pending triage" };

    expect(classifyBountyLifecycle(active, openIssue)).toBe("active");
    expect(classifyBountyLifecycle(historical, openIssue)).toBe("historical");
    expect(classifyBountyLifecycle(completed, openIssue)).toBe("completed");
    expect(classifyBountyLifecycle(cancelled, openIssue)).toBe("cancelled");
    expect(classifyBountyLifecycle(stale, openIssue)).toBe("stale");
    expect(classifyBountyLifecycle(ambiguousStatus, openIssue)).toBe("ambiguous");
    // An active-looking bounty on a closed issue is a conflicting signal, not a live opportunity.
    expect(classifyBountyLifecycle(active, closedIssue)).toBe("ambiguous");

    // A bounty that advertises a reward/award is an active offer, not completed work; only past-tense payout phrasing completes it.
    expect(classifyBountyLifecycle({ ...base, id: "reward-open", status: "Reward available" }, openIssue)).toBe("active");
    expect(classifyBountyLifecycle({ ...base, id: "award-open", status: "Award open" }, openIssue)).toBe("active");
    expect(classifyBountyLifecycle({ ...base, id: "rewarded", status: "Rewarded" }, openIssue)).toBe("completed");
    expect(classifyBountyLifecycle({ ...base, id: "awarded", status: "Awarded to solver" }, openIssue)).toBe("completed");
    // Empty/whitespace status is a sparse-cache fallback that cannot be classified.
    expect(classifyBountyLifecycle({ ...base, id: "blank", status: "   " }, openIssue)).toBe("unknown");

    expect(buildBountyAdvisory(historical, repo, openIssue).findings.map((finding) => finding.code)).toContain("historical_bounty");
    expect(buildBountyAdvisory(completed, repo, openIssue).findings.map((finding) => finding.code)).toContain("completed_bounty");
    expect(buildBountyAdvisory(cancelled, repo, openIssue).findings.map((finding) => finding.code)).toContain("cancelled_bounty");
    expect(buildBountyAdvisory(stale, repo, openIssue).findings.map((finding) => finding.code)).toContain("stale_bounty");
    expect(buildBountyAdvisory(ambiguousStatus, repo, openIssue).findings.map((finding) => finding.code)).toContain("ambiguous_bounty");
    expect(buildBountyAdvisory(stale, repo, openIssue).isActiveOpportunity).toBe(false);
    expect(buildBountyAdvisory({ ...base, id: "target-only", status: "Open", payload: { target_bounty: 1, bounty_amount: "0.0000" } }, repo, openIssue).fundingStatus).toBe("target_only");
    expect(buildBountyAdvisory({ ...base, id: "unknown-funding", status: "Open", payload: {} }, repo, openIssue).fundingStatus).toBe("unknown");

    const stalePreflight = buildPreflightResult({ repoFullName: repo.fullName, title: "Fix cache", body: "Fixes #7" }, repo, [openIssue], [], [stale]);
    const ambiguousPreflight = buildPreflightResult({ repoFullName: repo.fullName, title: "Fix cache", body: "Fixes #7" }, repo, [openIssue], [], [ambiguousStatus]);
    expect(stalePreflight.findings.map((finding) => finding.code)).toContain("linked_issue_bounty_unverified");
    expect(ambiguousPreflight.findings.map((finding) => finding.code)).toContain("linked_issue_bounty_unverified");

    const currentPr: PullRequestRecord = { ...pullRequests[0]!, body: "Fixes #7", linkedIssues: [7] };
    const publicPreflight = buildPreflightResult({ repoFullName: repo.fullName, title: currentPr.title, body: currentPr.body ?? undefined, linkedIssues: [7] }, repo, [openIssue], [], [completed]);
    const publicComment = buildPublicPrIntelligenceComment({
      repo,
      pr: currentPr,
      profile: buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, [currentPr], []),
      detection: { ...detectGittensorContributor("oktofeesh1", currentPr, [currentPr], []), detected: true, source: "official_gittensor_api", reason: "Official Gittensor API confirms this GitHub user." },
      queueHealth: buildQueueHealth(repo, [openIssue], [currentPr], buildCollisionReport(repo.fullName, [openIssue], [currentPr])),
      collisions: buildCollisionReport(repo.fullName, [openIssue], [currentPr]),
      preflight: publicPreflight,
      settings: {
        repoFullName: repo.fullName,
        commentMode: "all_prs",
        publicAudienceMode: "gittensor_only",
        publicSignalLevel: "standard",
        checkRunMode: "off",
        checkRunDetailLevel: "minimal",
        gateCheckMode: "off",
        regateSweepOrderMode: "staleness",
        reviewCheckMode: "disabled",
        gatePack: "gittensor",
        linkedIssueGateMode: "advisory",
        duplicatePrGateMode: "advisory",
        qualityGateMode: "advisory",
        slopGateMode: "off",
        mergeReadinessGateMode: "off",
        manifestPolicyGateMode: "off",
        selfAuthoredLinkedIssueGateMode: "advisory",
      linkedIssueSatisfactionGateMode: "off",
        firstTimeContributorGrace: false,
        slopAiAdvisory: false,
        qualityGateMinScore: null,
        autoLabelEnabled: true,
        gittensorLabel: "gittensor",
        createMissingLabel: true,
        publicSurface: "comment_and_label",
        includeMaintainerAuthors: false,
        requireLinkedIssue: false,
        backfillEnabled: true,
        aiReviewMode: "off",
        aiReviewByok: false,
        aiReviewAllAuthors: false, closeOwnerAuthors: false,
      },
    });
    expect(publicPreflight.findings.map((finding) => finding.code)).toContain("linked_issue_bounty_historical");
    expect(publicComment).not.toContain("Linked issue bounty is historical");
    expect(publicComment).not.toContain("Issue #7 has a completed bounty");
  });

  it("includes linked PR validity when PR records are available", () => {
    const issueWithPrs: IssueRecord = { ...issues[0]!, number: 7, state: "open", linkedPrs: [12, 99] };
    const fundedActive: BountyRecord = { id: "linked", repoFullName: repo.fullName, issueNumber: 7, status: "Open", payload: { bounty_amount: "2.0000" }, updatedAt: new Date().toISOString() };

    const advisory = buildBountyAdvisory(fundedActive, repo, issueWithPrs, pullRequests);
    expect(advisory.linkedPrs).toEqual([
      { number: 12, state: "open", isActive: true },
      { number: 13, state: "open", isActive: true },
      { number: 99, state: "unknown", isActive: false },
    ]);
    expect(advisory.findings.map((finding) => finding.code)).toContain("bounty_has_active_pr");

    // Cover merged/closed linked-PR states and cross-linked discovery (PRs referencing the issue via linkedIssues only).
    const mixedPrs: PullRequestRecord[] = [
      { ...pullRequests[0]!, number: 50, state: "merged", mergedAt: "2026-05-01T00:00:00.000Z", linkedIssues: [7] },
      { ...pullRequests[0]!, number: 51, state: "closed", mergedAt: undefined, linkedIssues: [7] },
    ];
    const mixedAdvisory = buildBountyAdvisory(fundedActive, repo, { ...issueWithPrs, linkedPrs: [] }, mixedPrs);
    expect(mixedAdvisory.linkedPrs).toEqual([
      { number: 50, state: "merged", isActive: false },
      { number: 51, state: "closed", isActive: false },
    ]);
  });

  it("scores linked-PR risk by state, not raw count", () => {
    const openIssue: IssueRecord = { ...issues[0]!, number: 7, state: "open", linkedPrs: [] };
    const fundedActive: BountyRecord = { id: "risk-bounty", repoFullName: repo.fullName, issueNumber: 7, status: "Open", payload: { bounty_amount: "2.0000" }, updatedAt: new Date().toISOString() };
    const linkedOpen = (number: number): PullRequestRecord => ({ ...pullRequests[0]!, number, state: "open", mergedAt: undefined, linkedIssues: [7] });
    const linkedMerged = (number: number): PullRequestRecord => ({ ...pullRequests[0]!, number, state: "merged", mergedAt: "2026-05-01T00:00:00.000Z", linkedIssues: [7] });
    const linkedClosed = (number: number): PullRequestRecord => ({ ...pullRequests[0]!, number, state: "closed", mergedAt: undefined, linkedIssues: [7] });

    // Multiple OPEN linked PRs => elevated active-overlap risk.
    const manyOpen = buildBountyAdvisory(fundedActive, repo, openIssue, [linkedOpen(60), linkedOpen(61)]);
    expect(manyOpen.consensusRisk).toBe("high");
    const overlapFinding = manyOpen.findings.find((finding) => finding.code === "bounty_has_active_pr");
    expect(overlapFinding?.severity).toBe("warning");
    expect(overlapFinding?.detail).toContain("duplicating active");
    expect(manyOpen.findings.map((finding) => finding.code)).not.toContain("bounty_linked_pr_merged");
    expect(manyOpen.findings.map((finding) => finding.code)).not.toContain("bounty_linked_pr_closed_history");

    // A MERGED linked PR => possible solved/resolution warning, not active overlap.
    const merged = buildBountyAdvisory(fundedActive, repo, openIssue, [linkedMerged(62)]);
    expect(merged.consensusRisk).toBe("medium");
    const mergedFinding = merged.findings.find((finding) => finding.code === "bounty_linked_pr_merged");
    expect(mergedFinding?.severity).toBe("warning");
    expect(mergedFinding?.detail).toMatch(/already be solved/i);
    expect(merged.findings.map((finding) => finding.code)).not.toContain("bounty_has_active_pr");

    // Only CLOSED-unmerged linked PRs => historical caution/ambiguity, distinct from active-overlap wording.
    const severalClosed = buildBountyAdvisory(fundedActive, repo, openIssue, [linkedClosed(63), linkedClosed(64)]);
    expect(severalClosed.consensusRisk).toBe("medium");
    const closedFinding = severalClosed.findings.find((finding) => finding.code === "bounty_linked_pr_closed_history");
    expect(closedFinding?.severity).toBe("warning");
    expect(closedFinding?.detail).toMatch(/historical attempts, not active competing work/i);
    expect(severalClosed.findings.map((finding) => finding.code)).not.toContain("bounty_has_active_pr");
    expect(severalClosed.findings.map((finding) => finding.code)).not.toContain("bounty_linked_pr_merged");

    // A single closed-unmerged attempt is not elevated like concurrent active overlap.
    const oneClosed = buildBountyAdvisory(fundedActive, repo, openIssue, [linkedClosed(65)]);
    expect(oneClosed.consensusRisk).toBe("low");
    expect(oneClosed.findings.find((finding) => finding.code === "bounty_linked_pr_closed_history")?.severity).toBe("info");
  });

  it("feeds bounty state into issue quality scoring", () => {
    const completedBounty: BountyRecord = { id: "q1", repoFullName: repo.fullName, issueNumber: 7, status: "Completed", payload: {} };
    const cancelledBounty: BountyRecord = { id: "q2", repoFullName: repo.fullName, issueNumber: 8, status: "Cancelled", payload: {} };
    const activeBounty: BountyRecord = { id: "q3", repoFullName: repo.fullName, issueNumber: 7, status: "Active", payload: {}, updatedAt: new Date().toISOString() };
    const report = buildIssueQualityReport(repo, issues, [], repo.fullName, [completedBounty, cancelledBounty]);
    const activeReport = buildIssueQualityReport(repo, issues, [], repo.fullName, [activeBounty]);
    const issue7 = report.issues.find((entry) => entry.number === 7)!;
    const issue8 = report.issues.find((entry) => entry.number === 8)!;
    expect(issue7.status).toBe("do_not_use");
    expect(issue8.status).toBe("do_not_use");
    expect(issue8.warnings.some((warning) => /cancelled bounty/i.test(warning))).toBe(true);
    expect(activeReport.issues.find((entry) => entry.number === 7)?.reasons).toContain("Active bounty context is attached (contribution context, not guaranteed payout).");

    // Historical / stale / ambiguous bounty states surface distinct issue-quality warnings.
    const lifecycleIssues: IssueRecord[] = [
      { ...issues[0]!, number: 30, title: "Historical bounty issue", linkedPrs: [] },
      { ...issues[0]!, number: 31, title: "Stale bounty issue", linkedPrs: [] },
      { ...issues[0]!, number: 32, title: "Ambiguous bounty issue", linkedPrs: [] },
    ];
    const lifecycleReport = buildIssueQualityReport(repo, lifecycleIssues, [], repo.fullName, [
      { id: "h", repoFullName: repo.fullName, issueNumber: 30, status: "Archived", payload: {} },
      { id: "s", repoFullName: repo.fullName, issueNumber: 31, status: "Open", payload: {}, updatedAt: "2020-01-01T00:00:00.000Z" },
      { id: "a", repoFullName: repo.fullName, issueNumber: 32, status: "Pending triage", payload: {} },
    ]);
    expect(lifecycleReport.issues.find((entry) => entry.number === 30)?.warnings.some((warning) => /historical bounty context/i.test(warning))).toBe(true);
    expect(lifecycleReport.issues.find((entry) => entry.number === 31)?.warnings.some((warning) => /bounty context for this issue looks stale/i.test(warning))).toBe(true);
    expect(lifecycleReport.issues.find((entry) => entry.number === 32)?.warnings.some((warning) => /bounty state for this issue is ambiguous/i.test(warning))).toBe(true);
  });

  it("surfaces linked-issue quality findings in preflight", () => {
    const qualityReport = {
      repoFullName: repo.fullName,
      generatedAt: new Date().toISOString(),
      lane: buildLaneAdvice(repo, repo.fullName),
      issues: [
        { number: 7, title: "Ready", status: "ready" as const, score: 90, reasons: [], warnings: [] },
        { number: 8, title: "Needs proof", status: "needs_proof" as const, score: 40, reasons: [], warnings: ["Issue body is thin."] },
        { number: 9, title: "Already covered", status: "do_not_use" as const, score: 0, reasons: [], warnings: [] },
      ],
      summary: "",
    };
    const preflight = buildPreflightResult({ repoFullName: repo.fullName, title: "Quality preflight", linkedIssues: [7, 8, 9] }, repo, issues, [], [], qualityReport);
    const codes = preflight.findings.map((finding) => finding.code);
    expect(codes).toContain("issue_quality_needs_proof");
    expect(codes).toContain("issue_quality_do_not_use");
  });

  it("keeps stale and ambiguous bounties out of strong opportunity ranking", () => {
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, pullRequests, []);
    const repoWithoutOpenPrs = { ...repo, fullName: "owner/bounty-fit", registryConfig: { ...repo.registryConfig!, repo: "owner/bounty-fit" } };
    const bountyIssues: IssueRecord[] = [
      { ...issues[0]!, repoFullName: repoWithoutOpenPrs.fullName, number: 1, title: "Fresh funded task", linkedPrs: [] },
      { ...issues[0]!, repoFullName: repoWithoutOpenPrs.fullName, number: 2, title: "Stale funded task", linkedPrs: [] },
      { ...issues[0]!, repoFullName: repoWithoutOpenPrs.fullName, number: 3, title: "Completed funded task", linkedPrs: [] },
      { ...issues[0]!, repoFullName: repoWithoutOpenPrs.fullName, number: 4, title: "Ambiguous funded task", linkedPrs: [] },
    ];
    const bounties: BountyRecord[] = [
      { id: "active-fit", repoFullName: repoWithoutOpenPrs.fullName, issueNumber: 1, status: "Active", payload: { bounty_alpha: "1.0000" }, updatedAt: new Date().toISOString() },
      { id: "stale-fit", repoFullName: repoWithoutOpenPrs.fullName, issueNumber: 2, status: "Active", payload: { bounty_alpha: "1.0000" }, updatedAt: "2020-01-01T00:00:00.000Z" },
      { id: "completed-fit", repoFullName: repoWithoutOpenPrs.fullName, issueNumber: 3, status: "Completed", payload: { bounty_alpha: "1.0000" } },
      { id: "ambiguous-fit", repoFullName: repoWithoutOpenPrs.fullName, issueNumber: 4, status: "Pending triage", payload: { bounty_alpha: "1.0000" } },
    ];

    const opportunities = buildContributorOpportunities(profile, [repoWithoutOpenPrs], bountyIssues, [], bounties);

    expect(opportunities.map((opportunity) => opportunity.issueNumber)).toEqual([1, 2, 4]);
    expect(opportunities.find((opportunity) => opportunity.issueNumber === 1)?.reasons).toContain("An active bounty is attached as contribution context (not guaranteed payout).");
    expect(opportunities.find((opportunity) => opportunity.issueNumber === 2)?.fit).not.toBe("good");
    expect(opportunities.find((opportunity) => opportunity.issueNumber === 2)?.warnings).toContain("Attached bounty context looks stale; confirm it is still active before acting.");
    expect(opportunities.find((opportunity) => opportunity.issueNumber === 4)?.fit).not.toBe("good");
    expect(opportunities.find((opportunity) => opportunity.issueNumber === 4)?.warnings).toContain("Attached bounty state is ambiguous; verify it before acting.");

    const strongProfile = buildContributorProfile(
      "oktofeesh1",
      { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" },
      [],
      [],
      [
        {
          login: "oktofeesh1",
          repoFullName: repoWithoutOpenPrs.fullName,
          pullRequests: 4,
          mergedPullRequests: 3,
          openPullRequests: 0,
          issues: 1,
          stalePullRequests: 0,
          unlinkedPullRequests: 0,
          dominantLabels: ["bug", "feature", "enhancement", "refactor", "docs"],
        },
      ],
    );
    const highSignalStaleIssue: IssueRecord = { ...bountyIssues[1]!, labels: ["bug", "feature", "enhancement", "refactor", "docs"] };
    const highSignalStale = buildContributorOpportunities(strongProfile, [repoWithoutOpenPrs], [highSignalStaleIssue], [], [bounties[1]!]);
    expect(highSignalStale[0]).toMatchObject({ fit: "caution", score: 70 });
  });

  it("drops completed, cancelled, and historical bounty issues from opportunities entirely", () => {
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, pullRequests, []);
    const deadRepo = { ...repo, fullName: "owner/dead-bounties", registryConfig: { ...repo.registryConfig!, repo: "owner/dead-bounties" } };
    const deadIssues: IssueRecord[] = [
      { ...issues[0]!, repoFullName: deadRepo.fullName, number: 1, title: "Completed work", linkedPrs: [] },
      { ...issues[0]!, repoFullName: deadRepo.fullName, number: 2, title: "Cancelled work", linkedPrs: [] },
      { ...issues[0]!, repoFullName: deadRepo.fullName, number: 3, title: "Historical work", linkedPrs: [] },
      { ...issues[0]!, repoFullName: deadRepo.fullName, number: 4, title: "Active work", linkedPrs: [] },
    ];
    const deadBounties: BountyRecord[] = [
      { id: "d1", repoFullName: deadRepo.fullName, issueNumber: 1, status: "Completed", payload: { bounty_alpha: "1.0000" } },
      { id: "d2", repoFullName: deadRepo.fullName, issueNumber: 2, status: "Cancelled", payload: { bounty_alpha: "1.0000" } },
      { id: "d3", repoFullName: deadRepo.fullName, issueNumber: 3, status: "Archived", payload: { bounty_alpha: "1.0000" } },
      { id: "d4", repoFullName: deadRepo.fullName, issueNumber: 4, status: "Active", payload: { bounty_alpha: "1.0000" }, updatedAt: new Date().toISOString() },
    ];
    const numbers = buildContributorOpportunities(profile, [deadRepo], deadIssues, [], deadBounties).map((opportunity) => opportunity.issueNumber);
    expect(numbers).not.toContain(1);
    expect(numbers).not.toContain(2);
    expect(numbers).not.toContain(3);
    expect(numbers).toContain(4);
  });

  it("keeps bounty-aware opportunity and issue-quality work bounded for large bounty/issue sets", () => {
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, pullRequests, []);
    // 10 registered repos x 600 issues each = 6000 issues, each with a bounty (even issues completed, odd active).
    const bigRepos = Array.from({ length: 10 }, (_, index) => ({
      ...repo,
      fullName: `owner/huge-${index}`,
      registryConfig: { ...repo.registryConfig!, repo: `owner/huge-${index}` },
    }));
    const bigIssues: IssueRecord[] = bigRepos.flatMap((bigRepo) =>
      Array.from({ length: 600 }, (_, index) => ({ ...issues[0]!, repoFullName: bigRepo.fullName, number: index + 1, title: `Issue ${index + 1}`, linkedPrs: [] })),
    );
    const bigBounties: BountyRecord[] = bigIssues.map((issue, index) => ({
      id: `big-${index}`,
      repoFullName: issue.repoFullName,
      issueNumber: issue.number,
      status: issue.number % 2 === 0 ? "Completed" : "Active",
      payload: { bounty_alpha: "1.0000" },
      updatedAt: new Date().toISOString(),
    }));

    const opportunities = buildContributorOpportunities(profile, bigRepos, bigIssues, [], bigBounties);
    // Output is bounded by the 25-opportunity cap even with thousands of candidates...
    expect(opportunities.length).toBeLessThanOrEqual(25);
    // ...and completed bounties (even issue numbers) are never surfaced as opportunities.
    expect(opportunities.every((opportunity) => (opportunity.issueNumber ?? 0) % 2 === 1)).toBe(true);

    const quality = buildIssueQualityReport(bigRepos[0]!, bigIssues.filter((issue) => issue.repoFullName === bigRepos[0]!.fullName), [], bigRepos[0]!.fullName, bigBounties);
    expect(quality.issues.length).toBeLessThanOrEqual(100);
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

  it("excludes the current PR from prior activity even when the cached copy has different repo-name casing", () => {
    // GitHub repo full-names are case-insensitive, and this module compares them with `sameRepo`
    // everywhere else. A cached copy of the current PR stored under different casing must still be
    // recognized as the current PR (not counted as the contributor's own "prior activity").
    const currentPr = pullRequests[0]!;
    const cachedCurrentDifferentCasing: PullRequestRecord = { ...currentPr, repoFullName: currentPr.repoFullName.toUpperCase() };
    const detection = detectGittensorContributor("oktofeesh1", currentPr, [cachedCurrentDifferentCasing], []);

    expect(detection).toMatchObject({ detected: false, priorPullRequests: 0, priorMergedPullRequests: 0 });
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
    const quality = buildIssueQualityReport(issueDiscoveryRepo, lifecycleIssues, [reviewPr], repo.fullName, [], undefined, recentMerged);
    const localPreflight = buildLocalDiffPreflightResult(
      { repoFullName: repo.fullName, title: "Fix solved issue", body: "Fixes #23", changedFiles: ["src/fix.ts"], testFiles: [], changedLineCount: 900, commitMessage: "fix: close #23" },
      issueDiscoveryRepo,
      lifecycleIssues,
      [reviewPr],
      [],
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

describe("isPullRequestInDuplicateCluster (#563)", () => {
  // Typed fixtures: the CollisionReport shape is compile-checked, so it cannot drift from the real type.
  const report = (clusters: CollisionReport["clusters"]): CollisionReport => ({
    repoFullName: "owner/repo",
    generatedAt: "2026-06-18T00:00:00.000Z",
    summary: { clusterCount: clusters.length, highRiskCount: clusters.filter((cluster) => cluster.risk === "high").length, itemsReviewed: clusters.reduce((total, cluster) => total + cluster.items.length, 0) },
    clusters,
  });
  type Item = CollisionReport["clusters"][number]["items"][number];
  const prItem = (number: number): Item => ({ type: "pull_request", number, title: `PR ${number}` });
  const issueItem = (number: number): Item => ({ type: "issue", number, title: `issue ${number}` });

  it("is true only for a high-risk cluster with 2+ pull requests that includes the PR", () => {
    expect(isPullRequestInDuplicateCluster(report([{ id: "c", risk: "high", reason: "overlap", items: [prItem(7), prItem(8), issueItem(3)] }]), 7)).toBe(true);
  });

  it("is false for missing, insufficient, or non-matching clusters", () => {
    expect(isPullRequestInDuplicateCluster(report([]), 7)).toBe(false); // no clusters
    expect(isPullRequestInDuplicateCluster(report([{ id: "c", risk: "high", reason: "r", items: [prItem(7), issueItem(3)] }]), 7)).toBe(false); // only 1 PR (healthy issue↔PR pair)
    expect(isPullRequestInDuplicateCluster(report([{ id: "c", risk: "medium", reason: "r", items: [prItem(7), prItem(8)] }]), 7)).toBe(false); // not high-risk
    expect(isPullRequestInDuplicateCluster(report([{ id: "c", risk: "high", reason: "r", items: [prItem(8), prItem(9)] }]), 7)).toBe(false); // PR not a member
  });
});
