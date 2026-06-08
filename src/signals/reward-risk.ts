import type { ScorePreviewResult } from "../scoring/preview";
import { buildScorePreview } from "../scoring/preview";
import type {
  CheckSummaryRecord,
  IssueRecord,
  PullRequestFileRecord,
  PullRequestRecord,
  PullRequestReviewRecord,
  RecentMergedPullRequestRecord,
  RepositoryRecord,
  ScoringModelSnapshotRecord,
} from "../types";
import { nowIso } from "../utils/json";
import {
  buildCollisionReport,
  buildContributorIntakeHealth,
  buildLaneAdvice,
  buildPullRequestReviewIntelligence,
  buildQueueHealth,
  buildRepoFitRecommendation,
  buildRoleContext,
  type ContributorFit,
  type ContributorOutcomeHistory,
  type ContributorProfile,
  type ContributorScoringProfile,
  type LaneAdvice,
  type ParticipationLane,
  type QueueHealth,
  type RepoFitRecommendation,
  type RoleContext,
} from "./engine";

export type RewardRiskActionKind =
  | "cleanup_existing_prs"
  | "land_existing_prs"
  | "close_or_withdraw_low_fit_prs"
  | "open_new_direct_pr"
  | "file_issue_discovery"
  | "maintainer_lane_improve_repo"
  | "maintainer_cut_readiness";

const ACTION_RANK: Record<RewardRiskActionKind, number> = {
  cleanup_existing_prs: 0,
  land_existing_prs: 1,
  close_or_withdraw_low_fit_prs: 2,
  open_new_direct_pr: 3,
  file_issue_discovery: 4,
  maintainer_lane_improve_repo: 5,
  maintainer_cut_readiness: 6,
};

export type RewardRiskAction = {
  actionKind: RewardRiskActionKind;
  repoFullName: string;
  priorityScore: number;
  laneValueScore: number;
  scoreabilityScore: number;
  personalFitScore: number;
  riskPenalty: number;
  maintainerFrictionPenalty: number;
  actionLeverageScore: number;
  whyThisHelps: string[];
  nextActions: string[];
};

export type RepoRewardRisk = {
  login: string;
  repoFullName: string;
  generatedAt: string;
  roleContext: RoleContext;
  lane: LaneAdvice;
  recommendation: RepoFitRecommendation["recommendation"];
  rewardUpside: {
    relevantLane: "direct_pr" | "issue_discovery" | "maintainer_lane" | "none";
    repoSlice: number;
    directPrSlice: number;
    issueDiscoverySlice: number;
    maintainerCutSlice: number;
    labelMultiplier: number;
    issueMultiplier: number;
    estimatedScoreIfClean: number;
    currentEstimatedScore: number;
  };
  scoreBlockers: string[];
  riskBreakdown: {
    queueBurden: QueueHealth["level"];
    queueBurdenScore: number;
    duplicateClusters: number;
    highRiskDuplicateClusters: number;
    closedPullRequestRate: number;
    openPullRequests: number;
    credibility: number;
    reviewChurnRisk: "low" | "medium" | "high";
  };
  actionImpact: {
    currentOpenPrCount: number;
    openPrThreshold: number;
    openPrMultiplierDelta: string;
    estimatedScoreDelta: string;
    cleanupNeeded: number;
    explanation: string;
  };
  currentPreview: ScorePreviewResult;
  afterCleanupPreview: ScorePreviewResult;
  actions: RewardRiskAction[];
  whyThisHelps: string[];
  nextActions: string[];
  summary: string;
};

export type ContributorRewardRiskStrategy = {
  login: string;
  generatedAt: string;
  scoringModelSnapshotId: string;
  summary: string;
  topActions: RewardRiskAction[];
  repoAnalyses: RepoRewardRisk[];
  reasoning: string[];
  actionImpact: string[];
  nextActions: string[];
};

export type MaintainerNoiseReport = {
  repoFullName: string;
  generatedAt: string;
  score: number;
  level: "low" | "medium" | "high" | "critical";
  noiseSources: string[];
  maintainerActions: Array<"review_now" | "needs_author" | "likely_duplicate" | "close_or_redirect" | "watch" | "maintainer_lane">;
  queueHealth: QueueHealth;
  summary: string;
};

export type PullRequestReviewability = {
  repoFullName: string;
  pullNumber: number;
  generatedAt: string;
  score: number;
  action: "review_now" | "needs_author" | "likely_duplicate" | "close_or_redirect" | "watch" | "maintainer_lane";
  noiseSources: string[];
  whyThisHelps: string[];
  maintainerNextSteps: string[];
  privateSummary: string;
};

export function buildRepoRewardRisk(args: {
  login: string;
  repo: RepositoryRecord | null;
  repoFullName: string;
  profile: ContributorProfile;
  outcomeHistory: ContributorOutcomeHistory;
  scoringSnapshot: ScoringModelSnapshotRecord;
  scoringProfile?: ContributorScoringProfile | null | undefined;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  recentMergedPullRequests?: RecentMergedPullRequestRecord[] | undefined;
  /** Repo primary language (from sync metadata / ContributorFit.languageFit),
   *  used for the personalFit language-match bonus. */
  repoLanguage?: string | null | undefined;
}): RepoRewardRisk {
  const roleContext = buildRoleContext({
    login: args.login,
    repo: args.repo,
    repoFullName: args.repoFullName,
    pullRequests: args.pullRequests,
    issues: args.issues,
    profile: args.profile,
  });
  const lane = buildLaneAdvice(args.repo, args.repoFullName);
  const repoOutcome = args.outcomeHistory.repoOutcomes.find((outcome) => sameRepo(outcome.repoFullName, args.repoFullName));
  const collisions = buildCollisionReport(args.repoFullName, args.issues, args.pullRequests, args.recentMergedPullRequests ?? []);
  const queueHealth = buildQueueHealth(args.repo, args.issues, args.pullRequests, collisions);
  const recommendation = buildRepoFitRecommendation({
    login: args.login,
    repo: args.repo,
    repoFullName: args.repoFullName,
    profile: args.profile,
    outcomeHistory: args.outcomeHistory,
    issues: args.issues,
    pullRequests: args.pullRequests,
  }).recommendation;

  const labels = bestFitLabels(args.repo);
  const currentOpenPrCount = nonNegative(args.outcomeHistory.totals.openPullRequests);
  /* v8 ignore next -- Credibility fallback order protects sparse private snapshots; behavior is covered through scoring profile tests. */
  const credibility = repoOutcome?.credibility && repoOutcome.credibility > 0 ? repoOutcome.credibility : args.scoringProfile?.evidence.credibilityAssumption ?? args.outcomeHistory.totals.credibility ?? 0.8;
  const commonPreviewInput = {
    repoFullName: args.repoFullName,
    targetType: "planned_pr" as const,
    targetKey: `${args.login}:${args.repoFullName}:reward-risk`,
    contributorLogin: args.login,
    labels,
    linkedIssueMode: lane.lane === "issue_discovery" ? ("none" as const) : ("standard" as const),
    sourceTokenScore: estimatedSourceTokenScore(repoOutcome),
    totalTokenScore: estimatedTotalTokenScore(repoOutcome),
    sourceLines: estimatedSourceLines(repoOutcome),
    existingContributorTokenScore: 0,
    credibility,
    metadataOnly: true,
    duplicateRiskCount: collisions.summary.highRiskCount,
  };
  const currentPreview = buildScorePreview({
    input: { ...commonPreviewInput, openPrCount: currentOpenPrCount },
    repo: args.repo,
    snapshot: args.scoringSnapshot,
  });
  const cleanupOpenPrCount = Math.min(currentOpenPrCount, currentPreview.gates.openPrThreshold);
  const afterCleanupPreview = buildScorePreview({
    input: { ...commonPreviewInput, openPrCount: cleanupOpenPrCount },
    repo: args.repo,
    snapshot: args.scoringSnapshot,
  });

  const relevantLane = relevantLaneFor(lane, roleContext);
  const laneValueScore = laneValue(lane, currentPreview, relevantLane);
  const personalFitScore = personalFit(repoOutcome, args.scoringProfile, roleContext, args.profile, args.repoLanguage ?? null);
  const riskPenalty = riskScore(repoOutcome, queueHealth, collisions.summary.clusterCount, collisions.summary.highRiskCount, currentOpenPrCount, currentPreview.gates.openPrThreshold);
  const maintainerFrictionPenalty = maintainerFriction(queueHealth, collisions.summary.clusterCount, args.pullRequests);
  const scoreBlockers = scoreBlockersFor({
    lane,
    roleContext,
    currentPreview,
    repo: args.repo,
    repoOutcome,
    currentOpenPrCount,
  });
  const scoreabilityScore = scoreBlockers.length > 0 ? 0 : clamp((currentPreview.scoreEstimate.estimatedMergedScore / 50) * 100, 0, 100);
  const actionLeverageScore = cleanupOpenPrCount < currentOpenPrCount ? clamp((currentOpenPrCount - cleanupOpenPrCount) * 18, 30, 100) : 0;
  const baseActionInput = {
    repoFullName: args.repoFullName,
    laneValueScore,
    scoreabilityScore,
    personalFitScore,
    riskPenalty,
    maintainerFrictionPenalty,
    actionLeverageScore,
  };
  const cleanupNeeded = Math.max(0, currentOpenPrCount - currentPreview.gates.openPrThreshold);
  const actions = buildActions({
    ...baseActionInput,
    lane,
    roleContext,
    repoOutcome,
    currentPreview,
    afterCleanupPreview,
    cleanupNeeded,
    scoreBlockers,
    queueHealth,
    collisionsHighRiskCount: collisions.summary.highRiskCount,
  });
  const actionImpact = {
    currentOpenPrCount,
    openPrThreshold: currentPreview.gates.openPrThreshold,
    openPrMultiplierDelta: `${currentPreview.scoreEstimate.openPrMultiplier} -> ${afterCleanupPreview.scoreEstimate.openPrMultiplier}`,
    estimatedScoreDelta: `${currentPreview.scoreEstimate.estimatedMergedScore} -> ${afterCleanupPreview.scoreEstimate.estimatedMergedScore}`,
    cleanupNeeded,
    explanation:
      cleanupNeeded > 0
        ? `Landing, closing, or withdrawing ${cleanupNeeded} open PR(s) moves the current open-PR gate from blocked toward scoreable future work.`
        : "Open PR pressure is not the primary scoreability blocker for this repo right now.",
  };
  const whyThisHelps = whyThisHelpsFor({
    repoFullName: args.repoFullName,
    lane,
    roleContext,
    repoOutcome,
    currentPreview,
    afterCleanupPreview,
    cleanupNeeded,
    scoreBlockers,
    queueHealth,
    collisionsHighRiskCount: collisions.summary.highRiskCount,
  });
  const nextActions = [...new Set(actions.flatMap((action) => action.nextActions))].slice(0, 8);

  return {
    login: args.login,
    repoFullName: args.repoFullName,
    generatedAt: nowIso(),
    roleContext,
    lane,
    recommendation,
    rewardUpside: {
      relevantLane,
      repoSlice: currentPreview.laneMath.repoSlice,
      directPrSlice: currentPreview.laneMath.directPrSlice,
      issueDiscoverySlice: currentPreview.laneMath.issueDiscoverySlice,
      maintainerCutSlice: round((args.repo?.registryConfig?.maintainerCut ?? 0) * currentPreview.laneMath.repoSlice),
      labelMultiplier: currentPreview.scoreEstimate.labelMultiplier,
      issueMultiplier: currentPreview.scoreEstimate.issueMultiplier,
      estimatedScoreIfClean: afterCleanupPreview.scoreEstimate.estimatedMergedScore,
      currentEstimatedScore: currentPreview.scoreEstimate.estimatedMergedScore,
    },
    scoreBlockers,
    riskBreakdown: {
      queueBurden: queueHealth.level,
      queueBurdenScore: queueHealth.burdenScore,
      duplicateClusters: collisions.summary.clusterCount,
      highRiskDuplicateClusters: collisions.summary.highRiskCount,
      closedPullRequestRate: repoOutcome?.closedPullRequestRate ?? args.outcomeHistory.totals.closedPullRequestRate,
      openPullRequests: currentOpenPrCount,
      credibility,
      reviewChurnRisk: reviewChurnRisk(repoOutcome, queueHealth, collisions.summary.highRiskCount),
    },
    actionImpact,
    currentPreview,
    afterCleanupPreview,
    actions,
    whyThisHelps,
    nextActions: nextActions.length > 0 ? nextActions : ["Gather fresher repo and contributor evidence before acting."],
    summary: `${args.repoFullName}: ${scoreBlockers.length > 0 ? "blocked or cautionary" : "scoreable"} private reward/risk context; top action ${actions[0]?.actionKind ?? "none"}.`,
  };
}

export function buildContributorRewardRiskStrategy(args: {
  login: string;
  fit: ContributorFit;
  scoringProfile: ContributorScoringProfile;
  scoringSnapshot: ScoringModelSnapshotRecord;
  outcomeHistory: ContributorOutcomeHistory;
  repositories: RepositoryRecord[];
  allIssues: IssueRecord[];
  allPullRequests: PullRequestRecord[];
  recentMergedPullRequests?: RecentMergedPullRequestRecord[] | undefined;
}): ContributorRewardRiskStrategy {
  const registeredRepoNames = new Map(args.repositories.filter((repo) => repo.isRegistered).map((repo) => [repo.fullName.toLowerCase(), repo.fullName]));
  const candidateRepoNames = uniqueRegisteredRepoNames(
    [
    ...args.fit.opportunities.map((opportunity) => opportunity.repoFullName),
      ...args.outcomeHistory.repoOutcomes.filter((outcome) => registeredRepoNames.has(outcome.repoFullName.toLowerCase())).map((outcome) => outcome.repoFullName),
    ...args.repositories.filter((repo) => repo.isRegistered).map((repo) => repo.fullName),
    ],
    registeredRepoNames,
  );
  const repoAnalyses = candidateRepoNames
    .map((repoFullName) => {
      /* v8 ignore next -- Strategy inputs usually originate from repository records; null protects stale fit snapshots. */
      const repo = args.repositories.find((candidate) => sameRepo(candidate.fullName, repoFullName)) ?? null;
      return buildRepoRewardRisk({
        login: args.login,
        repo,
        repoFullName,
        profile: args.fit.profile,
        outcomeHistory: args.outcomeHistory,
        scoringSnapshot: args.scoringSnapshot,
        scoringProfile: args.scoringProfile,
        issues: args.allIssues.filter((issue) => sameRepo(issue.repoFullName, repoFullName)),
        pullRequests: args.allPullRequests.filter((pr) => sameRepo(pr.repoFullName, repoFullName)),
        recentMergedPullRequests: (args.recentMergedPullRequests ?? []).filter((pr) => sameRepo(pr.repoFullName, repoFullName)),
        repoLanguage: args.fit.languageFit.find((entry) => sameRepo(entry.repoFullName, repoFullName))?.language ?? null,
      });
    })
    /* v8 ignore next -- Locale tie ordering is deterministic presentation fallback after ranked analysis scores. */
    .sort((left, right) => analysisRank(right) - analysisRank(left) || left.repoFullName.localeCompare(right.repoFullName))
    .slice(0, 20);
  const topActions = repoAnalyses
    .flatMap((analysis) => analysis.actions)
    /* v8 ignore next -- Secondary sort keys make ties deterministic; priority ordering is covered by strategy tests. */
    .sort((left, right) => right.priorityScore - left.priorityScore || ACTION_RANK[left.actionKind] - ACTION_RANK[right.actionKind] || left.repoFullName.localeCompare(right.repoFullName))
    .slice(0, 12);
  const reasoning = [
    ...topActions.slice(0, 5).flatMap((action) => action.whyThisHelps.map((reason) => `${action.repoFullName}: ${reason}`)),
    ...repoAnalyses
      .filter((analysis) => analysis.roleContext.maintainerLane)
      .slice(0, 4)
      .map((analysis) => `${analysis.repoFullName}: maintainer-lane economics are separate from normal contributor rewards.`),
  ];
  const actionImpact = repoAnalyses
    .filter((analysis) => analysis.actionImpact.cleanupNeeded > 0 || analysis.currentPreview.scoreEstimate.estimatedMergedScore !== analysis.afterCleanupPreview.scoreEstimate.estimatedMergedScore)
    .slice(0, 8)
    .map((analysis) => `${analysis.repoFullName}: ${analysis.actionImpact.explanation} Score preview ${analysis.actionImpact.estimatedScoreDelta}; openPrMultiplier ${analysis.actionImpact.openPrMultiplierDelta}.`);
  const nextActions = [...new Set(topActions.flatMap((action) => action.nextActions))].slice(0, 10);
  return {
    login: args.login,
    generatedAt: nowIso(),
    scoringModelSnapshotId: args.scoringSnapshot.id,
    summary: `${args.login} has ${topActions.length} ranked reward/risk action(s) from ${repoAnalyses.length} repo analysis record(s).`,
    topActions,
    repoAnalyses,
    reasoning: [...new Set(reasoning)],
    actionImpact,
    nextActions: nextActions.length > 0 ? nextActions : ["Refresh official Gittensor and GitHub backfill data, then rerun strategy."],
  };
}

export function buildMaintainerNoiseReport(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  recentMergedPullRequests: RecentMergedPullRequestRecord[],
  fullName: string,
): MaintainerNoiseReport {
  const collisions = buildCollisionReport(fullName, issues, pullRequests, recentMergedPullRequests);
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
  const intake = buildContributorIntakeHealth(repo, issues, pullRequests, fullName, collisions);
  const unlinked = pullRequests.filter((pr) => pr.state === "open" && pr.linkedIssues.length === 0).length;
  const broadDiffSignals = pullRequests.filter((pr) => pr.title.length > 120 || /refactor|cleanup|misc|various/i.test(pr.title)).length;
  const noiseSources = [
    ...(unlinked > 0 ? [`${unlinked} open PR(s) lack linked issue context.`] : []),
    ...(collisions.summary.highRiskCount > 0 ? [`${collisions.summary.highRiskCount} high-risk duplicate/WIP cluster(s).`] : []),
    ...(queueHealth.signals.stalePullRequests > 0 ? [`${queueHealth.signals.stalePullRequests} stale PR(s) add queue drag.`] : []),
    ...(broadDiffSignals > 0 ? [`${broadDiffSignals} PR(s) look broad or hard to triage from title metadata.`] : []),
    ...(intake.level === "strained" || intake.level === "blocked" ? [`Contributor intake is ${intake.level}.`] : []),
  ];
  const score = clamp(100 - queueHealth.burdenScore * 0.55 - collisions.summary.highRiskCount * 12 - unlinked * 6 - broadDiffSignals * 4, 0, 100);
  const level: MaintainerNoiseReport["level"] = score < 25 ? "critical" : score < 50 ? "high" : score < 75 ? "medium" : "low";
  const maintainerActions: MaintainerNoiseReport["maintainerActions"] = [
    ...(collisions.summary.highRiskCount > 0 ? ["likely_duplicate" as const] : []),
    ...(unlinked > 0 || queueHealth.signals.stalePullRequests > 0 ? ["needs_author" as const] : []),
    ...(queueHealth.signals.likelyReviewablePullRequests > 0 ? ["review_now" as const] : []),
    ...(noiseSources.length === 0 ? ["watch" as const] : []),
  ];
  return {
    repoFullName: fullName,
    generatedAt: nowIso(),
    score: round(score),
    level,
    noiseSources: noiseSources.length > 0 ? noiseSources : ["No major maintainer-noise source detected in cached metadata."],
    maintainerActions: [...new Set(maintainerActions)],
    queueHealth,
    summary: `${fullName} maintainer noise is ${level}; queue ${queueHealth.level}, ${collisions.summary.highRiskCount} high-risk collision cluster(s), ${unlinked} unlinked open PR(s).`,
  };
}

export function buildPullRequestReviewability(args: {
  repo: RepositoryRecord | null;
  pullRequest: PullRequestRecord | null;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  files: PullRequestFileRecord[];
  reviews: PullRequestReviewRecord[];
  checks: CheckSummaryRecord[];
  recentMergedPullRequests: RecentMergedPullRequestRecord[];
  repoFullName: string;
  pullNumber: number;
  profile?: ContributorProfile | null | undefined;
  outcomeHistory?: ContributorOutcomeHistory | null | undefined;
}): PullRequestReviewability {
  const intelligence = buildPullRequestReviewIntelligence(args);
  const pr = args.pullRequest;
  const failingChecks = args.checks.filter((check) => ["failure", "timed_out", "cancelled"].includes(check.conclusion ?? "")).length;
  const broadDiff = intelligence.changeSummary.fileCount >= 12 || intelligence.changeSummary.additions + intelligence.changeSummary.deletions >= 800;
  const noiseSources = [
    ...(pr?.state && pr.state !== "open" ? [`PR is ${pr.state}.`] : []),
    ...(intelligence.reviewSignals.linkedIssues.length === 0 ? ["Missing linked issue or no-issue rationale."] : []),
    ...(intelligence.reviewSignals.collisionClusters > 0 ? [`${intelligence.reviewSignals.collisionClusters} duplicate/WIP collision cluster(s).`] : []),
    ...(intelligence.changeSummary.codeFileCount > 0 && intelligence.changeSummary.testFileCount === 0 ? ["Code changes do not include cached test files."] : []),
    ...(failingChecks > 0 ? [`${failingChecks} failing or cancelled check(s).`] : []),
    ...(broadDiff ? ["Diff is broad enough to create avoidable review friction."] : []),
    ...(intelligence.outcomeContext && !intelligence.roleContext.maintainerLane && intelligence.outcomeContext.closedPullRequestRate >= 0.35
      ? [`Contributor repo-specific closed PR rate is ${percent(intelligence.outcomeContext.closedPullRequestRate)}.`]
      : []),
  ];
  const score = clamp(
    100 -
      noiseSources.length * 14 -
      intelligence.reviewSignals.collisionClusters * 12 -
      failingChecks * 18 -
      (broadDiff ? 18 : 0) +
      (intelligence.reviewSignals.approvalCount > 0 ? 12 : 0),
    0,
    100,
  );
  const action: PullRequestReviewability["action"] = intelligence.roleContext.maintainerLane
    ? "maintainer_lane"
    : pr?.state && pr.state !== "open"
      ? "close_or_redirect"
      : intelligence.reviewSignals.collisionClusters > 0
        ? "likely_duplicate"
        : score >= 75
          ? "review_now"
          : score >= 45
            ? "needs_author"
            : "watch";
  const whyThisHelps = [
    ...(action === "review_now" ? ["Reviewing now is efficient because cached signals show linked context and manageable friction."] : []),
    ...(action === "needs_author" ? ["Asking for author cleanup first reduces maintainer review time before deep technical review."] : []),
    ...(action === "likely_duplicate" ? ["Checking overlap first prevents maintainers from reviewing duplicate or soon-obsolete work."] : []),
    ...(action === "maintainer_lane" ? ["Maintainer-authored work should be reviewed as repo stewardship, not outside-contributor triage."] : []),
    ...(action === "close_or_redirect" ? ["Closed or non-open PRs should be redirected before consuming review time."] : []),
    ...(action === "watch" ? ["Watching is lower-cost until checks, tests, issue links, or overlap signals improve."] : []),
  ];
  return {
    repoFullName: args.repoFullName,
    pullNumber: args.pullNumber,
    generatedAt: nowIso(),
    score: round(score),
    action,
    noiseSources: noiseSources.length > 0 ? noiseSources : ["No major reviewability blocker detected in cached metadata."],
    whyThisHelps,
    maintainerNextSteps: maintainerNextStepsFor(action, noiseSources),
    privateSummary: `Reviewability ${round(score)}/100; action ${action}; ${noiseSources.length} noise source(s) from cached metadata.`,
  };
}

function buildActions(args: {
  repoFullName: string;
  lane: LaneAdvice;
  roleContext: RoleContext;
  repoOutcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
  currentPreview: ScorePreviewResult;
  afterCleanupPreview: ScorePreviewResult;
  cleanupNeeded: number;
  scoreBlockers: string[];
  queueHealth: QueueHealth;
  collisionsHighRiskCount: number;
  laneValueScore: number;
  scoreabilityScore: number;
  personalFitScore: number;
  riskPenalty: number;
  maintainerFrictionPenalty: number;
  actionLeverageScore: number;
}): RewardRiskAction[] {
  const actions: RewardRiskAction[] = [];
  const openRepoPrs = args.repoOutcome?.openPullRequests ?? 0;
  if (args.roleContext.maintainerLane) {
    actions.push(
      action("maintainer_lane_improve_repo", args, 55 + (100 - args.maintainerFrictionPenalty) * 0.25, [
        "Improves the repo's contributor intake, label/config quality, and review flow instead of treating owner work as normal contributor evidence.",
      ]),
      action("maintainer_cut_readiness", args, 45 + (args.queueHealth.level === "low" ? 20 : 0), [
        "Checks whether maintainer-lane economics are configured clearly enough for repo owners without inflating outside-contributor history.",
      ]),
    );
  }
  if (!args.roleContext.maintainerLane && openRepoPrs > 0) {
    actions.push(
      action("cleanup_existing_prs", args, 30 + args.actionLeverageScore * 0.55 + args.personalFitScore * 0.22 + args.laneValueScore * 0.12 - args.maintainerFrictionPenalty * 0.04, [
        args.cleanupNeeded > 0
          ? `Reduces open PR pressure; current openPrMultiplier ${args.currentPreview.scoreEstimate.openPrMultiplier} can move toward ${args.afterCleanupPreview.scoreEstimate.openPrMultiplier}.`
          : "Keeps repo-specific queue pressure lower before adding more work.",
      ]),
    );
    if (args.lane.lane !== "issue_discovery") {
      actions.push(
        action("land_existing_prs", args, 25 + args.personalFitScore * 0.28 + args.laneValueScore * 0.18 + args.actionLeverageScore * 0.35 - args.riskPenalty * 0.08, [
          "Landing already-open work preserves successful repo-specific evidence and avoids adding new maintainer load.",
        ]),
      );
    }
  }
  if (!args.roleContext.maintainerLane && openRepoPrs > 0 && (args.scoreBlockers.length > 0 || args.riskPenalty >= 55)) {
    actions.push(
      action("close_or_withdraw_low_fit_prs", args, 20 + args.actionLeverageScore * 0.35 + args.riskPenalty * 0.08, [
        "Withdrawing stale or low-fit work can reduce collateral pressure faster than opening new submissions.",
      ]),
    );
  }
  if (!args.roleContext.maintainerLane && (args.lane.lane === "direct_pr" || args.lane.lane === "split")) {
    actions.push(
      action(
        "open_new_direct_pr",
        args,
        18 + args.laneValueScore * 0.22 + args.scoreabilityScore * 0.3 + args.personalFitScore * 0.25 - args.riskPenalty * 0.18 - args.maintainerFrictionPenalty * 0.08,
        args.scoreBlockers.length > 0
          ? ["New PR expected value is low until hard scoreability blockers and maintainer-friction signals are cleared."]
          : ["A tightly scoped, linked, tested direct PR has scoreability and maintainer-fit upside in this lane."],
      ),
    );
  }
  if (!args.roleContext.maintainerLane && (args.lane.lane === "issue_discovery" || args.lane.lane === "split")) {
    actions.push(
      action("file_issue_discovery", args, 18 + args.laneValueScore * 0.28 + (args.lane.lane === "issue_discovery" ? 20 : 0) - args.riskPenalty * 0.16, [
        args.lane.lane === "issue_discovery"
          ? "This repo routes value through issue discovery; direct PR-side work has little or no lane value under current config."
          : "Issue discovery can be viable only for high-proof reports that someone else can solve.",
      ]),
    );
  }
  return actions
    .map((candidate) => ({ ...candidate, priorityScore: round(clamp(candidate.priorityScore, 0, 100)) }))
    /* v8 ignore next -- Secondary action rank is deterministic presentation fallback after priority scoring. */
    .sort((left, right) => right.priorityScore - left.priorityScore || ACTION_RANK[left.actionKind] - ACTION_RANK[right.actionKind]);
}

function action(kind: RewardRiskActionKind, args: {
  repoFullName: string;
  laneValueScore: number;
  scoreabilityScore: number;
  personalFitScore: number;
  riskPenalty: number;
  maintainerFrictionPenalty: number;
  actionLeverageScore: number;
}, priorityScore: number, whyThisHelps: string[]): RewardRiskAction {
  return {
    actionKind: kind,
    repoFullName: args.repoFullName,
    priorityScore,
    laneValueScore: round(args.laneValueScore),
    scoreabilityScore: round(args.scoreabilityScore),
    personalFitScore: round(args.personalFitScore),
    riskPenalty: round(args.riskPenalty),
    maintainerFrictionPenalty: round(args.maintainerFrictionPenalty),
    actionLeverageScore: round(args.actionLeverageScore),
    whyThisHelps,
    nextActions: nextActionsFor(kind),
  };
}

function scoreBlockersFor(args: {
  lane: LaneAdvice;
  roleContext: RoleContext;
  currentPreview: ScorePreviewResult;
  repo: RepositoryRecord | null;
  repoOutcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
  currentOpenPrCount: number;
}): string[] {
  return [
    ...(!args.repo?.isRegistered ? ["Repository is not registered in the local snapshot."] : []),
    ...(args.lane.lane === "inactive" ? ["Repository allocation is inactive."] : []),
    ...(args.lane.lane === "unknown" ? ["Repository lane is unknown."] : []),
    ...(args.roleContext.maintainerLane ? ["Maintainer-lane work is not normal outside-contributor reward evidence."] : []),
    ...(args.currentPreview.laneMath.directPrSlice <= 0 && args.lane.lane === "issue_discovery" ? ["Direct PR-side lane value is disabled for this repo."] : []),
    ...(args.currentOpenPrCount > args.currentPreview.gates.openPrThreshold ? ["Open PR count exceeds the current threshold assumption."] : []),
    ...(args.currentPreview.gates.credibilityObserved < args.currentPreview.gates.credibilityFloor ? ["Credibility assumption is below the current floor."] : []),
    ...((args.repoOutcome?.closedPullRequestRate ?? 0) >= 0.35 ? ["Repo-specific closed PR rate is high enough to create credibility risk."] : []),
  ];
}

function whyThisHelpsFor(args: {
  repoFullName: string;
  lane: LaneAdvice;
  roleContext: RoleContext;
  repoOutcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
  currentPreview: ScorePreviewResult;
  afterCleanupPreview: ScorePreviewResult;
  cleanupNeeded: number;
  scoreBlockers: string[];
  queueHealth: QueueHealth;
  collisionsHighRiskCount: number;
}): string[] {
  return [
    ...(args.cleanupNeeded > 0
      ? [`Cleanup is high leverage because it changes openPrMultiplier ${args.currentPreview.scoreEstimate.openPrMultiplier} -> ${args.afterCleanupPreview.scoreEstimate.openPrMultiplier} and estimated score ${args.currentPreview.scoreEstimate.estimatedMergedScore} -> ${args.afterCleanupPreview.scoreEstimate.estimatedMergedScore}.`]
      : []),
    ...(args.repoOutcome && args.repoOutcome.mergedPullRequests > 0
      ? [`Protects repo-specific credibility where ${args.repoOutcome.mergedPullRequests} merged PR(s) already show fit.`]
      : []),
    ...(args.roleContext.maintainerLane
      ? [`${args.repoFullName} is maintainer lane for this user, so repo-health and maintainer_cut readiness matter more than normal contributor submissions.`]
      : []),
    ...(args.lane.lane === "issue_discovery" ? ["Direct PRs have no PR-side lane value here; issue-discovery quality and closure risk dominate."] : []),
    ...(args.scoreBlockers.length > 0 ? [`Hard blockers: ${args.scoreBlockers.join(" ")}`] : []),
    ...(args.queueHealth.level === "high" || args.queueHealth.level === "critical" ? [`Maintainer queue is ${args.queueHealth.level}; review friction lowers risk-adjusted priority.`] : []),
    ...(args.collisionsHighRiskCount > 0 ? [`${args.collisionsHighRiskCount} high-risk collision cluster(s) must be cleared before new work has good expected value.`] : []),
  ];
}

function relevantLaneFor(lane: LaneAdvice, roleContext: RoleContext): RepoRewardRisk["rewardUpside"]["relevantLane"] {
  if (roleContext.maintainerLane) return "maintainer_lane";
  if (lane.lane === "direct_pr") return "direct_pr";
  if (lane.lane === "issue_discovery") return "issue_discovery";
  if (lane.lane === "split") return "direct_pr";
  return "none";
}

function laneValue(lane: LaneAdvice, preview: ScorePreviewResult, relevantLane: RepoRewardRisk["rewardUpside"]["relevantLane"]): number {
  if (lane.lane === "inactive" || lane.lane === "unknown" || relevantLane === "none") return 0;
  if (relevantLane === "issue_discovery") return clamp(preview.laneMath.issueDiscoverySlice * 1000, 0, 100);
  if (relevantLane === "maintainer_lane") return clamp(preview.laneMath.repoSlice * 800, 0, 100);
  return clamp(preview.laneMath.directPrSlice * 1000, 0, 100);
}

function personalFit(
  outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined,
  scoringProfile: ContributorScoringProfile | null | undefined,
  roleContext: RoleContext,
  profile: ContributorProfile,
  repoLanguage: string | null | undefined,
): number {
  if (roleContext.maintainerLane) return 80;
  // Award the language-fit bonus only when the repo's primary language (sourced
  // from ContributorFit.languageFit, as decision-pack.ts does) is one the
  // contributor actually works in. Previously this granted +10 to any repo
  // whenever the contributor had *any* top language, never comparing the two —
  // so an off-language repo (e.g. a Rust repo for a Python-only contributor) was
  // scored as a language match, inflating personalFit and the action
  // priorityScores derived from it.
  const contributorLanguages = new Set(profile.github.topLanguages.map((language) => language.toLowerCase()));
  const languageMatch = repoLanguage && contributorLanguages.has(repoLanguage.toLowerCase()) ? 10 : 0;
  return clamp(
    (outcome?.mergedPullRequests ?? 0) * 2.2 +
      /* v8 ignore next -- Credibility fallback order protects sparse private snapshots; scoring behavior is covered at public entry points. */
      (outcome?.credibility ?? scoringProfile?.evidence.credibilityAssumption ?? 0.8) * 35 +
      (outcome?.validSolvedIssues ?? 0) * 3 +
      languageMatch -
      (outcome?.closedPullRequestRate ?? 0) * 45 -
      Math.max(0, (outcome?.openPullRequests ?? 0) - 2) * 4,
    0,
    100,
  );
}

function riskScore(
  outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined,
  queueHealth: QueueHealth,
  duplicateClusters: number,
  highRiskDuplicateClusters: number,
  openPrCount: number,
  openPrThreshold: number,
): number {
  const queuePenalty = queueHealth.level === "critical" ? 35 : queueHealth.level === "high" ? 24 : queueHealth.level === "medium" ? 12 : 0;
  return clamp(
    queuePenalty +
      duplicateClusters * 4 +
      highRiskDuplicateClusters * 14 +
      Math.max(0, openPrCount - openPrThreshold) * 12 +
      (outcome?.closedPullRequestRate ?? 0) * 55 +
      Math.max(0, (outcome?.openPullRequests ?? 0) - 2) * 5,
    0,
    100,
  );
}

function maintainerFriction(queueHealth: QueueHealth, duplicateClusters: number, pullRequests: PullRequestRecord[]): number {
  const unlinked = pullRequests.filter((pr) => pr.state === "open" && pr.linkedIssues.length === 0).length;
  return clamp(queueHealth.burdenScore * 0.55 + duplicateClusters * 8 + unlinked * 5, 0, 100);
}

function reviewChurnRisk(outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined, queueHealth: QueueHealth, highRiskDuplicateClusters: number): "low" | "medium" | "high" {
  const risk = (outcome?.closedPullRequestRate ?? 0) * 100 + highRiskDuplicateClusters * 18 + (queueHealth.level === "critical" ? 25 : queueHealth.level === "high" ? 15 : 0);
  return risk >= 45 ? "high" : risk >= 20 ? "medium" : "low";
}

function analysisRank(analysis: RepoRewardRisk): number {
  return (analysis.actions[0]?.priorityScore ?? 0) + analysis.rewardUpside.directPrSlice * 100 + analysis.rewardUpside.issueDiscoverySlice * 100;
}

function bestFitLabels(repo: RepositoryRecord | null): string[] {
  const multipliers = repo?.registryConfig?.labelMultipliers ?? {};
  const labels = Object.entries(multipliers)
    .filter(([label]) => !/status|source|contributor|verified|risk|codex/i.test(label))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label]) => label);
  return labels.slice(0, 1);
}

function estimatedSourceTokenScore(outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined): number {
  return clamp(42 + (outcome?.mergedPullRequests ?? 0) * 2, 30, 120);
}

function estimatedTotalTokenScore(outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined): number {
  return clamp(70 + (outcome?.mergedPullRequests ?? 0) * 4, 60, 220);
}

function estimatedSourceLines(outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined): number {
  return Math.max(12, estimatedSourceTokenScore(outcome));
}

function nextActionsFor(kind: RewardRiskActionKind): string[] {
  switch (kind) {
    case "cleanup_existing_prs":
      return ["Land, close, or withdraw stale open PRs before opening additional direct-PR work.", "Prioritize the repo where existing successful evidence is strongest."];
    case "land_existing_prs":
      return ["Tighten validation, update PR bodies, and resolve review/check blockers on already-open work."];
    case "close_or_withdraw_low_fit_prs":
      return ["Withdraw stale or low-fit PRs that are unlikely to merge cleanly and are adding open PR pressure."];
    case "open_new_direct_pr":
      return ["Only open a new PR after duplicate checks, local score preview, tests, and linked/no-issue rationale are clean."];
    case "file_issue_discovery":
      return ["File only high-proof issues that someone else can solve and that are unlikely to be closed as duplicate or unclear."];
    case "maintainer_lane_improve_repo":
      return ["Improve labels, contribution docs, queue hygiene, and contributor intake for the maintained repo."];
    case "maintainer_cut_readiness":
      return ["Check config quality and maintainer_cut readiness before expecting maintainer-lane economics to work cleanly."];
  }
}

function maintainerNextStepsFor(action: PullRequestReviewability["action"], noiseSources: string[]): string[] {
  if (action === "review_now") return ["Review the technical diff now; cached hygiene signals look clean enough."];
  if (action === "maintainer_lane") return ["Treat as maintainer stewardship and verify repo-health impact separately."];
  if (action === "likely_duplicate") return ["Compare against linked issues, active PRs, and recent merges before detailed review."];
  if (action === "close_or_redirect") return ["Redirect or close non-open/stale context before spending review time."];
  if (action === "needs_author") return ["Ask the author to address the concrete missing context before deep review.", ...noiseSources.slice(0, 3)];
  return ["Watch for tests, checks, linked context, or duplicate-risk changes before prioritizing review."];
}

function sameRepo(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function uniqueRegisteredRepoNames(repoFullNames: string[], registeredRepoNames: Map<string, string>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const repoFullName of repoFullNames) {
    const key = repoFullName.toLowerCase();
    const canonical = registeredRepoNames.get(key);
    if (!canonical || seen.has(key)) continue;
    seen.add(key);
    unique.push(canonical);
  }
  return unique;
}

function nonNegative(value: number | undefined): number {
  /* v8 ignore next -- Sparse contributor totals normalize to zero before scoring; aggregate scoring tests cover the behavior. */
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
