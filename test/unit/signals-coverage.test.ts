import { describe, expect, it } from "vitest";
import {
  buildBountyAdvisory,
  buildCollisionReport,
  buildConfigQuality,
  buildContributorFit,
  buildContributorOpportunities,
  buildContributorOutcomeHistory,
  buildContributorPatternReport,
  buildContributorProfile,
  buildContributorScoringProfile,
  buildContributorStrategy,
  buildBurdenForecast,
  buildIssueQualityReport,
  buildLabelAudit,
  buildLaneAdvice,
  buildLocalDiffPreflightResult,
  buildMaintainerPacket,
  buildPreflightResult,
  buildPublicCommentSignalBundle,
  buildPublicPrIntelligenceComment,
  buildPublicReadinessScore,
  buildQueueHealth,
  buildRoleContext,
  detectGittensorContributor,
  shouldPublishPrIntelligenceComment,
  type CollisionCluster,
  type CollisionReport,
  type QueueHealth,
} from "../../src/signals/engine";
import {
  buildContributorRewardRiskStrategy,
  buildMaintainerNoiseReport,
  buildPullRequestReviewability,
  buildRepoRewardRisk,
} from "../../src/signals/reward-risk";
import { PREFLIGHT_LIMITS } from "../../src/signals/preflight-limits";
import type { GittensorContributorSnapshot } from "../../src/gittensor/api";
import type {
  ContributorRepoStatRecord,
  CheckSummaryRecord,
  IssueRecord,
  PullRequestFileRecord,
  PullRequestRecord,
  RepoLabelRecord,
  RegistryRepoConfig,
  RepositoryRecord,
  RepositorySettings,
  ScoringModelSnapshotRecord,
} from "../../src/types";

describe("signal coverage edge cases", () => {
  it("branches lane, label, config, and public comment publishing decisions", () => {
    const directRepo = repo("owner/direct", { issueDiscoveryShare: 0, labelMultipliers: { bug: 1.2 }, trustedLabelPipeline: true });
    const issueRepo = repo("owner/issues", { issueDiscoveryShare: 1 });
    const splitRepo = repo("owner/split", { issueDiscoveryShare: 0.4 });
    const inactiveRepo = repo("owner/inactive", { emissionShare: 0 });
    const missingRepo = { ...directRepo, isRegistered: false, registryConfig: null };
    const emptyTrusted = repo("owner/empty-trusted", { labelMultipliers: {}, trustedLabelPipeline: true });
    const settings = { ...repoSettings(directRepo.fullName), publicAudienceMode: "gittensor_only" as const };

    expect(buildLaneAdvice(null, "missing/repo").lane).toBe("unknown");
    expect(buildLaneAdvice(missingRepo, missingRepo.fullName).lane).toBe("unknown");
    expect(buildLaneAdvice(inactiveRepo, inactiveRepo.fullName).lane).toBe("inactive");
    expect(buildLaneAdvice(directRepo, directRepo.fullName).lane).toBe("direct_pr");
    expect(buildLaneAdvice(issueRepo, issueRepo.fullName).lane).toBe("issue_discovery");
    expect(buildLaneAdvice(splitRepo, splitRepo.fullName).lane).toBe("split");

    const emptyQuality = buildConfigQuality(emptyTrusted, [], [], emptyTrusted.fullName);
    const unknownQuality = buildConfigQuality(null, [], [], "missing/repo");
    const inactiveQuality = buildConfigQuality(inactiveRepo, [], [], inactiveRepo.fullName);
    expect(emptyQuality.findings.map((finding) => finding.code)).toContain("trusted_labels_without_multipliers");
    expect(unknownQuality.findings.map((finding) => finding.code)).toContain("registry_unknown");
    expect(inactiveQuality.findings.map((finding) => finding.code)).toContain("inactive_allocation");

    const audit = buildLabelAudit(directRepo, [], [], [], directRepo.fullName);
    expect(audit.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["trusted_labels_missing", "configured_labels_unused"]));

    const officialDetection = { detected: true, source: "official_gittensor_api" as const, reason: "official", priorPullRequests: 3, priorMergedPullRequests: 2, priorIssues: 1 };
    const cachedDetection = { ...officialDetection, source: "github_cache" as const };
    expect(shouldPublishPrIntelligenceComment(settings, officialDetection)).toBe(true);
    expect(shouldPublishPrIntelligenceComment({ ...settings, commentMode: "off" }, officialDetection)).toBe(false);
    expect(shouldPublishPrIntelligenceComment({ ...settings, publicSurface: "label_only" }, officialDetection)).toBe(false);
    expect(shouldPublishPrIntelligenceComment(settings, cachedDetection)).toBe(false);
  });

  it("ranks opportunities and contributor strategy from cached edge evidence", () => {
    const directRepo = repo("owner/direct", { issueDiscoveryShare: 0, labelMultipliers: { bug: 1.2 } });
    const issueRepo = repo("owner/issues", { issueDiscoveryShare: 1, labelMultipliers: { security: 1.4 } });
    const inactiveRepo = repo("owner/inactive", { emissionShare: 0 });
    const profile = buildContributorProfile(
      "dev",
      { login: "dev", topLanguages: ["Python"], source: "github" },
      [],
      [],
      [
        { login: "dev", repoFullName: directRepo.fullName, pullRequests: 2, mergedPullRequests: 1, openPullRequests: 1, issues: 1, stalePullRequests: 1, unlinkedPullRequests: 1, dominantLabels: ["bug"] },
      ],
    );
    const issues: IssueRecord[] = [
      issue(directRepo.fullName, 1, "Fix direct cache bug", { labels: ["bug"] }),
      issue(issueRepo.fullName, 2, "Report security issue", { labels: ["security"] }),
      issue(inactiveRepo.fullName, 3, "Inactive issue", { labels: [] }),
    ];
    const busyPrs = Array.from({ length: 8 }, (_, index) => pr(issueRepo.fullName, index + 10, "Busy PR", { linkedIssues: [], authorLogin: `dev${index}` }));
    const opportunities = buildContributorOpportunities(profile, [directRepo, issueRepo, inactiveRepo], issues, busyPrs);
    const fit = buildContributorFit(
      profile,
      [directRepo, issueRepo, inactiveRepo],
      issues,
      busyPrs,
      [
        { repoFullName: directRepo.fullName, status: "success", sourceKind: "github", primaryLanguage: null, openIssuesCount: 1, openPullRequestsCount: 0, recentMergedPullRequestsCount: 0, warnings: [] },
        { repoFullName: issueRepo.fullName, status: "partial", sourceKind: "github", primaryLanguage: "Rust", openIssuesCount: 1, openPullRequestsCount: 8, recentMergedPullRequestsCount: 0, warnings: ["sampled"] },
      ],
      [
        { login: "dev", repoFullName: directRepo.fullName, pullRequests: 2, mergedPullRequests: 1, openPullRequests: 1, issues: 1, stalePullRequests: 1, unlinkedPullRequests: 1, dominantLabels: ["bug"] },
      ],
    );
    const scoringProfile = buildContributorScoringProfile({ login: "dev", fit, scoringSnapshot: scoringSnapshot() });
    const strategy = buildContributorStrategy({ login: "dev", fit, scoringProfile, scoringSnapshot: scoringSnapshot() });

    expect(opportunities.map((opportunity) => opportunity.repoFullName)).toEqual(expect.arrayContaining([directRepo.fullName, issueRepo.fullName, inactiveRepo.fullName]));
    expect(opportunities.find((opportunity) => opportunity.repoFullName === issueRepo.fullName)?.warnings).toEqual(
      expect.arrayContaining(["This repo has a busy open PR queue.", "This repo is not a direct-PR-first lane."]),
    );
    expect(opportunities.find((opportunity) => opportunity.repoFullName === inactiveRepo.fullName)?.warnings).toContain("Gittensory cannot recommend this as a strong contribution target right now.");
    expect(fit.findings.map((finding) => finding.code)).toContain("no_language_fit");
    expect(strategy.nextActions).toEqual(expect.arrayContaining(["Clean up linked issue/context patterns before adding more open PRs.", "Prefer repos where the changed files match prior language evidence, or keep first submissions small."]));
  });

  it("does not double-count stat-derived dominant labels for repos already covered by cached records", () => {
    const profile = buildContributorProfile(
      "dev",
      { login: "dev", topLanguages: [], source: "github" },
      [pr("owner/shared", 1, "Real work", { authorLogin: "dev", labels: ["real-label"] })],
      [],
      [
        // Same repo as the cached PR -> its stat-derived dominant labels must not be re-counted.
        { login: "dev", repoFullName: "owner/shared", pullRequests: 1, mergedPullRequests: 0, openPullRequests: 1, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["stat-only-label"] },
        // No cached records for this repo -> its stat-derived labels still contribute (complementary coverage).
        { login: "dev", repoFullName: "owner/uncached", pullRequests: 1, mergedPullRequests: 0, openPullRequests: 0, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["uncached-label"] },
      ],
    );
    expect(profile.registeredRepoActivity.dominantLabels).toContain("real-label");
    expect(profile.registeredRepoActivity.dominantLabels).not.toContain("stat-only-label");
    expect(profile.registeredRepoActivity.dominantLabels).toContain("uncached-label");
  });

  it("treats malformed official snapshot repo names as absent during label dedupe", () => {
    const snapshot = officialSnapshot();
    snapshot.repositories[0]!.repoFullName = { malformed: true } as unknown as string;
    snapshot.pullRequests = [{ repoFullName: "owner/readiness", number: 1, title: "Fix it", state: "MERGED", label: "snapshot-label", score: 1, baseScore: 1, tokenScore: 1 }];

    const profile = buildContributorProfile(
      "jsonbored",
      { login: "jsonbored", topLanguages: [], source: "github" },
      [],
      [],
      [
        { login: "jsonbored", repoFullName: { malformed: true } as unknown as string, pullRequests: 1, mergedPullRequests: 0, openPullRequests: 0, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["malformed-stat-label"] },
        { login: "jsonbored", repoFullName: "owner/uncached", pullRequests: 1, mergedPullRequests: 0, openPullRequests: 0, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["uncached-label"] },
      ],
      snapshot,
    );

    expect(profile.registeredRepoActivity.dominantLabels).toContain("snapshot-label");
    expect(profile.registeredRepoActivity.dominantLabels).not.toContain("malformed-stat-label");
    expect(profile.registeredRepoActivity.dominantLabels).toContain("uncached-label");
  });

  it("separates cached outcome history, maintainer role sources, and contributor detections", () => {
    const directRepo = repo("owner/direct");
    const ownerRepo = repo("owner/project");
    const profile = buildContributorProfile(
      "dev",
      { login: "dev", topLanguages: ["Go"], source: "github" },
      [
        pr(directRepo.fullName, 1, "Merged focused fix", { state: "merged", mergedAt: "2026-05-20T00:00:00.000Z", authorLogin: "dev", labels: ["bug"] }),
        pr(directRepo.fullName, 2, "Closed failed fix", { state: "closed", authorLogin: "dev", labels: ["bug"] }),
        pr(directRepo.fullName, 3, "Open pressure", { state: "open", authorLogin: "dev", labels: ["bug"] }),
      ],
      [issue(directRepo.fullName, 10, "Closed issue", { state: "closed", authorLogin: "dev" })],
    );
    const history = buildContributorOutcomeHistory({
      login: "dev",
      profile,
      repositories: [directRepo, ownerRepo],
      pullRequests: [
        pr(directRepo.fullName, 1, "Merged focused fix", { state: "merged", mergedAt: "2026-05-20T00:00:00.000Z", authorLogin: "dev", labels: ["bug"] }),
        pr(directRepo.fullName, 2, "Closed failed fix", { state: "closed", authorLogin: "dev", labels: ["bug"] }),
        pr(directRepo.fullName, 3, "Open pressure", { state: "open", authorLogin: "dev", labels: ["bug"] }),
        pr(ownerRepo.fullName, 4, "Owner work", { state: "open", authorLogin: "owner", authorAssociation: "OWNER" }),
      ],
      issues: [issue(directRepo.fullName, 10, "Closed issue", { state: "closed", authorLogin: "dev" })],
      repoStats: [],
    });

    expect(buildRoleContext({ login: "owner", repo: ownerRepo, repoFullName: ownerRepo.fullName, pullRequests: [pr(ownerRepo.fullName, 4, "Owner work", { authorLogin: "owner", authorAssociation: "OWNER" })] })).toMatchObject({
      role: "owner",
      source: "repo_owner_match",
      maintainerLane: true,
    });
    expect(buildRoleContext({ login: "member", repo: directRepo, repoFullName: directRepo.fullName, pullRequests: [pr(directRepo.fullName, 5, "Member work", { authorLogin: "member", authorAssociation: "MEMBER" })] })).toMatchObject({
      role: "org_member",
      source: "github_association",
      maintainerLane: true,
    });
    expect(detectGittensorContributor("dev", pr(directRepo.fullName, 5, "Current", { authorLogin: "dev" }), history.repoOutcomes.map((outcome, index) => pr(outcome.repoFullName, index + 100, "Prior", { authorLogin: "dev", state: index === 0 ? "merged" : "open" })), [])).toMatchObject({
      detected: true,
      priorMergedPullRequests: 1,
    });
    expect(detectGittensorContributor("issue-dev", pr(directRepo.fullName, 6, "Current", { authorLogin: "issue-dev" }), [], [issue(directRepo.fullName, 99, "Prior issue", { authorLogin: "issue-dev" })])).toMatchObject({
      detected: true,
      priorIssues: 1,
    });
    expect(buildContributorPatternReport(history, "success").patterns.map((pattern) => pattern.title)).toContain("Emerging repo fit");
    expect(buildContributorPatternReport(history, "failure").patterns.map((pattern) => pattern.title)).toContain("Closed PR credibility pressure");
  });

  it("covers preflight and maintainer packet branches for clean direct-contribution repos", () => {
    const directRepo = repo("owner/direct");
    const cleanPr = pr(directRepo.fullName, 7, "Fix cache invalidation", {
      linkedIssues: [1],
      labels: [],
      body: "Fixes #1",
      updatedAt: new Date().toISOString(),
    });
    const cleanPacket = buildMaintainerPacket(directRepo, [], [cleanPr], directRepo.fullName);
    const local = buildLocalDiffPreflightResult(
      {
        repoFullName: directRepo.fullName,
        title: "Fix cache invalidation",
        body: "Fixes #1",
        changedFiles: ["internal/entity/model.go"],
        testFiles: ["internal/entity/model_test.go"],
        changedLineCount: 40,
      },
      directRepo,
      [issue(directRepo.fullName, 1, "Cache invalidation")],
      [],
    );
    const directNoIssue = buildPreflightResult(
      { repoFullName: directRepo.fullName, title: "Docs maintenance", body: "No issue: typo fix", changedFiles: ["README.md"], tests: ["manual"] },
      directRepo,
      [],
      [],
    );

    expect(cleanPacket.pullRequestPackets[0]).toMatchObject({ reviewPriority: "review", reasons: ["No obvious queue hygiene issue detected in cached metadata."] });
    expect(cleanPacket.suggestedActions).toEqual(["Queue looks manageable from cached Gittensory signals."]);
    expect(local.status).toBe("ready");
    expect(local.localDiff).toMatchObject({ codeFileCount: 1, testFileCount: 1, inferredLinkedIssues: [1] });
    expect(directNoIssue.findings.map((finding) => finding.code)).toContain("missing_linked_issue");
  });

  it("covers issue quality, burden, bounties, noise, and reviewability edge decisions", () => {
    const directRepo = repo("owner/direct");
    const issueRepo = repo("owner/issues", { issueDiscoveryShare: 1 });
    const duplicateIssues = [
      issue(directRepo.fullName, 1, "Cache refresh websocket reconnect failure", { body: "Short." }),
      issue(directRepo.fullName, 2, "Cache refresh websocket reconnect failure", { body: "Short." }),
    ];
    const highOverlapCollisions = buildCollisionReport(directRepo.fullName, duplicateIssues, []);
    const readyIssues = buildIssueQualityReport(
      issueRepo,
      [
        issue(issueRepo.fullName, 3, "Actionable issue discovery candidate", {
          body: "x".repeat(220),
          labels: ["bug"],
          updatedAt: new Date().toISOString(),
        }),
      ],
      [],
      issueRepo.fullName,
    );
    const burden = buildBurdenForecast(
      directRepo,
      [],
      Array.from({ length: 40 }, (_, index) => pr(directRepo.fullName, index + 100, `Busy PR ${index}`, { linkedIssues: [], updatedAt: new Date().toISOString() })),
      highOverlapCollisions,
      7,
    );
    const historicalBounty = buildBountyAdvisory({ id: "b1", repoFullName: "missing/repo", issueNumber: 1, status: "Cancelled", payload: { target_bounty: "1" } }, null, null);
    const activeBounty = buildBountyAdvisory({ id: "b2", repoFullName: directRepo.fullName, issueNumber: 9, status: "Open", payload: { bounty_amount: "1.0000" } }, directRepo, issue(directRepo.fullName, 9, "Funded work"));
    const directIssueQuality = buildIssueQualityReport(
      directRepo,
      [
        issue(directRepo.fullName, 4, "Thin stale direct issue", {
          body: undefined,
          updatedAt: "2025-01-01T00:00:00.000Z",
        }),
      ],
      [],
      directRepo.fullName,
    );

    expect(highOverlapCollisions.summary.highRiskCount).toBeGreaterThan(0);
    expect(readyIssues.issues[0]).toMatchObject({ status: "ready" });
    expect(directIssueQuality.issues[0]).toMatchObject({
      status: "needs_proof",
      warnings: expect.arrayContaining(["Repo is direct-PR first; issue filing is not the primary Gittensor lane."]),
    });
    expect(burden.level).toBe("critical");
    expect(burden.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["queue_growth_risk"]));
    expect(buildBurdenForecast(directRepo, [], Array.from({ length: 5 }, (_, index) => pr(directRepo.fullName, index + 300, `Medium PR ${index}`, { linkedIssues: [index] })), buildCollisionReport(directRepo.fullName, [], []), 7).level).toBe("medium");
    expect(buildBurdenForecast(directRepo, [], Array.from({ length: 12 }, (_, index) => pr(directRepo.fullName, index + 400, `High PR ${index}`, { linkedIssues: [index] })), buildCollisionReport(directRepo.fullName, [], []), 7).level).toBe("high");
    expect(historicalBounty).toMatchObject({ lifecycle: "cancelled", isActiveOpportunity: false, fundingStatus: "target_only", consensusRisk: "low" });
    expect(activeBounty).toMatchObject({ lifecycle: "active", isActiveOpportunity: true, fundingStatus: "funded", consensusRisk: "low" });
    expect(historicalBounty.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["cancelled_bounty", "bounty_repo_unregistered", "bounty_issue_not_cached"]));

    const stalePr = pr(directRepo.fullName, 20, "Misc refactor cleanup various things", {
      linkedIssues: [],
      authorLogin: "dev",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    const noise = buildMaintainerNoiseReport(directRepo, [], [stalePr], [], directRepo.fullName);
    const quietNoise = buildMaintainerNoiseReport(directRepo, [], [], [], directRepo.fullName);
    expect(noise.noiseSources.join("\n")).toMatch(/lack linked issue|stale PR|broad/i);
    expect(noise.maintainerActions).toEqual(expect.arrayContaining(["needs_author"]));
    expect(quietNoise.maintainerActions).toEqual(["watch"]);

    const fragileRepo = repo("owner/fragile", { emissionShare: 0, trustedLabelPipeline: true });
    const noisyPacket = buildMaintainerPacket(
      fragileRepo,
      duplicateIssues,
      Array.from({ length: 10 }, (_, index) =>
        pr(fragileRepo.fullName, 500 + index, `Misc cleanup ${index}`, {
          linkedIssues: [],
          labels: index === 0 ? ["bug"] : [],
          updatedAt: "2025-01-01T00:00:00.000Z",
        }),
      ),
      fragileRepo.fullName,
    );
    expect(noisyPacket.pullRequestPackets[0]).toMatchObject({ reviewPriority: "needs_author", reasons: expect.arrayContaining(["Missing linked issue context."]) });
    expect(noisyPacket.suggestedActions).toEqual(
      expect.arrayContaining([
        "Ask authors of unlinked PRs to add issue context or a no-issue rationale.",
        "Review repo Gittensor config quality before inviting more contributor flow.",
        "Prioritize queue clearing before encouraging new work.",
      ]),
    );

    const needsAuthor = buildPullRequestReviewability({
      repo: directRepo,
      pullRequest: { ...stalePr, title: "Small unlinked code fix", updatedAt: new Date().toISOString() },
      issues: [],
      pullRequests: [{ ...stalePr, title: "Small unlinked code fix", updatedAt: new Date().toISOString() }],
      files: [{ repoFullName: directRepo.fullName, pullNumber: 20, path: "src/cache.ts", additions: 10, deletions: 1, changes: 11, payload: {} }],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: directRepo.fullName,
      pullNumber: 20,
    });
    expect(needsAuthor.action).toBe("needs_author");
    expect(needsAuthor.maintainerNextSteps).toEqual(expect.arrayContaining(["Ask the author to address the concrete missing context before deep review."]));

    const makeUnlinked = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        pr(directRepo.fullName, 200 + index, `Focused fix ${index}`, {
          linkedIssues: [],
          updatedAt: new Date().toISOString(),
        }),
      );
    expect(buildMaintainerNoiseReport(directRepo, [], makeUnlinked(3), [], directRepo.fullName).level).toBe("medium");
    expect(buildMaintainerNoiseReport(directRepo, [], makeUnlinked(5), [], directRepo.fullName).level).toBe("high");
    expect(buildMaintainerNoiseReport(directRepo, [], makeUnlinked(8), [], directRepo.fullName).level).toBe("critical");

    const noisyClosedPr = pr(directRepo.fullName, 21, "Closed broad PR", {
      state: "closed",
      authorLogin: "dev",
      linkedIssues: [],
      updatedAt: new Date().toISOString(),
    });
    const closedRateHistory = buildContributorOutcomeHistory({
      login: "dev",
      profile: buildContributorProfile("dev", { login: "dev", topLanguages: ["TypeScript"], source: "github" }, [], []),
      repositories: [directRepo],
      pullRequests: [
        pr(directRepo.fullName, 30, "Closed one", { state: "closed", authorLogin: "dev" }),
        pr(directRepo.fullName, 31, "Closed two", { state: "closed", authorLogin: "dev" }),
        pr(directRepo.fullName, 32, "Merged", { state: "merged", mergedAt: "2026-05-20T00:00:00.000Z", authorLogin: "dev" }),
      ],
      issues: [],
      repoStats: [],
    });
    const broadFiles: PullRequestFileRecord[] = Array.from({ length: 12 }, (_, index) => ({
      repoFullName: directRepo.fullName,
      pullNumber: 21,
      path: `src/file-${index}.ts`,
      additions: 80,
      deletions: 0,
      changes: 80,
      payload: {},
    }));
    const failingChecks: CheckSummaryRecord[] = [
      {
        id: "check-1",
        repoFullName: directRepo.fullName,
        pullNumber: 21,
        name: "test",
        status: "completed",
        conclusion: "failure",
        payload: {},
      },
    ];
    const closedReviewability = buildPullRequestReviewability({
      repo: directRepo,
      pullRequest: noisyClosedPr,
      issues: [],
      pullRequests: [noisyClosedPr],
      files: broadFiles,
      reviews: [],
      checks: failingChecks,
      recentMergedPullRequests: [],
      repoFullName: directRepo.fullName,
      pullNumber: 21,
      outcomeHistory: closedRateHistory,
    });
    expect(closedReviewability.action).toBe("close_or_redirect");
    expect(closedReviewability.noiseSources.join("\n")).toMatch(/failing|broad|closed PR rate|PR is closed/i);
  });

  it("covers private reward/risk edge scoring for unknown, issue-only, and maintainer contexts", () => {
    const directRepo = repo("owner/direct", { labelMultipliers: { "status:ready": 2, feature: 1.5 } });
    const issueRepo = repo("owner/issues", { issueDiscoveryShare: 1 });
    const maintainerRepo = repo("jsonbored/awesome-claude");
    const inactiveRepo = repo("owner/inactive", { emissionShare: 0 });
    const profile = buildContributorProfile(
      "jsonbored",
      { login: "jsonbored", topLanguages: ["TypeScript"], source: "github" },
      [pr(maintainerRepo.fullName, 1, "Owner work", { authorLogin: "jsonbored", authorAssociation: "OWNER" })],
      [],
    );
    const history = buildContributorOutcomeHistory({
      login: "jsonbored",
      profile,
      repositories: [directRepo, issueRepo, maintainerRepo, inactiveRepo],
      pullRequests: [pr(maintainerRepo.fullName, 1, "Owner work", { authorLogin: "jsonbored", authorAssociation: "OWNER" })],
      issues: [],
      repoStats: [
        { login: "jsonbored", repoFullName: directRepo.fullName, pullRequests: 4, mergedPullRequests: 2, openPullRequests: 4, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["feature"] },
      ],
    });
    const fit = buildContributorFit(profile, [directRepo, issueRepo, maintainerRepo, inactiveRepo], [], [], [], [
      { login: "jsonbored", repoFullName: directRepo.fullName, pullRequests: 4, mergedPullRequests: 2, openPullRequests: 4, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["feature"] },
    ]);
    const scoringProfile = buildContributorScoringProfile({ login: "jsonbored", fit, scoringSnapshot: scoringSnapshot() });

    const direct = buildRepoRewardRisk({
      login: "jsonbored",
      repo: directRepo,
      repoFullName: directRepo.fullName,
      profile,
      outcomeHistory: history,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: [],
    });
    const issueOnly = buildRepoRewardRisk({
      login: "jsonbored",
      repo: issueRepo,
      repoFullName: issueRepo.fullName,
      profile,
      outcomeHistory: history,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: [],
    });
    const unknown = buildRepoRewardRisk({
      login: "jsonbored",
      repo: null,
      repoFullName: "missing/repo",
      profile,
      outcomeHistory: history,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: [],
    });
    const strategy = buildContributorRewardRiskStrategy({
      login: "jsonbored",
      fit,
      scoringProfile,
      scoringSnapshot: scoringSnapshot(),
      outcomeHistory: history,
      repositories: [directRepo, issueRepo, maintainerRepo, inactiveRepo],
      allIssues: [],
      allPullRequests: [],
    });

    expect(direct.rewardUpside.labelMultiplier).toBe(1.5);
    expect(direct.scoreBlockers).toContain("Open PR count exceeds the current threshold assumption.");
    expect(issueOnly.rewardUpside.relevantLane).toBe("issue_discovery");
    expect(unknown.scoreBlockers).toEqual(expect.arrayContaining(["Repository is not registered in the local snapshot.", "Repository lane is unknown."]));
    expect(strategy.reasoning.join("\n")).toContain("maintainer-lane economics are separate from normal contributor rewards");
    expect(strategy.actionImpact.join("\n")).toContain("openPrMultiplier");

    const emptyStrategy = buildContributorRewardRiskStrategy({
      login: "newbie",
      fit: { ...fit, opportunities: [] },
      scoringProfile,
      scoringSnapshot: scoringSnapshot(),
      outcomeHistory: { ...history, repoOutcomes: [], totals: { ...history.totals, openPullRequests: 0 } },
      repositories: [],
      allIssues: [],
      allPullRequests: [],
    });
    expect(emptyStrategy.nextActions).toEqual(["Refresh official Gittensor and GitHub backfill data, then rerun strategy."]);

    const issueCleanupHistory = {
      ...history,
      repoOutcomes: [
        ...history.repoOutcomes,
        {
          repoFullName: issueRepo.fullName,
          role: "outside_contributor" as const,
          lane: "issue_discovery" as const,
          maintainerLane: false,
          pullRequests: 1,
          mergedPullRequests: 0,
          openPullRequests: 1,
          closedPullRequests: 0,
          closedPullRequestRate: 0,
          issues: 0,
          openIssues: 0,
          closedIssues: 0,
          solvedIssues: 0,
          validSolvedIssues: 0,
          credibility: 1,
          issueCredibility: 1,
          isEligible: true,
          successLevel: "weak" as const,
          dominantLabels: [],
          successfulPaths: [],
          successfulLanguages: [],
          strengths: [],
          risks: [],
        },
      ],
    };
    const issueCleanup = buildRepoRewardRisk({
      login: "jsonbored",
      repo: issueRepo,
      repoFullName: issueRepo.fullName,
      profile,
      outcomeHistory: issueCleanupHistory,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: [pr(issueRepo.fullName, 91, "Open issue-lane work", { authorLogin: "jsonbored", linkedIssues: [] })],
    });
    expect(issueCleanup.actions.map((action) => action.actionKind)).toContain("cleanup_existing_prs");
    expect(issueCleanup.actions.map((action) => action.actionKind)).not.toContain("land_existing_prs");
  });

  it("flags possible duplicate work when the planned title overlaps an existing cluster", () => {
    // Regression: previously the preflight used `item.title.includes(input.title)`,
    // so a longer/more descriptive planned title never matched a shorter existing
    // duplicate and the `possible_duplicate_work` warning was silently dropped.
    const directRepo = repo("owner/direct");
    const issues = [issue(directRepo.fullName, 41, "Login redirect loop on OAuth callback fails")];
    const pullRequests = [
      pr(directRepo.fullName, 42, "Fix login redirect loop OAuth callback", { authorLogin: "dev", linkedIssues: [] }),
    ];

    const preflight = buildPreflightResult(
      {
        repoFullName: directRepo.fullName,
        // Longer than either existing item's title and not linked to them — only
        // direction-independent term overlap can flag it.
        title: "Resolve the login redirect loop happening at the OAuth callback",
        body: "",
        changedFiles: ["src/auth.ts"],
        linkedIssues: [],
      },
      directRepo,
      issues,
      pullRequests,
    );

    expect(preflight.findings.map((finding) => finding.code)).toContain("possible_duplicate_work");
  });

  it("does not flag duplicate work for a short planned title that merely shares one word", () => {
    // The symmetric overlap requires >=2 shared meaningful terms, so a one-word
    // planned title no longer spuriously matches unrelated open work.
    const directRepo = repo("owner/direct");
    const issues = [issue(directRepo.fullName, 51, "Login page refactor with new theme system")];
    const pullRequests = [
      pr(directRepo.fullName, 52, "Login page redesign and theme cleanup", { authorLogin: "dev", linkedIssues: [] }),
    ];

    const preflight = buildPreflightResult(
      { repoFullName: directRepo.fullName, title: "Login", body: "", changedFiles: ["src/cache.ts"], linkedIssues: [] },
      directRepo,
      issues,
      pullRequests,
    );

    expect(preflight.findings.map((finding) => finding.code)).not.toContain("possible_duplicate_work");
  });

  it("bounds preflight body scanning for linked issue extraction", () => {
    const directRepo = repo("owner/direct");
    const linkedInsideLimit = buildPreflightResult(
      {
        repoFullName: directRepo.fullName,
        title: "Bounded body scan",
        body: `Fixes #99 ${"x".repeat(PREFLIGHT_LIMITS.bodyChars + 100)}`,
        linkedIssues: [],
      },
      directRepo,
      [],
      [],
    );
    const linkedPastLimit = buildPreflightResult(
      {
        repoFullName: directRepo.fullName,
        title: "Bounded body scan",
        body: `${"x".repeat(PREFLIGHT_LIMITS.bodyChars)} Fixes #100`,
        linkedIssues: [],
      },
      directRepo,
      [],
      [],
    );

    expect(linkedInsideLimit.linkedIssues).toContain(99);
    expect(linkedPastLimit.linkedIssues).not.toContain(100);
  });

  it("sanitizes public PR comments and supports minimal public signal level", () => {
    const directRepo = repo("owner/direct");
    const prRecord = pr(directRepo.fullName, 55, "Fix cache", { authorLogin: "miner", linkedIssues: [] });
    const profile = buildContributorProfile("miner", { login: "miner", topLanguages: [], source: "github" }, [], []);
    const preflight = buildPreflightResult(
      {
        repoFullName: directRepo.fullName,
        title: "Fix cache",
        body: "",
        changedFiles: ["src/cache.ts"],
      },
      directRepo,
      [],
      [],
    );
    const comment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: prRecord,
      profile,
      detection: { detected: true, source: "official_gittensor_api", reason: "Confirmed by official API.", priorPullRequests: 1, priorMergedPullRequests: 0, priorIssues: 0 },
      queueHealth: buildQueueHealth(directRepo, [], [], buildCollisionReport(directRepo.fullName, [], [])),
      collisions: buildCollisionReport(directRepo.fullName, [], []),
      preflight: {
        ...preflight,
        findings: [
          ...preflight.findings,
          { code: "score_private", severity: "warning", title: "Estimated score", detail: "Private reward score should not leak.", action: "Do not publish score." },
          { code: "critical_private", severity: "critical", title: "Critical private", detail: "wallet hotkey trust score", action: "secret" },
        ],
      },
      settings: { ...repoSettings(directRepo.fullName), publicSignalLevel: "minimal", requireLinkedIssue: true },
    });

    expect(comment).toContain("Confirmed Gittensor contributor");
    expect(comment).toContain("| Linked issue | ⚠️ Missing |");
    expect(comment).toMatch(/Readiness score: \d+\/100/);
    expect(comment).not.toMatch(/reward|wallet|hotkey|trust score|farming|critical private/i);

    const maintainerComment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: { ...prRecord, authorLogin: "owner", authorAssociation: "OWNER", linkedIssues: [1], body: "Fixes #1" },
      profile: buildContributorProfile("owner", { login: "owner", topLanguages: ["TypeScript"], source: "github" }, [], []),
      detection: { detected: true, source: "official_gittensor_api", reason: "Confirmed by official API.", priorPullRequests: 1, priorMergedPullRequests: 1, priorIssues: 0 },
      queueHealth: buildQueueHealth(directRepo, [], [], buildCollisionReport(directRepo.fullName, [], [])),
      collisions: buildCollisionReport(directRepo.fullName, [], []),
      preflight,
      settings: repoSettings(directRepo.fullName),
    });

    expect(maintainerComment).toContain("maintainer lane");
    expect(maintainerComment).not.toMatch(/reward|wallet|hotkey|trust score|farming/i);
  });

  it("renders opt-in gate panel states for collision and repo evaluation blockers", () => {
    const directRepo = repo("owner/gate");
    const existingIssue = issue(directRepo.fullName, 7, "Cache refresh websocket reconnect failure");
    const existingPr = pr(directRepo.fullName, 8, "Cache refresh websocket reconnect fix", { authorLogin: "other", linkedIssues: [7] });
    const currentPr = pr(directRepo.fullName, 9, "Cache refresh websocket reconnect fix", { authorLogin: "dev", linkedIssues: [7], body: "Fixes #7" });
    const collisions = buildCollisionReport(directRepo.fullName, [existingIssue], [existingPr, currentPr]);
    const queueHealth = buildQueueHealth(directRepo, [existingIssue], [existingPr, currentPr], collisions);
    const preflight = buildPreflightResult(
      { repoFullName: directRepo.fullName, title: currentPr.title, body: currentPr.body ?? undefined, linkedIssues: currentPr.linkedIssues },
      directRepo,
      [existingIssue],
      [existingPr, currentPr],
    );
    const profile = buildContributorProfile("dev", { login: "dev", topLanguages: ["TypeScript"], source: "github" }, [currentPr], []);
    const detection = { detected: true, source: "github_cache" as const, reason: "cached contributor", priorPullRequests: 1, priorMergedPullRequests: 0, priorIssues: 0 };
    const gateSettings = { ...repoSettings(directRepo.fullName), gateCheckMode: "enabled" as const, duplicatePrGateMode: "block" as const };

    const collisionComment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: currentPr,
      profile,
      detection,
      queueHealth,
      collisions,
      preflight,
      settings: gateSettings,
    });

    expect(collisionComment).toContain("> [!CAUTION]");
    expect(collisionComment).toContain("A repo-configured hard blocker was found.");
    expect(collisionComment).toContain("> | Gate result | ❌ Blocking | Repo-configured hard blocker found. | Fix blocker. |");
    expect(collisionComment).toContain("Public profile only");
    expect(collisionComment).toContain("Compare #8.");
    expect(collisionComment).not.toContain("possible overlaps");
    expect(collisionComment).not.toContain("Cached OSS contributor activity");
    expect(collisionComment).not.toContain("Cached prior PRs/issues");
    expect(collisionComment).not.toContain("gittensor.io");

    const repoBlockedComment = buildPublicPrIntelligenceComment({
      repo: null,
      pr: { ...currentPr, linkedIssues: [99], body: "Fixes #99" },
      profile,
      detection: { detected: false, reason: "no cache", priorPullRequests: 0, priorMergedPullRequests: 0, priorIssues: 0 },
      queueHealth: buildQueueHealth(null, [], [], buildCollisionReport(directRepo.fullName, [], [])),
      collisions: buildCollisionReport(directRepo.fullName, [], []),
      preflight: buildPreflightResult(
        { repoFullName: directRepo.fullName, title: "Fix isolated issue", body: "Fixes #99", linkedIssues: [99] },
        null,
        [],
        [],
      ),
      settings: gateSettings,
    });

    expect(repoBlockedComment).toContain("> [!IMPORTANT]");
    expect(repoBlockedComment).toContain("cannot evaluate the repo state");
    expect(repoBlockedComment).toContain("Public profile only");
    expect(repoBlockedComment).toContain("> | Gate result | ⚠️ App action required | Install/config needs attention. | Fix app config. |");

    const missingIssueComment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: { ...currentPr, linkedIssues: [], body: "No linked issue yet." },
      profile,
      detection,
      queueHealth: buildQueueHealth(directRepo, [existingIssue], [currentPr], buildCollisionReport(directRepo.fullName, [existingIssue], [currentPr])),
      collisions: buildCollisionReport(directRepo.fullName, [existingIssue], [currentPr]),
      preflight: buildPreflightResult(
        { repoFullName: directRepo.fullName, title: currentPr.title, body: "No linked issue yet.", linkedIssues: [] },
        directRepo,
        [existingIssue],
        [currentPr],
      ),
      settings: { ...gateSettings, requireLinkedIssue: true, linkedIssueGateMode: "block" },
    });

    expect(missingIssueComment).toContain("> [!WARNING]");
    expect(missingIssueComment).toContain("> | Linked issue | ⚠️ Missing | No linked issue or no-issue rationale found. | Explain no-issue PR. |");
    expect(missingIssueComment).toContain("Explain no-issue PR.");

    const passingGateComment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: { ...currentPr, linkedIssues: [99], body: "Fixes #99" },
      profile,
      detection,
      queueHealth: buildQueueHealth(directRepo, [], [currentPr], buildCollisionReport(directRepo.fullName, [], [currentPr])),
      collisions: buildCollisionReport(directRepo.fullName, [], [currentPr]),
      preflight: buildPreflightResult(
        { repoFullName: directRepo.fullName, title: "Fix isolated issue", body: "Fixes #99", linkedIssues: [99] },
        directRepo,
        [],
        [currentPr],
      ),
      settings: gateSettings,
    });

    expect(passingGateComment).toContain("> [!TIP]");
    expect(passingGateComment).toContain("> | Gate result | ✅ Passing | No configured blocker found. | No action. |");
    expect(passingGateComment).toContain("Public GitHub metadata was checked");

    const advisoryOnlyComment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: { ...currentPr, linkedIssues: [99], body: "Fixes #99" },
      profile,
      detection,
      queueHealth: buildQueueHealth(directRepo, [], [currentPr], buildCollisionReport(directRepo.fullName, [], [currentPr])),
      collisions: buildCollisionReport(directRepo.fullName, [], [currentPr]),
      preflight: {
        ...buildPreflightResult(
          { repoFullName: directRepo.fullName, title: "Fix isolated issue", body: "Fixes #99", linkedIssues: [99] },
          directRepo,
          [],
          [currentPr],
        ),
        findings: [{ code: "public_warning", severity: "warning", title: "Validation note missing", detail: "Validation evidence is not cached yet." }],
      },
      settings: { ...repoSettings(directRepo.fullName), gateCheckMode: "off" },
    });

    expect(advisoryOnlyComment).toContain("> [!IMPORTANT]");
    expect(advisoryOnlyComment).toContain("Gittensory found maintainer review notes");
    expect(advisoryOnlyComment).toContain("Validation note missing");
    expect(advisoryOnlyComment).toContain("> | Gate result | ⚠️ Advisory only | Advisory only. | No action. |");

    const actionRequiredComment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: { ...currentPr, linkedIssues: [99], body: "Fixes #99" },
      profile,
      detection,
      queueHealth: buildQueueHealth(directRepo, [], [currentPr], buildCollisionReport(directRepo.fullName, [], [currentPr])),
      collisions: buildCollisionReport(directRepo.fullName, [], [currentPr]),
      preflight: buildPreflightResult(
        { repoFullName: directRepo.fullName, title: "Fix isolated issue", body: "Fixes #99", linkedIssues: [99] },
        directRepo,
        [],
        [currentPr],
      ),
      settings: gateSettings,
      gate: { conclusion: "action_required", summary: "Gittensory cannot evaluate this PR until installation state is repaired." },
    });
    expect(actionRequiredComment).toContain("> [!IMPORTANT]");
    expect(actionRequiredComment).toContain("Gittensory cannot evaluate this PR until installation state is repaired.");
    expect(actionRequiredComment).toContain("> | Gate result | ⚠️ App action required | Install/config needs attention. | Fix app config. |");

    const duplicateAdvisoryComment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: currentPr,
      profile,
      detection,
      queueHealth,
      collisions,
      preflight,
      settings: { ...repoSettings(directRepo.fullName), gateCheckMode: "off" },
    });
    expect(duplicateAdvisoryComment).toContain("Same-issue duplicate risk found against #8.");
    expect(duplicateAdvisoryComment).toContain("> | Related work | ⚠️ Same linked issue: #8 | Another open PR references the same linked issue. | Compare #8. |");

    const scopedClusters: CollisionCluster[] = Array.from({ length: 12 }, (_, index) => ({
      id: `scoped-${index}`,
      risk: "medium",
      reason: "Titles share 2 meaningful terms.",
      items: [{ type: "issue", number: index + 100, title: `Related issue ${index}`, authorLogin: "reporter", labels: [], linkedIssues: [] }],
    }));
    const scopedComment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: { ...currentPr, linkedIssues: [99], body: "Fixes #99" },
      profile,
      detection,
      queueHealth: buildQueueHealth(directRepo, [], [currentPr], buildCollisionReport(directRepo.fullName, [], [currentPr])),
      collisions: buildCollisionReport(directRepo.fullName, [], [currentPr]),
      preflight: {
        ...buildPreflightResult(
          { repoFullName: directRepo.fullName, title: "Fix isolated issue", body: "Fixes #99", linkedIssues: [99] },
          directRepo,
          [],
          [currentPr],
        ),
        collisions: scopedClusters,
        findings: [],
      },
      settings: { ...repoSettings(directRepo.fullName), gateCheckMode: "off" },
    });
    expect(scopedComment).toContain("> | Related work | ⚠️ 3 scoped overlaps | Top overlaps are listed below; lower-confidence bulk is hidden. | Review top overlaps. |");
    expect(scopedComment).toContain("Additional title-only matches omitted; title-only overlap does not block.");
  });

  it("counts scoped related-work as the union of PR-specific and preflight clusters, not the max", () => {
    const directRepo = repo("owner/union");
    const currentPr = pr(directRepo.fullName, 99, "Union overlap PR", { authorLogin: "dev", linkedIssues: [50], body: "Fixes #50" });
    // One repo collision cluster that contains THIS PR (deterministic literal, so prCollisionClusters = 1).
    const collisions: CollisionReport = {
      repoFullName: directRepo.fullName,
      generatedAt: "2026-06-05T00:00:00.000Z",
      summary: { clusterCount: 1, highRiskCount: 0, itemsReviewed: 2 },
      clusters: [
        {
          id: "pr-cluster",
          risk: "medium",
          reason: "Open PR work references issue #50.",
          items: [
            { type: "pull_request", number: 99, title: "Union overlap PR", authorLogin: "dev", labels: [], linkedIssues: [50] },
            { type: "issue", number: 50, title: "Shared issue", authorLogin: "reporter", labels: [], linkedIssues: [] },
          ],
        },
      ],
    };
    // Two preflight clusters, disjoint from the PR cluster (different ids, none contain PR #99).
    const preflightClusters: CollisionCluster[] = [1, 2].map((n) => ({
      id: `preflight-${n}`,
      risk: "medium",
      reason: "Titles share 2 meaningful terms.",
      items: [{ type: "issue", number: 200 + n, title: `Related ${n}`, authorLogin: "reporter", labels: [], linkedIssues: [] }],
    }));
    const profile = buildContributorProfile("dev", { login: "dev", topLanguages: [], source: "github" }, [currentPr], []);
    const detection = { detected: true, source: "github_cache" as const, reason: "cached contributor", priorPullRequests: 1, priorMergedPullRequests: 0, priorIssues: 0 };
    const comment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: currentPr,
      profile,
      detection,
      queueHealth: buildQueueHealth(directRepo, [], [currentPr], collisions),
      collisions,
      preflight: {
        ...buildPreflightResult({ repoFullName: directRepo.fullName, title: currentPr.title, body: currentPr.body ?? undefined, linkedIssues: [50] }, directRepo, [], [currentPr]),
        collisions: preflightClusters,
        findings: [],
      },
      settings: { ...repoSettings(directRepo.fullName), gateCheckMode: "off" },
    });
    // PR-specific clusters = {pr-cluster} (1); preflight clusters = 2 disjoint -> 3 distinct overlaps.
    // Old code used Math.max(1, 2) = 2; the union (3) is the correct count feeding the related-work row.
    expect(comment).toContain("3 scoped overlaps");
    expect(comment).not.toContain("2 scoped overlaps");
  });

  it("does not present global repo collision clusters as PR duplicate risk", () => {
    const directRepo = repo("owner/noisy");
    const unrelatedIssues = Array.from({ length: 12 }, (_, index) => issue(directRepo.fullName, index + 1, `Unrelated cache issue ${index + 1}`));
    const unrelatedPullRequests = unrelatedIssues.map((record, index) =>
      pr(directRepo.fullName, index + 10, `Unrelated cache fix ${index + 1}`, { linkedIssues: [record.number], body: `Fixes #${record.number}` }),
    );
    const currentPr = pr(directRepo.fullName, 99, "Isolated docs cleanup", { authorLogin: "dev", linkedIssues: [999], body: "Fixes #999" });
    const collisions = buildCollisionReport(directRepo.fullName, unrelatedIssues, [...unrelatedPullRequests, currentPr]);
    const queueHealth = buildQueueHealth(directRepo, unrelatedIssues, [...unrelatedPullRequests, currentPr], collisions);
    const preflight = buildPreflightResult(
      { repoFullName: directRepo.fullName, title: currentPr.title, body: currentPr.body ?? undefined, linkedIssues: currentPr.linkedIssues },
      directRepo,
      unrelatedIssues,
      [...unrelatedPullRequests, currentPr],
    );

    expect(collisions.summary.clusterCount).toBeGreaterThan(0);
    expect(preflight.collisions).toHaveLength(0);

    const comment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: currentPr,
      profile: buildContributorProfile("dev", { login: "dev", topLanguages: ["Markdown"], source: "github" }, [], []),
      detection: { detected: false, reason: "no official context", priorPullRequests: 0, priorMergedPullRequests: 0, priorIssues: 0 },
      queueHealth,
      collisions,
      preflight,
      settings: { ...repoSettings(directRepo.fullName), gateCheckMode: "enabled" },
    });

    expect(comment).toContain("> | Related work | ✅ No active overlap found | No same-issue or scoped active PR overlap found. | No action. |");
    expect(comment).toContain("> | Gate result | ✅ Passing | No configured blocker found. | No action. |");
    expect(comment).not.toContain("possible overlap");
    expect(comment).not.toContain("12");
  });

  it("covers PR panel edge formatting without publishing unconfirmed cache counts", () => {
    const directRepo = repo("owner/edge");
    const currentPr = pr(directRepo.fullName, 9, "Fix edge state", { authorLogin: "dev", linkedIssues: [1], body: "Fixes #1" });
    const profile = buildContributorProfile("dev", { login: "dev", topLanguages: [], source: "github" }, [], []);
    const basePreflight = buildPreflightResult(
      { repoFullName: directRepo.fullName, title: currentPr.title, body: currentPr.body ?? undefined, linkedIssues: currentPr.linkedIssues },
      directRepo,
      [],
      [currentPr],
    );
    const officialComment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: currentPr,
      profile,
      detection: { detected: true, source: "official_gittensor_api", reason: "official", priorPullRequests: 4, priorMergedPullRequests: 2, priorIssues: 3 },
      queueHealth: buildQueueHealth(directRepo, [], [currentPr], buildCollisionReport(directRepo.fullName, [], [currentPr])),
      collisions: buildCollisionReport(directRepo.fullName, [], [currentPr]),
      preflight: basePreflight,
      settings: { ...repoSettings(directRepo.fullName), publicAudienceMode: "gittensor_only", gateCheckMode: "off" },
    });
    expect(officialComment).toContain("Confirmed Gittensor contributor context was checked");
    expect(officialComment).toContain("Official Gittensor activity: 4 PR(s), 3 issue(s).");

    const selfItem = { type: "pull_request" as const, number: currentPr.number, title: currentPr.title, authorLogin: "dev", linkedIssues: currentPr.linkedIssues };
    const edgeCollisions: CollisionReport = {
      repoFullName: directRepo.fullName,
      generatedAt: new Date().toISOString(),
      summary: { clusterCount: 3, highRiskCount: 0, itemsReviewed: 4 },
      clusters: [
        { id: "self-only", risk: "medium", reason: "Only this PR is present.", items: [selfItem] },
        { id: "other-no-linked", risk: "medium", reason: "Other PR lacks linked issue metadata.", items: [selfItem, { type: "pull_request" as const, number: 10, title: "Other edge fix" }] },
        { id: "recent-merged", risk: "medium", reason: "Recent merged work is related.", items: [selfItem, { type: "recent_merged_pull_request" as const, number: 11, title: "Merged edge fix" }] },
      ],
    };
    const edgeComment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: currentPr,
      profile,
      detection: { detected: true, source: "github_cache", reason: "cached", priorPullRequests: 7, priorMergedPullRequests: 1, priorIssues: 2 },
      queueHealth: buildQueueHealth(directRepo, [], [currentPr], edgeCollisions),
      collisions: edgeCollisions,
      preflight: basePreflight,
      settings: { ...repoSettings(directRepo.fullName), gateCheckMode: "off" },
    });
    expect(edgeComment).toContain("Related work: Only this PR is present.");
    expect(edgeComment).toContain("merged PR #11");

    const bundle = buildPublicCommentSignalBundle({
      repo: directRepo,
      pr: currentPr,
      profile,
      detection: { detected: true, source: "github_cache", reason: "cached", priorPullRequests: 7, priorMergedPullRequests: 1, priorIssues: 2 },
      queueHealth: buildQueueHealth(directRepo, [], [currentPr], edgeCollisions),
      collisions: edgeCollisions,
      preflight: basePreflight,
      settings: repoSettings(directRepo.fullName),
    });
    expect(bundle).toMatchObject({ confirmedMiner: false, minerSignalDetected: false, priorPullRequests: 0, priorIssues: 0, collisionClusters: 3 });
  });

  it("renders concrete readiness states, miner links, no-issue rationale, and skipped gates", () => {
    const directRepo = repo("owner/readiness");
    const currentPr = pr(directRepo.fullName, 31, "Maintenance cleanup with no linked issue", {
      authorLogin: "JSONbored",
      body: "No issue because this is maintenance cleanup.\n\nValidation: npm test",
      labels: ["size:L"],
      isDraft: true,
    });
    const profile = buildContributorProfile(
      "JSONbored",
      { login: "JSONbored", topLanguages: ["TypeScript"], source: "github" },
      [currentPr],
      [],
      [],
      officialSnapshot(),
    );
    const preflight = {
      ...buildPreflightResult(
        { repoFullName: directRepo.fullName, title: currentPr.title, body: currentPr.body ?? undefined, labels: currentPr.labels },
        directRepo,
        [],
        [currentPr],
      ),
      status: "hold" as const,
      reviewBurden: "high" as const,
      findings: [
        { code: "tests_missing", severity: "warning" as const, title: "Test evidence missing", detail: "No cached test files found.", action: "Add validation note." },
        { code: "private_score", severity: "critical" as const, title: "Private score", detail: "wallet hotkey payout trust score", action: "secret" },
      ],
    };
    const queueHealth = buildQueueHealth(
      directRepo,
      [],
      Array.from({ length: 16 }, (_, index) => pr(directRepo.fullName, 100 + index, `Open PR ${index}`)),
      buildCollisionReport(directRepo.fullName, [], []),
    );
    const settings = { ...repoSettings(directRepo.fullName), gateCheckMode: "enabled" as const, qualityGateMode: "block" as const, qualityGateMinScore: 95 };
    const comment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: currentPr,
      profile,
      detection: { detected: true, source: "official_gittensor_api", reason: "official", priorPullRequests: 29, priorMergedPullRequests: 20, priorIssues: 6 },
      queueHealth,
      collisions: buildCollisionReport(directRepo.fullName, [], [currentPr]),
      preflight,
      settings,
      gate: { conclusion: "skipped", summary: "PR closed before full evaluation." },
    });

    expect(comment).toContain("> | Linked issue | ✅ No-issue rationale | PR body explains why no issue is linked. | No action. |");
    expect(comment).toContain("> | Review load | ❌ 8/20 |");
    expect(comment).toContain("> | Validation evidence | ❌ 5/25 | Cached preflight status is hold. | Fix blocker. |");
    expect(comment).toContain("> | Open PR queue | ❌ 3/10 | 16 open PR(s), 0 likely reviewable, 16 unlinked. | Expect slower review. |");
    expect(comment).toContain("> | Gate result | ⚠️ Skipped | PR closed before full evaluation. | No action. |");
    expect(comment).toContain("[JSONbored](https://github.com/JSONbored)");
    expect(comment).toContain("[Gittensor profile](https://gittensor.io/miners/details?githubId=49853598)");
    expect(comment).toContain("Official Gittensor activity: 29 PR(s), 6 issue(s).");
    expect(comment).toContain("- [ ] <!-- gittensory-rerun-review:v1 --> Re-run Gittensory review");
    expect(comment).not.toContain("- [x] <!-- gittensory-rerun-review:v1 -->");
    expect(comment).not.toMatch(/wallet|hotkey|payout|trust score|private score/i);
  });

  it("scores public readiness from deterministic PR facts across branch cases", () => {
    const directRepo = repo("owner/score");
    const basePr = pr(directRepo.fullName, 40, "Add focused feature", {
      body: "Fixes #1\n\nValidation: npm test",
      labels: ["size:S"],
      linkedIssues: [1, 2],
    });
    const readyPreflight = buildPreflightResult(
      { repoFullName: directRepo.fullName, title: basePr.title, body: basePr.body ?? undefined, labels: basePr.labels, linkedIssues: basePr.linkedIssues },
      directRepo,
      [],
      [basePr],
    );
    const strong = buildPublicReadinessScore({
      pr: basePr,
      preflight: { ...readyPreflight, status: "ready", reviewBurden: "low", findings: [] },
      queueHealth: queueHealthFixture(directRepo.fullName, "low"),
      scopedOverlapCount: 1,
    });

    expect(scoreComponent(strong, "traceability")).toMatchObject({ score: 15, evidence: "Linked issues #1, #2." });
    expect(scoreComponent(strong, "related_work")).toMatchObject({ score: 14, evidence: "1 scoped overlap found.", action: "Review top overlaps." });
    expect(scoreComponent(strong, "change_scope")).toMatchObject({ score: 20, action: "No action." });
    expect(scoreComponent(strong, "validation")).toMatchObject({ score: 25, evidence: "PR body includes validation/test evidence." });
    expect(scoreComponent(strong, "queue_pressure")).toMatchObject({ score: 10, action: "No action." });

    const draftPr = pr(directRepo.fullName, 41, "Unlinked feature", {
      body: "",
      labels: [],
      linkedIssues: [],
      isDraft: true,
    });
    const missingValidation = buildPublicReadinessScore({
      pr: draftPr,
      preflight: {
        ...readyPreflight,
        status: "needs_work",
        reviewBurden: "medium",
        findings: [{ code: "missing_tests", severity: "warning", title: "Tests missing", detail: "No tests found." }],
      },
      queueHealth: queueHealthFixture(directRepo.fullName, "high"),
      linkedDuplicatePrs: [3, 4],
    });

    expect(scoreComponent(missingValidation, "traceability")).toMatchObject({ score: 8, action: "Explain no-issue PR." });
    expect(scoreComponent(missingValidation, "related_work")).toMatchObject({ score: 8, evidence: "Same linked issue with #3, #4.", action: "Compare #3, #4." });
    expect(scoreComponent(missingValidation, "change_scope")).toMatchObject({ score: 14, action: "Add scope summary." });
    expect(scoreComponent(missingValidation, "validation")).toMatchObject({ score: 10, evidence: "No cached test files or validation note found.", action: "Add validation note." });
    expect(scoreComponent(missingValidation, "pr_state")).toMatchObject({ score: 6, evidence: "PR is open as draft.", action: "Mark ready when done." });
    expect(scoreComponent(missingValidation, "queue_pressure")).toMatchObject({ score: 5, action: "Expect slower review." });

    const closedPr = pr(directRepo.fullName, 42, "Closed cleanup", { state: "closed", body: "cleanup", linkedIssues: [] });
    const weak = buildPublicReadinessScore({
      pr: closedPr,
      preflight: { ...readyPreflight, status: "needs_work", reviewBurden: "high", findings: [] },
      queueHealth: queueHealthFixture(directRepo.fullName, "critical"),
    });

    expect(scoreComponent(weak, "validation")).toMatchObject({ score: 12, evidence: "Cached preflight status needs author follow-up." });
    expect(scoreComponent(weak, "pr_state")).toMatchObject({ score: 3, evidence: "PR state is closed.", action: "No action." });
    expect(scoreComponent(weak, "queue_pressure")).toMatchObject({ score: 3, action: "Expect slower review." });
  });

  it("keeps the public PR queue row coherent for zero and sampled queue evidence", () => {
    const directRepo = repo("owner/queue-panel");
    const currentPr = pr(directRepo.fullName, 43, "Fix queue display", {
      body: "Fixes #7\n\nValidation: npm test",
      linkedIssues: [7],
    });
    const preflight = buildPreflightResult(
      { repoFullName: directRepo.fullName, title: currentPr.title, body: currentPr.body ?? undefined, labels: currentPr.labels, linkedIssues: currentPr.linkedIssues },
      directRepo,
      [],
      [currentPr],
    );
    const zeroEvidenceCriticalQueue: QueueHealth = {
      ...queueHealthFixture(directRepo.fullName, "critical"),
      signals: {
        ...queueHealthFixture(directRepo.fullName, "critical").signals,
        openPullRequests: 0,
        unlinkedPullRequests: 0,
        stalePullRequests: 0,
        ageBuckets: { under7Days: 0, days7To30: 0, over30Days: 0 },
        likelyReviewablePullRequests: 0,
      },
    };
    const zeroScore = buildPublicReadinessScore({
      pr: currentPr,
      preflight: { ...preflight, status: "ready", reviewBurden: "low", findings: [] },
      queueHealth: zeroEvidenceCriticalQueue,
    });
    expect(scoreComponent(zeroScore, "queue_pressure")).toMatchObject({
      score: 10,
      evidence: "0 open PR(s), 0 likely reviewable.",
      action: "No action.",
    });

    const staleQueuePullRequests = [44, 45, 46, 47].map((number) =>
      pr(directRepo.fullName, number, `Stale unlinked queue item ${number}`, {
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    const criticalBurdenQueue = buildQueueHealth(
      directRepo,
      [],
      staleQueuePullRequests,
      buildCollisionReport(directRepo.fullName, [], staleQueuePullRequests),
    );
    expect(criticalBurdenQueue).toMatchObject({ level: "critical", burdenScore: 100 });

    const criticalBurdenScore = buildPublicReadinessScore({
      pr: currentPr,
      preflight: { ...preflight, status: "ready", reviewBurden: "low", findings: [] },
      queueHealth: criticalBurdenQueue,
    });
    expect(scoreComponent(criticalBurdenScore, "queue_pressure")).toMatchObject({
      score: 3,
      evidence: "4 open PR(s), 0 likely reviewable, 4 stale, 4 unlinked.",
      action: "Expect slower review.",
    });

    const sampledQueue = buildQueueHealth(
      directRepo,
      [],
      [currentPr],
      buildCollisionReport(directRepo.fullName, [], [currentPr]),
      { openPullRequests: 25 },
    );
    const sampledScore = buildPublicReadinessScore({
      pr: currentPr,
      preflight: { ...preflight, status: "ready", reviewBurden: "low", findings: [] },
      queueHealth: sampledQueue,
    });
    expect(scoreComponent(sampledScore, "queue_pressure")).toMatchObject({ score: 3, action: "Expect slower review." });
    expect(scoreComponent(sampledScore, "queue_pressure").evidence).toContain("1 likely reviewable in 1 cached PR(s); full queue reviewability is sampled");
  });

  it("filters disabled linked-issue findings and uses fallback next steps when the panel is clean", () => {
    const directRepo = repo("owner/clean-panel");
    const currentPr = pr(directRepo.fullName, 50, "Fix documented bug", {
      body: "Fixes #10\n\nValidation: npm test",
      linkedIssues: [10],
    });
    const profile = buildContributorProfile("dev", { login: "dev", topLanguages: ["TypeScript"], source: "github" }, [currentPr], []);
    const preflight = {
      ...buildPreflightResult(
        { repoFullName: directRepo.fullName, title: currentPr.title, body: currentPr.body ?? undefined, linkedIssues: currentPr.linkedIssues },
        directRepo,
        [],
        [currentPr],
      ),
      status: "ready" as const,
      reviewBurden: "low" as const,
      findings: [
        { code: "missing_linked_issue", severity: "warning" as const, title: "No linked issue detected", detail: "Should be hidden when linked issue gate is off." },
        { code: "private_reward", severity: "warning" as const, title: "Reward wallet", detail: "wallet reward", action: "secret" },
      ],
    };
    const comment = buildPublicPrIntelligenceComment({
      repo: directRepo,
      pr: currentPr,
      profile,
      detection: { detected: false, reason: "no official match", priorPullRequests: 0, priorMergedPullRequests: 0, priorIssues: 0 },
      queueHealth: queueHealthFixture(directRepo.fullName, "low"),
      collisions: buildCollisionReport(directRepo.fullName, [], [currentPr]),
      preflight,
      settings: { ...repoSettings(directRepo.fullName), linkedIssueGateMode: "off" },
    });

    expect(comment).toContain("Gittensory PR readiness looks good");
    expect(comment).toContain("- No public-safe advisory findings were generated from cached metadata.");
    expect(comment).toContain("- Keep the PR focused and include validation evidence before maintainer review.");
    expect(comment).not.toMatch(/No linked issue detected|reward|wallet/i);
  });

  it("audits label ordering and suspicious configured labels deterministically", () => {
    const directRepo = repo("owner/direct", { labelMultipliers: { bug: 1.2, feature: 1.1, "status:ready": 1.05 }, trustedLabelPipeline: true });
    const labels: RepoLabelRecord[] = [
      { repoFullName: directRepo.fullName, name: "feature", isConfigured: true, observedCount: 1, payload: {}, lastSeenAt: "2026-05-25T00:00:00.000Z" },
      { repoFullName: directRepo.fullName, name: "bug", isConfigured: true, observedCount: 1, payload: {}, lastSeenAt: "2026-05-25T00:00:00.000Z" },
      { repoFullName: directRepo.fullName, name: "status:ready", isConfigured: true, observedCount: 0, payload: {}, lastSeenAt: "2026-05-25T00:00:00.000Z" },
    ];
    const audit = buildLabelAudit(
      directRepo,
      labels,
      [issue(directRepo.fullName, 1, "Feature", { labels: ["feature"] })],
      [pr(directRepo.fullName, 2, "Bug", { labels: ["bug"] })],
      directRepo.fullName,
    );

    expect(audit.observedLabels.slice(0, 2).map((label) => label.name)).toEqual(["bug", "feature"]);
    expect(audit.findings.map((finding) => finding.code)).toContain("suspicious_configured_labels");
  });

  it("awards the personalFit language bonus only on a real repo-language match", () => {
    const targetRepo = repo("owner/lang-fit");
    const profile = buildContributorProfile("dev", { login: "dev", topLanguages: ["TypeScript"], source: "github" }, [], []);
    const history = buildContributorOutcomeHistory({
      login: "dev",
      profile,
      repositories: [targetRepo],
      pullRequests: [],
      issues: [],
      repoStats: [],
    });
    const fit = buildContributorFit(profile, [targetRepo], [], [], [], []);
    const scoringProfile = buildContributorScoringProfile({ login: "dev", fit, scoringSnapshot: scoringSnapshot() });
    const base = {
      login: "dev",
      repo: targetRepo,
      repoFullName: targetRepo.fullName,
      profile,
      outcomeHistory: history,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: [],
    };

    // Match is case-insensitive ("TypeScript" vs the contributor's "typescript").
    const matched = buildRepoRewardRisk({ ...base, repoLanguage: "TypeScript" });
    // Off-language repo: the contributor does not work in Rust, so no bonus.
    const offLanguage = buildRepoRewardRisk({ ...base, repoLanguage: "Rust" });
    // Unknown repo language: nothing to compare, so no bonus (must not fall back to a presence-only check).
    const unknownLanguage = buildRepoRewardRisk({ ...base, repoLanguage: null });

    const fitOf = (result: ReturnType<typeof buildRepoRewardRisk>) => result.actions[0]?.personalFitScore;
    expect(fitOf(matched)).toBe((fitOf(offLanguage) ?? 0) + 10);
    expect(fitOf(unknownLanguage)).toBe(fitOf(offLanguage));
  });
});

function repo(fullName: string, overrides: Partial<RegistryRepoConfig> = {}): RepositoryRecord {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    fullName,
    owner,
    name,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    defaultBranch: "main",
    registryConfig: {
      repo: fullName,
      emissionShare: 0.02,
      issueDiscoveryShare: 0,
      labelMultipliers: {},
      trustedLabelPipeline: false,
      maintainerCut: 0,
      raw: {},
      ...overrides,
    },
  };
}

function issue(repoFullName: string, number: number, title: string, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "reporter",
    authorAssociation: "NONE",
    labels: [],
    linkedPrs: [],
    body: "Detailed issue body with reproduction steps and expected behavior.",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function pr(repoFullName: string, number: number, title: string, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "dev",
    authorAssociation: "NONE",
    labels: [],
    linkedIssues: [],
    body: "",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function repoSettings(repoFullName: string): RepositorySettings {
  return {
    repoFullName,
    commentMode: "detected_contributors_only",
    publicAudienceMode: "oss_maintainer",
    publicSignalLevel: "standard",
    checkRunMode: "off",
    checkRunDetailLevel: "minimal",
    gateCheckMode: "off",
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
  };
}

function scoringSnapshot(): ScoringModelSnapshotRecord {
  return {
    id: "coverage-scoring",
    sourceKind: "test",
    sourceUrl: "fixture://coverage",
    fetchedAt: "2026-05-25T00:00:00.000Z",
    activeModel: "current_density_model",
    constants: {},
    programmingLanguages: {},
    warnings: [],
    payload: {},
  };
}

function queueHealthFixture(repoFullName: string, level: QueueHealth["level"]): QueueHealth {
  return {
    repoFullName,
    generatedAt: "2026-05-25T00:00:00.000Z",
    burdenScore: 0,
    level,
    summary: `${level} queue`,
    signals: {
      openIssues: 0,
      openPullRequests: level === "low" ? 1 : level === "medium" ? 4 : level === "high" ? 9 : 16,
      unlinkedPullRequests: 0,
      stalePullRequests: 0,
      maintainerAuthoredPullRequests: 0,
      collisionClusters: 0,
      ageBuckets: { under7Days: 0, days7To30: 0, over30Days: 0 },
      likelyReviewablePullRequests: level === "low" ? 1 : level === "medium" ? 3 : level === "high" ? 6 : 10,
    },
    findings: [],
  };
}

function scoreComponent(score: ReturnType<typeof buildPublicReadinessScore>, key: ReturnType<typeof buildPublicReadinessScore>["components"][number]["key"]) {
  const component = score.components.find((item) => item.key === key);
  expect(component).toBeDefined();
  return component!;
}

function officialSnapshot(): GittensorContributorSnapshot {
  return {
    source: "gittensor_api",
    githubId: "49853598",
    githubUsername: "JSONbored",
    uid: 29,
    hotkey: "private-hotkey",
    isEligible: true,
    credibility: 1,
    eligibleRepoCount: 1,
    issueDiscoveryScore: 0,
    issueTokenScore: 0,
    issueCredibility: 1,
    isIssueEligible: false,
    issueEligibleRepoCount: 0,
    alphaPerDay: 1,
    taoPerDay: 1,
    usdPerDay: 1,
    totals: {
      pullRequests: 29,
      mergedPullRequests: 20,
      openPullRequests: 4,
      closedPullRequests: 5,
      openIssues: 4,
      closedIssues: 2,
      solvedIssues: 1,
      validSolvedIssues: 1,
    },
    repositories: [
      {
        repoFullName: "owner/readiness",
        pullRequests: 29,
        mergedPullRequests: 20,
        openPullRequests: 4,
        closedPullRequests: 5,
        openIssues: 4,
        closedIssues: 2,
        solvedIssues: 1,
        validSolvedIssues: 1,
        isEligible: true,
        isIssueEligible: false,
        credibility: 1,
        issueCredibility: 1,
        totalScore: 1,
        baseTotalScore: 1,
      },
    ],
    pullRequests: [],
    issueLabels: [],
  };
}
