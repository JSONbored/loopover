import type {
  AdvisoryFinding,
  BountyRecord,
  CheckSummaryRecord,
  CollisionEdgeRecord,
  ContributorRepoStatRecord,
  IssueRecord,
  PullRequestFileRecord,
  PullRequestRecord,
  PullRequestReviewRecord,
  RecentMergedPullRequestRecord,
  RegistrySnapshot,
  RepoLabelRecord,
  RepoSyncStateRecord,
  RepositoryRecord,
  RepositorySettings,
  ScoringModelSnapshotRecord,
} from "../types";
import type { PublicContributorProfile } from "../github/public";
import type { GittensorContributorSnapshot } from "../gittensor/api";
import { nowIso } from "../utils/json";

export type ParticipationLane = "direct_pr" | "issue_discovery" | "split" | "inactive" | "unknown";
export type SignalFinding = AdvisoryFinding;

export type LaneAdvice = {
  lane: ParticipationLane;
  repoFullName: string;
  issueDiscoveryShare?: number | undefined;
  directPrShare?: number | undefined;
  summary: string;
  contributorGuidance: string;
  maintainerGuidance: string;
};

export type CollisionItem = {
  type: "issue" | "pull_request" | "recent_merged_pull_request";
  number: number;
  title: string;
  authorLogin?: string | null | undefined;
  htmlUrl?: string | null | undefined;
  labels?: string[] | undefined;
  linkedIssues?: number[] | undefined;
  changedFiles?: string[] | undefined;
  body?: string | null | undefined;
};

export type CollisionCluster = {
  id: string;
  risk: "low" | "medium" | "high";
  reason: string;
  items: CollisionItem[];
};

export type CollisionReport = {
  repoFullName: string;
  generatedAt: string;
  summary: {
    clusterCount: number;
    highRiskCount: number;
    itemsReviewed: number;
  };
  clusters: CollisionCluster[];
};

export type QueueHealth = {
  repoFullName: string;
  generatedAt: string;
  burdenScore: number;
  level: "low" | "medium" | "high" | "critical";
  summary: string;
  signals: {
    openIssues: number;
    openPullRequests: number;
    unlinkedPullRequests: number;
    stalePullRequests: number;
    maintainerAuthoredPullRequests: number;
    collisionClusters: number;
    ageBuckets: {
      under7Days: number;
      days7To30: number;
      over30Days: number;
    };
    likelyReviewablePullRequests: number;
  };
  findings: SignalFinding[];
};

export type QueueSignalCounts = {
  openIssues?: number | undefined;
  openPullRequests?: number | undefined;
};

export type ConfigQuality = {
  repoFullName: string;
  generatedAt: string;
  score: number;
  level: "excellent" | "good" | "needs_attention" | "fragile";
  lane: LaneAdvice;
  configuredLabels: string[];
  observedLabels: string[];
  notObservedConfiguredLabels: string[];
  findings: SignalFinding[];
};

export type LabelAudit = {
  repoFullName: string;
  generatedAt: string;
  configuredLabels: string[];
  liveLabels: string[];
  observedLabels: Array<{ name: string; count: number; configured: boolean; existsOnGitHub: boolean }>;
  missingConfiguredLabels: string[];
  suspiciousConfiguredLabels: string[];
  trustedPipelineReady: boolean;
  findings: SignalFinding[];
};

export type ContributorProfile = {
  login: string;
  generatedAt: string;
  github: PublicContributorProfile;
  source: "gittensor_api" | "github_cache";
  gittensor?: {
    githubId: string;
    githubUsername: string;
    uid?: number | undefined;
    hotkey?: string | undefined;
    evaluatedAt?: string | undefined;
    updatedAt?: string | undefined;
    isEligible: boolean;
    credibility: number;
    eligibleRepoCount: number;
    issueDiscoveryScore: number;
    issueTokenScore: number;
    issueCredibility: number;
    isIssueEligible: boolean;
    issueEligibleRepoCount: number;
    alphaPerDay: number;
    taoPerDay: number;
    usdPerDay: number;
    totals: GittensorContributorSnapshot["totals"];
    repositories: GittensorContributorSnapshot["repositories"];
  } | undefined;
  registeredRepoActivity: {
    pullRequests: number;
    mergedPullRequests: number;
    issues: number;
    reposTouched: string[];
    dominantLabels: string[];
  };
  trustSignals: {
    evidenceScore: number;
    level: "new" | "emerging" | "established";
    unlinkedOpenPullRequests: number;
    maintainerAssociatedPullRequests: number;
  };
};

export type ContributorOpportunity = {
  repoFullName: string;
  issueNumber?: number | undefined;
  title: string;
  fit: "good" | "caution" | "hold";
  score: number;
  lane: ParticipationLane;
  reasons: string[];
  warnings: string[];
};

export type ContributorFit = {
  login: string;
  generatedAt: string;
  profile: ContributorProfile;
  summary: string;
  languageFit: Array<{ repoFullName: string; language?: string | null; match: boolean }>;
  repoStats: ContributorRepoStatRecord[];
  opportunities: ContributorOpportunity[];
  findings: SignalFinding[];
};

export type ContributorRole = "outside_contributor" | "repo_maintainer" | "org_member" | "collaborator" | "owner" | "unknown";

export type RoleContext = {
  login: string;
  repoFullName: string;
  generatedAt: string;
  role: ContributorRole;
  maintainerLane: boolean;
  normalContributorEvidenceAllowed: boolean;
  source: "github_association" | "repo_owner_match" | "gittensor_api" | "cache" | "unknown";
  association?: string | null | undefined;
  reasons: string[];
  guidance: string;
};

export type ContributorOutcomeHistory = {
  login: string;
  generatedAt: string;
  source: ContributorProfile["source"];
  reconciliation?: ContributorReconciliationReport | undefined;
  totals: {
    pullRequests: number;
    mergedPullRequests: number;
    openPullRequests: number;
    closedPullRequests: number;
    closedPullRequestRate: number;
    issues: number;
    openIssues: number;
    closedIssues: number;
    solvedIssues: number;
    validSolvedIssues: number;
    credibility: number;
    issueCredibility: number;
  };
  repoOutcomes: Array<{
    repoFullName: string;
    role: ContributorRole;
    lane: ParticipationLane;
    maintainerLane: boolean;
    pullRequests: number;
    mergedPullRequests: number;
    openPullRequests: number;
    closedPullRequests: number;
    closedPullRequestRate: number;
    issues: number;
    openIssues: number;
    closedIssues: number;
    solvedIssues: number;
    validSolvedIssues: number;
    credibility: number;
    issueCredibility: number;
    isEligible: boolean;
    successLevel: "strong" | "emerging" | "weak" | "maintainer_context";
    strengths: string[];
    risks: string[];
  }>;
  successPatterns: OutcomePattern[];
  failurePatterns: OutcomePattern[];
  summary: string;
};

type ContributorOutcomeCounts = Pick<
  ContributorOutcomeHistory["repoOutcomes"][number],
  "pullRequests" | "mergedPullRequests" | "openPullRequests" | "closedPullRequests" | "issues" | "openIssues" | "closedIssues" | "solvedIssues" | "validSolvedIssues"
>;

export type ContributorReconciliationReport = {
  login: string;
  generatedAt: string;
  source: ContributorProfile["source"];
  officialAuthoritative: boolean;
  totals: {
    official?: ContributorOutcomeHistory["totals"] | undefined;
    cached: ContributorOutcomeHistory["totals"];
    effective: ContributorOutcomeHistory["totals"];
  };
  repos: Array<{
    repoFullName: string;
    maintainerLane: boolean;
    official?: ContributorOutcomeCounts | undefined;
    cached: ContributorOutcomeCounts;
    effective: ContributorOutcomeCounts;
    discrepancyReasons: string[];
    freshness: {
      officialUpdatedAt?: string | undefined;
      cachedLastActivityAt?: string | undefined;
    };
  }>;
  findings: SignalFinding[];
  summary: string;
};

export type OutcomePattern = {
  repoFullName?: string | undefined;
  title: string;
  detail: string;
  confidence: "high" | "medium" | "low";
};

export type ContributorPatternReport = {
  login: string;
  generatedAt: string;
  patternType: "success" | "failure";
  patterns: OutcomePattern[];
  summary: string;
};

export type RepoFitRecommendation = {
  login: string;
  repoFullName: string;
  generatedAt: string;
  roleContext: RoleContext;
  lane: LaneAdvice;
  recommendation: "pursue" | "cleanup_first" | "maintainer_lane" | "avoid_for_now" | "unknown";
  confidence: "high" | "medium" | "low";
  reasons: string[];
  risks: string[];
  nextActions: string[];
  rewardRisk?: Record<string, unknown> | undefined;
  reasoning?: string[] | undefined;
  actionImpact?: Record<string, unknown> | undefined;
};

export type MaintainerLaneReport = {
  repoFullName: string;
  generatedAt: string;
  lane: LaneAdvice;
  maintainerCut: number;
  maintainerCutConfigured: boolean;
  queueHealth: QueueHealth;
  configQuality: ConfigQuality;
  contributorIntakeHealth: ContributorIntakeHealth;
  summary: string;
  findings: SignalFinding[];
};

export type MaintainerCutReadiness = {
  repoFullName: string;
  generatedAt: string;
  ready: boolean;
  maintainerCut: number;
  recommendedAction: "leave_disabled" | "consider_small_cut" | "review_existing_cut" | "fix_config_first";
  reasons: string[];
  warnings: string[];
};

export type ContributorIntakeHealth = {
  repoFullName: string;
  generatedAt: string;
  level: "healthy" | "watch" | "strained" | "blocked";
  score: number;
  queueHealth: Pick<QueueHealth, "burdenScore" | "level" | "signals">;
  configLevel: ConfigQuality["level"];
  duplicateClusters: number;
  reviewablePullRequests: number;
  summary: string;
  findings: SignalFinding[];
};

export type PullRequestReviewIntelligence = PullRequestMaintainerPacket & {
  roleContext: RoleContext;
  outcomeContext?: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
  recommendation: RepoFitRecommendation["recommendation"] | "review" | "needs_author" | "watch" | "likely_duplicate" | "maintainer_lane";
  privateSummary: string;
  reviewability?: Record<string, unknown> | undefined;
};

export type PreflightInput = {
  repoFullName: string;
  contributorLogin?: string | undefined;
  title: string;
  body?: string | undefined;
  labels?: string[] | undefined;
  changedFiles?: string[] | undefined;
  linkedIssues?: number[] | undefined;
  tests?: string[] | undefined;
  authorAssociation?: string | undefined;
};

export type PreflightResult = {
  repoFullName: string;
  generatedAt: string;
  status: "ready" | "needs_work" | "hold";
  lane: LaneAdvice;
  reviewBurden: "low" | "medium" | "high";
  linkedIssues: number[];
  findings: SignalFinding[];
  collisions: CollisionCluster[];
};

export type LocalDiffPreflightInput = PreflightInput & {
  changedLineCount?: number | undefined;
  testFiles?: string[] | undefined;
  commitMessage?: string | undefined;
};

export type LocalDiffPreflightResult = PreflightResult & {
  localDiff: {
    changedFileCount: number;
    changedLineCount: number;
    testFileCount: number;
    codeFileCount: number;
    inferredLinkedIssues: number[];
    summary: string;
  };
};

export type MaintainerPacket = {
  repoFullName: string;
  generatedAt: string;
  queueHealth: QueueHealth;
  configQuality: ConfigQuality;
  collisions: CollisionReport;
  pullRequestPackets: Array<{
    number: number;
    title: string;
    authorLogin?: string | null | undefined;
    reviewPriority: "review" | "needs_author" | "watch";
    reasons: string[];
  }>;
  suggestedActions: string[];
};

export type PullRequestMaintainerPacket = {
  repoFullName: string;
  pullNumber: number;
  generatedAt: string;
  reviewPriority: "review" | "needs_author" | "watch";
  summary: string;
  changeSummary: {
    fileCount: number;
    codeFileCount: number;
    testFileCount: number;
    additions: number;
    deletions: number;
    topPaths: string[];
  };
  reviewSignals: {
    reviewCount: number;
    approvalCount: number;
    changeRequestCount: number;
    checkFailureCount: number;
    linkedIssues: number[];
    collisionClusters: number;
  };
  findings: SignalFinding[];
  contributorNextSteps: string[];
  maintainerNotes: string[];
};

export type BountyAdvisory = {
  id: string;
  repoFullName: string;
  issueNumber: number;
  status: string;
  lifecycle: "active" | "historical" | "unknown";
  fundingStatus: "funded" | "target_only" | "unknown";
  consensusRisk: "low" | "medium" | "high";
  findings: SignalFinding[];
};

export type ContributorDetection = {
  detected: boolean;
  reason: string;
  source?: "official_gittensor_api" | "github_cache";
  priorPullRequests: number;
  priorMergedPullRequests: number;
  priorIssues: number;
};

export type RegistryChangeReport = {
  generatedAt: string;
  currentSnapshotId?: string | undefined;
  previousSnapshotId?: string | undefined;
  addedRepos: string[];
  removedRepos: string[];
  changedRepos: Array<{
    repoFullName: string;
    changes: string[];
  }>;
  summary: string;
};

export type IssueQualityReport = {
  repoFullName: string;
  generatedAt: string;
  lane: LaneAdvice;
  issues: Array<{
    number: number;
    title: string;
    lifecycle?: IssueDiscoveryLifecycleState | undefined;
    status: "ready" | "needs_proof" | "hold" | "do_not_use";
    score: number;
    reasons: string[];
    warnings: string[];
  }>;
  summary: string;
};

export type IssueDiscoveryLifecycleState = "open" | "closed_not_solved" | "solved" | "valid_solved" | "stale" | "duplicate" | "invalid";

export type IssueDiscoveryLifecycleReport = {
  repoFullName: string;
  generatedAt: string;
  lane: LaneAdvice;
  states: Array<{
    number: number;
    title: string;
    state: IssueDiscoveryLifecycleState;
    solvedByPullRequests: number[];
    reasons: string[];
  }>;
  summary: string;
};

export type BurdenForecast = {
  repoFullName: string;
  generatedAt: string;
  horizonDays: 7 | 30;
  level: "low" | "medium" | "high" | "critical";
  forecast: {
    projectedReviewLoad: number;
    reviewablePullRequests: number;
    stalePullRequests: number;
    duplicateTrend: number;
    queueGrowthRisk: number;
  };
  findings: SignalFinding[];
  summary: string;
};

export type ContributorScoringProfile = {
  login: string;
  generatedAt: string;
  scoringModelSnapshotId: string;
  evidence: {
    registeredRepoPullRequests: number;
    mergedPullRequests: number;
    openPullRequests: number;
    stalePullRequests: number;
    unlinkedPullRequests: number;
    issueDiscoveryReports: number;
    languageMatches: number;
    credibilityAssumption: number;
  };
  privateSignals: string[];
};

export type ContributorStrategy = {
  login: string;
  generatedAt: string;
  scoringModelSnapshotId: string;
  summary: string;
  bestFitRepos: Array<{
    repoFullName: string;
    lane: ParticipationLane;
    fit: ContributorOpportunity["fit"];
    opportunityScore: number;
    privateScoringReadiness: "good" | "caution" | "hold";
    reasons: string[];
    warnings: string[];
  }>;
  avoidRepos: Array<{ repoFullName: string; reason: string }>;
  cleanupFirst: Array<{ repoFullName: string; reason: string }>;
  maintainerLaneRepos: Array<{ repoFullName: string; reason: string }>;
  successPatterns: OutcomePattern[];
  failurePatterns: OutcomePattern[];
  laneWarnings: string[];
  nextActions: string[];
  rewardRisk?: Record<string, unknown> | undefined;
  reasoning?: string[] | undefined;
  actionImpact?: string[] | undefined;
};

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "when",
  "into",
  "issue",
  "pull",
  "request",
  "add",
  "fix",
  "update",
  "improve",
]);
const MAX_COLLISION_PAIRWISE_ISSUES = 80;
const MAX_COLLISION_PAIRWISE_PULL_REQUESTS = 120;
const MAX_COLLISION_PAIRWISE_RECENT_MERGES = 40;

export function buildLaneAdvice(repo: RepositoryRecord | null, fullName: string): LaneAdvice {
  const config = repo?.registryConfig;
  if (!repo || !repo.isRegistered || !config) {
    return {
      lane: "unknown",
      repoFullName: fullName,
      summary: "Repository registration is not available in the local Gittensory cache.",
      contributorGuidance: "Do not assume this repo is ready for Gittensor-specific contribution guidance yet.",
      maintainerGuidance: "Refresh the registry snapshot or install the GitHub App so Gittensory can evaluate the repo.",
    };
  }
  if (config.emissionShare <= 0) {
    return {
      lane: "inactive",
      repoFullName: fullName,
      issueDiscoveryShare: config.issueDiscoveryShare,
      directPrShare: 0,
      summary: "Repository is registered but has no active allocation in the current snapshot.",
      contributorGuidance: "Treat this as normal upstream contribution work unless the registry changes.",
      maintainerGuidance: "Do not expect Gittensor-driven contributor flow from this repo while allocation is zero.",
    };
  }
  const issueDiscoveryShare = clamp(config.issueDiscoveryShare, 0, 1);
  const directPrShare = 1 - issueDiscoveryShare;
  if (issueDiscoveryShare === 1) {
    return {
      lane: "issue_discovery",
      repoFullName: fullName,
      issueDiscoveryShare,
      directPrShare,
      summary: "Repository is configured for issue-discovery flow.",
      contributorGuidance: "Focus on high-proof issue discovery and avoid self-resolved issue loops.",
      maintainerGuidance: "Prioritize issue quality, duplicate risk, and whether reports are actionable for outside contributors.",
    };
  }
  if (issueDiscoveryShare === 0) {
    return {
      lane: "direct_pr",
      repoFullName: fullName,
      issueDiscoveryShare,
      directPrShare,
      summary: "Repository is configured for direct PR review.",
      contributorGuidance: "Prefer focused PRs with clear evidence, linked context, and low review churn.",
      maintainerGuidance: "Use PR hygiene, duplicate risk, and test evidence as the primary review filters.",
    };
  }
  return {
    lane: "split",
    repoFullName: fullName,
    issueDiscoveryShare,
    directPrShare,
    summary: "Repository is configured for both issue discovery and direct PR review.",
    contributorGuidance: "Pick one path intentionally: issue discovery for reports, direct PR for implementation.",
    maintainerGuidance: "Check whether each submission is using the right path before reviewing technical detail.",
  };
}

export function buildCollisionReport(
  repoFullName: string,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  recentMergedPullRequests: RecentMergedPullRequestRecord[] = [],
): CollisionReport {
  const openIssues = issues.filter((issue) => issue.state === "open");
  const openPullRequests = pullRequests.filter((pr) => pr.state === "open");
  const clusters = new Map<string, CollisionCluster>();
  const pullRequestsByLinkedIssue = new Map<number, PullRequestRecord[]>();

  for (const pr of openPullRequests) {
    for (const issueNumber of pr.linkedIssues) {
      const linkedPrs = pullRequestsByLinkedIssue.get(issueNumber) ?? [];
      linkedPrs.push(pr);
      pullRequestsByLinkedIssue.set(issueNumber, linkedPrs);
    }
  }

  for (const issue of openIssues) {
    const linkedPrs = pullRequestsByLinkedIssue.get(issue.number) ?? [];
    if (linkedPrs.length === 0) continue;
    const items = [issueItem(issue), ...linkedPrs.map(prItem)];
    clusters.set(`issue-${issue.number}`, {
      id: `issue-${issue.number}`,
      risk: linkedPrs.length > 1 || issue.linkedPrs.length > 1 ? "high" : "medium",
      reason: `Open PR work references issue #${issue.number}.`,
      items,
    });
  }

  const pairwiseIssues = boundedCollisionIssues(openIssues, openPullRequests);
  const pairwisePullRequests = openPullRequests.slice(0, MAX_COLLISION_PAIRWISE_PULL_REQUESTS);
  const pairwiseRecentMergedPullRequests = recentMergedPullRequests.slice(0, MAX_COLLISION_PAIRWISE_RECENT_MERGES);
  const items = [...pairwiseIssues.map(issueItem), ...pairwisePullRequests.map(prItem), ...pairwiseRecentMergedPullRequests.map(recentMergedItem)];
  const itemTerms = new Map<string, CollisionTerms>();
  for (const item of items) itemTerms.set(itemKey(item), collisionTerms(item));
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex];
      const right = items[rightIndex];
      if (!left || !right) continue;
      const sharedIssue = (left.linkedIssues ?? []).find((issue) => (right.linkedIssues ?? []).includes(issue));
      if (sharedIssue) {
        const key = [itemKey(left), itemKey(right)].sort().join("--");
        if (!clusters.has(key)) {
          clusters.set(key, {
            id: key,
            risk: right.type === "recent_merged_pull_request" || left.type === "recent_merged_pull_request" ? "medium" : "high",
            reason: `Items reference the same linked issue #${sharedIssue}.`,
            items: [left, right],
          });
        }
        continue;
      }
      const overlap = termOverlap(itemTerms.get(itemKey(left)) ?? collisionTerms(left), itemTerms.get(itemKey(right)) ?? collisionTerms(right));
      if (overlap.score < 0.58 || overlap.shared < 2) continue;
      const key = [itemKey(left), itemKey(right)].sort().join("--");
      if (clusters.has(key)) continue;
      clusters.set(key, {
        id: key,
        risk: overlap.score >= 0.75 ? "high" : "medium",
        reason: `Titles share ${overlap.shared} meaningful terms.`,
        items: [left, right],
      });
    }
  }

  const clusterList = [...clusters.values()].sort((left, right) => riskRank(right.risk) - riskRank(left.risk));
  return {
    repoFullName,
    generatedAt: nowIso(),
    summary: {
      clusterCount: clusterList.length,
      highRiskCount: clusterList.filter((cluster) => cluster.risk === "high").length,
      itemsReviewed: openIssues.length + openPullRequests.length + recentMergedPullRequests.length,
    },
    clusters: clusterList,
  };
}

export function buildQueueHealth(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  collisions: CollisionReport,
  countOverrides: QueueSignalCounts = {},
): QueueHealth {
  const repoFullName = repo?.fullName ?? collisions.repoFullName;
  const openIssues = issues.filter((issue) => issue.state === "open");
  const openPullRequests = pullRequests.filter((pr) => pr.state === "open");
  const openIssueCount = Math.max(openIssues.length, countOverrides.openIssues ?? 0);
  const openPullRequestCount = Math.max(openPullRequests.length, countOverrides.openPullRequests ?? 0);
  const unlinkedPullRequests = openPullRequests.filter((pr) => pr.linkedIssues.length === 0);
  const stalePullRequests = openPullRequests.filter((pr) => daysSince(pr.updatedAt ?? pr.createdAt) >= 14);
  const maintainerAuthoredPullRequests = openPullRequests.filter((pr) => isMaintainerAssociation(pr.authorAssociation));
  const likelyReviewablePullRequests = openPullRequests.filter((pr) => pr.linkedIssues.length > 0 && daysSince(pr.updatedAt ?? pr.createdAt) < 30).length;
  const ageBuckets = {
    under7Days: openPullRequests.filter((pr) => daysSince(pr.updatedAt ?? pr.createdAt) < 7).length,
    days7To30: openPullRequests.filter((pr) => {
      const age = daysSince(pr.updatedAt ?? pr.createdAt);
      return age >= 7 && age <= 30;
    }).length,
    over30Days: openPullRequests.filter((pr) => daysSince(pr.updatedAt ?? pr.createdAt) > 30).length,
  };
  const burdenScore = clamp(
    openPullRequestCount * 6 +
      openIssueCount +
      unlinkedPullRequests.length * 8 +
      stalePullRequests.length * 6 +
      ageBuckets.over30Days * 4 +
      collisions.summary.clusterCount * 10 -
      likelyReviewablePullRequests * 2,
    0,
    100,
  );
  const level = burdenScore >= 80 ? "critical" : burdenScore >= 55 ? "high" : burdenScore >= 25 ? "medium" : "low";
  const findings: SignalFinding[] = [];
  if (unlinkedPullRequests.length > 0) {
    findings.push({
      code: "unlinked_prs",
      severity: "warning",
      title: "Open PRs are missing linked issue context",
      detail: `${unlinkedPullRequests.length} open pull request(s) in the local cache do not reference a closing issue.`,
      action: "Ask contributors to link relevant issues or explain no-issue PR intent clearly.",
    });
  }
  if (collisions.summary.clusterCount > 0) {
    findings.push({
      code: "collision_clusters",
      severity: collisions.summary.highRiskCount > 0 ? "warning" : "info",
      title: "Duplicate or overlapping work is visible",
      detail: `${collisions.summary.clusterCount} possible overlap cluster(s) were detected.`,
      action: "Review overlapping submissions before spending detailed review time.",
    });
  }
  if (stalePullRequests.length > 0) {
    findings.push({
      code: "stale_prs",
      severity: "info",
      title: "Some open PRs appear stale",
      detail: `${stalePullRequests.length} open pull request(s) have not updated in at least 14 days.`,
    });
  }
  return {
    repoFullName,
    generatedAt: nowIso(),
    burdenScore,
    level,
    summary: `Queue burden is ${level} with ${openPullRequestCount} open PR(s), ${openIssueCount} open issue(s), and ${collisions.summary.clusterCount} overlap cluster(s).`,
    signals: {
      openIssues: openIssueCount,
      openPullRequests: openPullRequestCount,
      unlinkedPullRequests: unlinkedPullRequests.length,
      stalePullRequests: stalePullRequests.length,
      maintainerAuthoredPullRequests: maintainerAuthoredPullRequests.length,
      collisionClusters: collisions.summary.clusterCount,
      ageBuckets,
      likelyReviewablePullRequests,
    },
    findings,
  };
}

export function buildConfigQuality(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  fullName: string,
): ConfigQuality {
  const lane = buildLaneAdvice(repo, fullName);
  const configuredLabels = Object.keys(repo?.registryConfig?.labelMultipliers ?? {}).sort();
  const observedLabels = [...new Set([...issues, ...pullRequests].flatMap((record) => record.labels))].sort();
  const notObservedConfiguredLabels = configuredLabels.filter((label) => !observedLabels.includes(label));
  const findings: SignalFinding[] = [];
  let score = 100;

  if (lane.lane === "unknown") {
    score -= 45;
    findings.push({
      code: "registry_unknown",
      severity: "warning",
      title: "Registry config is unavailable",
      detail: "Gittensory cannot verify this repo's Gittensor participation lane from the local snapshot.",
    });
  }
  if (lane.lane === "inactive") {
    score -= 35;
    findings.push({
      code: "inactive_allocation",
      severity: "info",
      title: "Repo has no active allocation",
      detail: "The current registry config has no active allocation for this repo.",
    });
  }
  if (repo?.registryConfig?.trustedLabelPipeline && configuredLabels.length === 0) {
    score -= 25;
    findings.push({
      code: "trusted_labels_without_multipliers",
      severity: "warning",
      title: "Trusted label pipeline has no configured multipliers",
      detail: "The registry says labels are trusted, but no label multipliers are configured.",
    });
  }
  if (notObservedConfiguredLabels.length > 0) {
    score -= Math.min(30, notObservedConfiguredLabels.length * 8);
    findings.push({
      code: "configured_labels_not_observed",
      severity: "info",
      title: "Configured labels were not observed locally",
      detail: `Configured labels not seen in cached issues/PRs: ${notObservedConfiguredLabels.join(", ")}.`,
      action: "Verify those labels exist and are actually used by maintainers or trusted automation.",
    });
  }

  const finalScore = clamp(score, 0, 100);
  return {
    repoFullName: fullName,
    generatedAt: nowIso(),
    score: finalScore,
    level: finalScore >= 90 ? "excellent" : finalScore >= 70 ? "good" : finalScore >= 45 ? "needs_attention" : "fragile",
    lane,
    configuredLabels,
    observedLabels,
    notObservedConfiguredLabels,
    findings,
  };
}

export function buildLabelAudit(repo: RepositoryRecord | null, repoLabels: RepoLabelRecord[], issues: IssueRecord[], pullRequests: PullRequestRecord[], fullName: string): LabelAudit {
  const configuredLabels = Object.keys(repo?.registryConfig?.labelMultipliers ?? {}).sort();
  const liveLabels = repoLabels.map((label) => label.name).sort();
  const observedCountMap = new Map<string, number>();
  for (const label of repoLabels) observedCountMap.set(label.name, Math.max(observedCountMap.get(label.name) ?? 0, label.observedCount));
  for (const label of [...issues, ...pullRequests].flatMap((record) => record.labels)) {
    observedCountMap.set(label, (observedCountMap.get(label) ?? 0) + 1);
  }
  const observedLabels = [...observedCountMap.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => ({
      name,
      count,
      configured: configuredLabels.includes(name),
      existsOnGitHub: liveLabels.includes(name),
    }));
  const missingConfiguredLabels = configuredLabels.filter((label) => !liveLabels.includes(label));
  const suspiciousConfiguredLabels = configuredLabels.filter((label) => /^(status|state|source|bot|codex|gittensory|reward|score|miner|verified|risk)[:/-]?/i.test(label));
  const findings: SignalFinding[] = [];
  if (repo?.registryConfig?.trustedLabelPipeline && missingConfiguredLabels.length > 0) {
    findings.push({
      code: "trusted_labels_missing",
      severity: "warning",
      title: "Trusted label config references missing labels",
      detail: `Configured label(s) not found in live GitHub labels: ${missingConfiguredLabels.join(", ")}.`,
      action: "Create those labels or remove them from the registry config.",
    });
  }
  if (suspiciousConfiguredLabels.length > 0) {
    findings.push({
      code: "suspicious_configured_labels",
      severity: "warning",
      title: "Configured labels look like status or source labels",
      detail: `Potentially weak work-value labels: ${suspiciousConfiguredLabels.join(", ")}.`,
      action: "Prefer labels that describe work type or user impact.",
    });
  }
  if (configuredLabels.length > 0 && observedLabels.filter((label) => label.configured).length === 0) {
    findings.push({
      code: "configured_labels_unused",
      severity: "info",
      title: "Configured labels are not visible in cached work",
      detail: "No configured label has been observed on cached issues or pull requests.",
    });
  }
  return {
    repoFullName: fullName,
    generatedAt: nowIso(),
    configuredLabels,
    liveLabels,
    observedLabels,
    missingConfiguredLabels,
    suspiciousConfiguredLabels,
    trustedPipelineReady: Boolean(repo?.registryConfig?.trustedLabelPipeline) && missingConfiguredLabels.length === 0 && suspiciousConfiguredLabels.length === 0,
    findings,
  };
}

export function buildContributorProfile(
  login: string,
  github: PublicContributorProfile,
  pullRequests: PullRequestRecord[],
  issues: IssueRecord[],
  repoStats: ContributorRepoStatRecord[] = [],
  gittensorSnapshot: GittensorContributorSnapshot | null = null,
): ContributorProfile {
  if (gittensorSnapshot) return buildGittensorContributorProfile(login, github, pullRequests, repoStats, gittensorSnapshot);

  const authoredPullRequests = pullRequests.filter((pr) => sameLogin(pr.authorLogin, login));
  const authoredIssues = issues.filter((issue) => sameLogin(issue.authorLogin, login));
  const mergedPullRequests = authoredPullRequests.filter((pr) => pr.mergedAt || pr.state === "merged");
  const matchingStats = repoStats.filter((stat) => sameLogin(stat.login, login));
  const statPullRequests = matchingStats.reduce((sum, stat) => sum + stat.pullRequests, 0);
  const statMergedPullRequests = matchingStats.reduce((sum, stat) => sum + stat.mergedPullRequests, 0);
  const statIssues = matchingStats.reduce((sum, stat) => sum + stat.issues, 0);
  const reposTouched = [
    ...new Set([
      ...authoredPullRequests.map((record) => record.repoFullName),
      ...authoredIssues.map((record) => record.repoFullName),
      ...matchingStats.filter((stat) => stat.pullRequests > 0 || stat.issues > 0).map((stat) => stat.repoFullName),
    ]),
  ].sort();
  const dominantLabels = topItems(
    [
      ...authoredPullRequests.flatMap((record) => record.labels),
      ...authoredIssues.flatMap((record) => record.labels),
      ...matchingStats.flatMap((stat) => stat.dominantLabels),
    ],
    8,
  );
  const unlinkedOpenPullRequests = Math.max(
    authoredPullRequests.filter((pr) => pr.state === "open" && pr.linkedIssues.length === 0).length,
    matchingStats.reduce((sum, stat) => sum + stat.unlinkedPullRequests, 0),
  );
  const maintainerAssociatedPullRequests = authoredPullRequests.filter((pr) => isMaintainerAssociation(pr.authorAssociation)).length;
  const pullRequestCount = Math.max(authoredPullRequests.length, statPullRequests);
  const mergedPullRequestCount = Math.max(mergedPullRequests.length, statMergedPullRequests);
  const issueCount = Math.max(authoredIssues.length, statIssues);
  const evidenceScore = clamp(mergedPullRequestCount * 15 + reposTouched.length * 10 + issueCount * 2 - unlinkedOpenPullRequests * 8, 0, 100);
  return {
    login,
    generatedAt: nowIso(),
    github,
    source: "github_cache",
    registeredRepoActivity: {
      pullRequests: pullRequestCount,
      mergedPullRequests: mergedPullRequestCount,
      issues: issueCount,
      reposTouched,
      dominantLabels,
    },
    trustSignals: {
      evidenceScore,
      level: evidenceScore >= 60 ? "established" : evidenceScore >= 25 ? "emerging" : "new",
      unlinkedOpenPullRequests,
      maintainerAssociatedPullRequests,
    },
  };
}

function buildGittensorContributorProfile(
  login: string,
  github: PublicContributorProfile,
  pullRequests: PullRequestRecord[],
  repoStats: ContributorRepoStatRecord[],
  snapshot: GittensorContributorSnapshot,
): ContributorProfile {
  const matchingStats = repoStats.filter((stat) => sameLogin(stat.login, snapshot.githubUsername) || sameLogin(stat.login, login));
  const unlinkedOpenPullRequests = matchingStats.reduce((sum, stat) => sum + stat.unlinkedPullRequests, 0);
  const maintainerAssociatedPullRequests = pullRequests.filter((pr) => sameLogin(pr.authorLogin, login) && isMaintainerAssociation(pr.authorAssociation)).length;
  const reposTouched = snapshot.repositories
    .filter((repo) => repo.pullRequests + repo.openIssues + repo.closedIssues > 0)
    .map((repo) => repo.repoFullName)
    .sort();
  const dominantLabels = topItems(
    [
      ...snapshot.pullRequests.flatMap((pr) => (pr.label ? [pr.label] : [])),
      ...snapshot.issueLabels,
      ...matchingStats.flatMap((stat) => stat.dominantLabels),
    ],
    8,
  );
  const issues = snapshot.totals.openIssues + snapshot.totals.closedIssues;
  const evidenceScore = clamp(
    snapshot.totals.mergedPullRequests * 15 +
      reposTouched.length * 10 +
      issues * 2 +
      snapshot.totals.validSolvedIssues * 10 -
      snapshot.totals.closedPullRequests * 4 -
      unlinkedOpenPullRequests * 8,
    0,
    100,
  );
  return {
    login,
    generatedAt: nowIso(),
    github,
    source: "gittensor_api",
    gittensor: {
      githubId: snapshot.githubId,
      githubUsername: snapshot.githubUsername,
      uid: snapshot.uid,
      hotkey: snapshot.hotkey,
      evaluatedAt: snapshot.evaluatedAt,
      updatedAt: snapshot.updatedAt,
      isEligible: snapshot.isEligible,
      credibility: snapshot.credibility,
      eligibleRepoCount: snapshot.eligibleRepoCount,
      issueDiscoveryScore: snapshot.issueDiscoveryScore,
      issueTokenScore: snapshot.issueTokenScore,
      issueCredibility: snapshot.issueCredibility,
      isIssueEligible: snapshot.isIssueEligible,
      issueEligibleRepoCount: snapshot.issueEligibleRepoCount,
      alphaPerDay: snapshot.alphaPerDay,
      taoPerDay: snapshot.taoPerDay,
      usdPerDay: snapshot.usdPerDay,
      totals: snapshot.totals,
      repositories: snapshot.repositories,
    },
    registeredRepoActivity: {
      pullRequests: snapshot.totals.pullRequests,
      mergedPullRequests: snapshot.totals.mergedPullRequests,
      issues,
      reposTouched,
      dominantLabels,
    },
    trustSignals: {
      evidenceScore,
      level: evidenceScore >= 60 ? "established" : evidenceScore >= 25 ? "emerging" : "new",
      unlinkedOpenPullRequests,
      maintainerAssociatedPullRequests,
    },
  };
}

export function detectGittensorContributor(
  login: string,
  currentPr: PullRequestRecord,
  pullRequests: PullRequestRecord[],
  issues: IssueRecord[],
  repoStats: ContributorRepoStatRecord[] = [],
): ContributorDetection {
  const priorPullRequests = pullRequests.filter(
    (pr) => sameLogin(pr.authorLogin, login) && !(pr.repoFullName === currentPr.repoFullName && pr.number === currentPr.number),
  );
  const priorIssues = issues.filter((issue) => sameLogin(issue.authorLogin, login));
  const priorMergedPullRequests = priorPullRequests.filter((pr) => pr.mergedAt || pr.state === "merged");
  const matchingStats = repoStats.filter((stat) => sameLogin(stat.login, login));
  const statPullRequests = matchingStats.reduce((sum, stat) => sum + stat.pullRequests, 0);
  const statMergedPullRequests = matchingStats.reduce((sum, stat) => sum + stat.mergedPullRequests, 0);
  const statIssues = matchingStats.reduce((sum, stat) => sum + stat.issues, 0);
  const priorPullRequestCount = Math.max(priorPullRequests.length, statPullRequests);
  const priorMergedPullRequestCount = Math.max(priorMergedPullRequests.length, statMergedPullRequests);
  const priorIssueCount = Math.max(priorIssues.length, statIssues);
  if (priorMergedPullRequestCount > 0) {
    return {
      detected: true,
      reason: "Contributor has prior merged PR activity in registered repos cached by Gittensory.",
      priorPullRequests: priorPullRequestCount,
      priorMergedPullRequests: priorMergedPullRequestCount,
      priorIssues: priorIssueCount,
    };
  }
  if (priorPullRequestCount > 0 || priorIssueCount > 0) {
    return {
      detected: true,
      reason: "Contributor has prior registered-repo activity cached by Gittensory.",
      priorPullRequests: priorPullRequestCount,
      priorMergedPullRequests: priorMergedPullRequestCount,
      priorIssues: priorIssueCount,
    };
  }
  return {
    detected: false,
    reason: "No prior registered-repo activity was found in the local Gittensory cache.",
    priorPullRequests: 0,
    priorMergedPullRequests: 0,
    priorIssues: 0,
  };
}

export function shouldPublishPrIntelligenceComment(settings: RepositorySettings, detection: ContributorDetection): boolean {
  if (settings.commentMode === "off") return false;
  if (settings.publicSurface !== "comment_and_label" && settings.publicSurface !== "comment_only") return false;
  return detection.detected && detection.source === "official_gittensor_api";
}

export function buildContributorOpportunities(
  profile: ContributorProfile,
  repositories: RepositoryRecord[],
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  issueQualityByRepo?: Map<string, IssueQualityReport>,
): ContributorOpportunity[] {
  const opportunities: ContributorOpportunity[] = [];
  const touchedRepos = new Set(profile.registeredRepoActivity.reposTouched);
  const labelHistory = new Set(profile.registeredRepoActivity.dominantLabels);
  const qualityByKey = issueQualityByRepo
    ? new Map(Array.from(issueQualityByRepo.entries()).map(([key, value]) => [key.toLowerCase(), value]))
    : null;

  for (const repo of repositories.filter((candidate) => candidate.isRegistered)) {
    const lane = buildLaneAdvice(repo, repo.fullName);
    const repoIssues = issues.filter((issue) => issue.repoFullName === repo.fullName && issue.state === "open");
    const repoPullRequests = pullRequests.filter((pr) => pr.repoFullName === repo.fullName && pr.state === "open");
    const linkedIssueNumbers = new Set(repoPullRequests.flatMap((pr) => pr.linkedIssues));
    const availableIssues = repoIssues.filter((issue) => issue.linkedPrs.length === 0 && !linkedIssueNumbers.has(issue.number));
    const queuePenalty = Math.min(20, repoPullRequests.length * 2);
    const qualityReport = qualityByKey?.get(repo.fullName.toLowerCase());
    const qualityByIssue = qualityReport
      ? new Map(qualityReport.issues.map((entry) => [entry.number, entry]))
      : null;
    const rankable = qualityByIssue
      ? availableIssues.filter((issue) => qualityByIssue.get(issue.number)?.status !== "do_not_use")
      : availableIssues;
    for (const issue of rankable.slice(0, 5)) {
      const quality = qualityByIssue?.get(issue.number);
      const labelFit = issue.labels.filter((label) => labelHistory.has(label)).length;
      const qualityAdjustment =
        quality?.status === "ready"
          ? 10
          : quality?.status === "needs_proof"
            ? -8
            : quality?.status === "hold"
              ? -15
              : 0;
      const score = clamp(
        50 +
          (touchedRepos.has(repo.fullName) ? 20 : 0) +
          labelFit * 5 +
          (lane.lane === "split" ? 8 : 0) +
          (lane.lane === "direct_pr" ? 5 : 0) -
          queuePenalty -
          (lane.lane === "inactive" || lane.lane === "unknown" ? 35 : 0) +
          qualityAdjustment,
        0,
        100,
      );
      const downgradeToCaution = quality?.status === "needs_proof" && score >= 70;
      opportunities.push({
        repoFullName: repo.fullName,
        issueNumber: issue.number,
        title: issue.title,
        fit: downgradeToCaution ? "caution" : score >= 70 ? "good" : score >= 40 ? "caution" : "hold",
        score,
        lane: lane.lane,
        reasons: [
          lane.summary,
          ...(touchedRepos.has(repo.fullName) ? ["Contributor has prior activity in this registered repo."] : []),
          ...(labelFit > 0 ? [`Issue labels overlap contributor history: ${issue.labels.filter((label) => labelHistory.has(label)).join(", ")}.`] : []),
          ...(quality?.status === "ready" ? ["Issue quality report rates this issue as ready."] : []),
        ],
        warnings: [
          ...(repoPullRequests.length >= 8 ? ["This repo has a busy open PR queue."] : []),
          ...(lane.lane === "issue_discovery" ? ["This repo is not a direct-PR-first lane."] : []),
          ...(lane.lane === "unknown" || lane.lane === "inactive" ? ["Gittensory cannot recommend this as a strong contribution target right now."] : []),
          ...(quality?.status === "needs_proof" ? ["Issue quality report flags this issue as needing more proof before acting."] : []),
          ...(quality?.status === "hold" ? ["Issue quality report rates this issue as hold; consider skipping."] : []),
        ],
      });
    }
  }

  return opportunities.sort((left, right) => right.score - left.score || left.repoFullName.localeCompare(right.repoFullName)).slice(0, 25);
}

export function buildContributorFit(
  profile: ContributorProfile,
  repositories: RepositoryRecord[],
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  repoSyncStates: RepoSyncStateRecord[],
  repoStats: ContributorRepoStatRecord[],
  issueQualityByRepo?: Map<string, IssueQualityReport>,
): ContributorFit {
  const opportunities = buildContributorOpportunities(profile, repositories, issues, pullRequests, issueQualityByRepo);
  const languageSet = new Set(profile.github.topLanguages.map((language) => language.toLowerCase()));
  const syncByRepo = new Map(repoSyncStates.map((state) => [state.repoFullName, state]));
  const languageFit = repositories
    .filter((repo) => repo.isRegistered)
    .map((repo) => {
      const language = syncByRepo.get(repo.fullName)?.primaryLanguage ?? null;
      return {
        repoFullName: repo.fullName,
        language,
        match: Boolean(language && languageSet.has(language.toLowerCase())),
      };
    })
    .sort((left, right) => Number(right.match) - Number(left.match) || left.repoFullName.localeCompare(right.repoFullName));
  const findings: SignalFinding[] = [];
  const matchedLanguages = languageFit.filter((fit) => fit.match).length;
  if (matchedLanguages === 0 && profile.github.topLanguages.length > 0) {
    findings.push({
      code: "no_language_fit",
      severity: "info",
      title: "No strong language fit found in cached repo metadata",
      detail: "The contributor's public GitHub languages do not match cached primary languages for registered repos.",
    });
  }
  const highQueueMatches = opportunities.filter((opportunity) => opportunity.warnings.some((warning) => /busy|queue/i.test(warning)));
  if (highQueueMatches.length > 0) {
    findings.push({
      code: "busy_queue_matches",
      severity: "info",
      title: "Some apparent fits have busy queues",
      detail: `${highQueueMatches.length} ranked opportunity/opportunities carry queue-pressure warnings.`,
    });
  }
  return {
    login: profile.login,
    generatedAt: nowIso(),
    profile,
    summary: `${profile.login} has ${profile.registeredRepoActivity.pullRequests} ${profile.source === "gittensor_api" ? "Gittensor API" : "cached"} registered-repo PR(s), ${profile.registeredRepoActivity.mergedPullRequests} merged PR(s), and ${opportunities.length} ranked opportunity/opportunities.`,
    languageFit,
    repoStats,
    opportunities,
    findings,
  };
}

export function buildRoleContext(args: {
  login: string;
  repo: RepositoryRecord | null;
  repoFullName: string;
  pullRequests?: PullRequestRecord[] | undefined;
  issues?: IssueRecord[] | undefined;
  profile?: ContributorProfile | null | undefined;
}): RoleContext {
  const normalizedLogin = args.login.toLowerCase();
  const [owner] = args.repoFullName.split("/");
  const authoredAssociations = [
    ...(args.pullRequests ?? []).filter((pr) => pr.repoFullName === args.repoFullName && sameLogin(pr.authorLogin, args.login)).map((pr) => pr.authorAssociation),
    ...(args.issues ?? []).filter((issue) => issue.repoFullName === args.repoFullName && sameLogin(issue.authorLogin, args.login)).map((issue) => issue.authorAssociation),
  ].filter(Boolean) as string[];
  const officialRepo = args.profile?.gittensor?.repositories.find((repo) => repo.repoFullName.toLowerCase() === args.repoFullName.toLowerCase());
  const touchedByOfficial = Boolean(officialRepo && officialRepo.pullRequests + officialRepo.openIssues + officialRepo.closedIssues > 0);
  const touchedByCache = Boolean(
    args.profile?.registeredRepoActivity.reposTouched.some((repo) => repo.toLowerCase() === args.repoFullName.toLowerCase()) ||
      (args.pullRequests ?? []).some((pr) => pr.repoFullName === args.repoFullName && sameLogin(pr.authorLogin, args.login)) ||
      (args.issues ?? []).some((issue) => issue.repoFullName === args.repoFullName && sameLogin(issue.authorLogin, args.login)),
  );

  let role: ContributorRole = "unknown";
  let source: RoleContext["source"] = "unknown";
  const association = strongestAssociation(authoredAssociations);
  if (owner?.toLowerCase() === normalizedLogin || args.repo?.owner.toLowerCase() === normalizedLogin) {
    role = "owner";
    source = "repo_owner_match";
  } else if (association === "OWNER") {
    role = "owner";
    source = "github_association";
  } else if (association === "MEMBER") {
    role = "org_member";
    source = "github_association";
  } else if (association === "COLLABORATOR") {
    role = "collaborator";
    source = "github_association";
  } else if (authoredAssociations.some(isMaintainerAssociation)) {
    role = "repo_maintainer";
    source = "github_association";
  } else if (touchedByOfficial) {
    role = "outside_contributor";
    source = "gittensor_api";
  } else if (touchedByCache) {
    role = "outside_contributor";
    source = "cache";
  }

  const maintainerLane = role === "owner" || role === "org_member" || role === "collaborator" || role === "repo_maintainer";
  const reasons = [
    ...(source === "repo_owner_match" ? [`${args.login} appears to own ${args.repoFullName}.`] : []),
    ...(source === "github_association" && association ? [`GitHub association for cached activity is ${association}.`] : []),
    ...(source === "gittensor_api" ? ["Official Gittensor API shows activity on this repo."] : []),
    ...(source === "cache" ? ["Cached GitHub activity shows activity on this repo."] : []),
    ...(maintainerLane ? ["Maintainer-associated repo activity should be treated separately from normal contributor evidence."] : []),
  ];
  return {
    login: args.login,
    repoFullName: args.repoFullName,
    generatedAt: nowIso(),
    role,
    maintainerLane,
    normalContributorEvidenceAllowed: !maintainerLane,
    source,
    association,
    reasons: reasons.length > 0 ? reasons : ["No maintainer or contributor relationship is visible in current Gittensory data."],
    guidance: maintainerLane
      ? "Use maintainer-lane guidance for repo health, queue quality, labels, contributor triage, and maintainer_cut readiness; do not count this repo as normal contributor evidence for this user."
      : role === "outside_contributor"
        ? "Use contributor-lane guidance: fit, duplicate risk, open/closed pressure, linked issue quality, and review hygiene."
        : "Relationship is unknown; rely on public preflight signals until more GitHub or Gittensor data is available.",
  };
}

export function buildContributorOutcomeHistory(args: {
  login: string;
  profile: ContributorProfile;
  repositories: RepositoryRecord[];
  pullRequests: PullRequestRecord[];
  issues: IssueRecord[];
  repoStats: ContributorRepoStatRecord[];
  cachedRepoStats?: ContributorRepoStatRecord[] | undefined;
}): ContributorOutcomeHistory {
  const repoByName = new Map(args.repositories.map((repo) => [repo.fullName.toLowerCase(), repo]));
  const repoNamesByKey = new Map<string, { repoFullName: string; priority: number }>();
  const addRepoName = (repoFullName: string, priority: number) => {
    const key = repoFullName.toLowerCase();
    const current = repoNamesByKey.get(key);
    if (!current || priority >= current.priority) repoNamesByKey.set(key, { repoFullName, priority });
  };
  for (const repo of args.repositories) addRepoName(repo.fullName, 1);
  for (const repoFullName of args.profile.registeredRepoActivity.reposTouched) addRepoName(repoFullName, 2);
  for (const stat of args.repoStats.filter((stat) => sameLogin(stat.login, args.login))) addRepoName(stat.repoFullName, 2);
  for (const pr of args.pullRequests.filter((pr) => sameLogin(pr.authorLogin, args.login))) addRepoName(pr.repoFullName, 3);
  for (const issue of args.issues.filter((issue) => sameLogin(issue.authorLogin, args.login))) addRepoName(issue.repoFullName, 3);
  for (const repo of args.profile.gittensor?.repositories ?? []) addRepoName(repo.repoFullName, 4);
  const repoNames = new Set([...repoNamesByKey.values()].map((entry) => entry.repoFullName));
  const officialByRepo = new Map(args.profile.gittensor?.repositories.map((repo) => [repo.repoFullName.toLowerCase(), repo]) ?? []);
  const statsByRepo = new Map(args.repoStats.filter((stat) => sameLogin(stat.login, args.login)).map((stat) => [stat.repoFullName.toLowerCase(), stat]));
  const repoOutcomes = [...repoNames]
    .sort()
    .map((repoFullName) => {
      const repo = repoByName.get(repoFullName.toLowerCase()) ?? null;
      const official = officialByRepo.get(repoFullName.toLowerCase());
      const cachedStat = statsByRepo.get(repoFullName.toLowerCase());
      const cachedPrs = args.pullRequests.filter((pr) => sameRepo(pr.repoFullName, repoFullName) && sameLogin(pr.authorLogin, args.login));
      const cachedIssues = args.issues.filter((issue) => sameRepo(issue.repoFullName, repoFullName) && sameLogin(issue.authorLogin, args.login));
      const pullRequests = official?.pullRequests ?? Math.max(cachedPrs.length, cachedStat?.pullRequests ?? 0);
      const mergedPullRequests = official?.mergedPullRequests ?? Math.max(cachedPrs.filter((pr) => pr.mergedAt || pr.state === "merged").length, cachedStat?.mergedPullRequests ?? 0);
      const openPullRequests = official?.openPullRequests ?? Math.max(cachedPrs.filter((pr) => pr.state === "open").length, cachedStat?.openPullRequests ?? 0);
      const closedPullRequests = official?.closedPullRequests ?? Math.max(cachedPrs.filter((pr) => pr.state === "closed" && !pr.mergedAt).length, pullRequests - mergedPullRequests - openPullRequests, 0);
      const openIssues = official?.openIssues ?? cachedIssues.filter((issue) => issue.state === "open").length;
      const closedIssues = official?.closedIssues ?? cachedIssues.filter((issue) => issue.state !== "open").length;
      const solvedIssues = official?.solvedIssues ?? 0;
      const validSolvedIssues = official?.validSolvedIssues ?? 0;
      const roleContext = buildRoleContext({ login: args.login, repo, repoFullName, pullRequests: args.pullRequests, issues: args.issues, profile: args.profile });
      const closedPullRequestRate = rate(closedPullRequests, pullRequests);
      const lane = buildLaneAdvice(repo, repoFullName).lane;
      const risks = [
        ...(roleContext.maintainerLane ? ["Maintainer-lane repo; do not treat this as normal contributor evidence."] : []),
        ...(closedPullRequestRate >= 0.3 ? [`Closed PR rate is ${percent(closedPullRequestRate)}.`] : []),
        ...(openPullRequests >= 5 ? [`${openPullRequests} open PR(s) create review and threshold pressure.`] : []),
        ...(openIssues >= 10 && validSolvedIssues === 0 ? ["Issue activity is mostly open/raw, not valid solved issue-discovery evidence."] : []),
        ...((official?.credibility ?? 1) < 0.8 ? [`Repo credibility is ${round(official?.credibility ?? 0)}.`] : []),
      ];
      const strengths = [
        ...(mergedPullRequests >= 5 ? [`${mergedPullRequests} merged PR(s) show strong repo-specific history.`] : []),
        ...(mergedPullRequests > 0 && closedPullRequestRate < 0.25 ? ["Merged history is stronger than closed-PR pressure."] : []),
        ...(validSolvedIssues > 0 ? [`${validSolvedIssues} valid solved issue-discovery report(s).`] : []),
        ...((official?.credibility ?? 0) >= 0.9 ? ["Official repo credibility is strong."] : []),
      ];
      const successLevel: ContributorOutcomeHistory["repoOutcomes"][number]["successLevel"] = roleContext.maintainerLane
        ? "maintainer_context"
        : mergedPullRequests >= 5 && closedPullRequestRate < 0.3
          ? "strong"
          : mergedPullRequests > 0
            ? "emerging"
            : "weak";
      return {
        repoFullName,
        role: roleContext.role,
        lane,
        maintainerLane: roleContext.maintainerLane,
        pullRequests,
        mergedPullRequests,
        openPullRequests,
        closedPullRequests,
        closedPullRequestRate,
        issues: openIssues + closedIssues,
        openIssues,
        closedIssues,
        solvedIssues,
        validSolvedIssues,
        credibility: official?.credibility ?? 0,
        issueCredibility: official?.issueCredibility ?? 0,
        isEligible: Boolean(official?.isEligible),
        successLevel,
        strengths: strengths.length > 0 ? strengths : ["No strong success pattern detected yet."],
        risks: risks.length > 0 ? risks : ["No major repo-specific risk detected from current signals."],
      };
    })
    .filter((outcome) => outcome.pullRequests + outcome.issues > 0 || outcome.maintainerLane);
  const totals = {
    pullRequests: args.profile.gittensor?.totals.pullRequests ?? args.profile.registeredRepoActivity.pullRequests,
    mergedPullRequests: args.profile.gittensor?.totals.mergedPullRequests ?? args.profile.registeredRepoActivity.mergedPullRequests,
    openPullRequests: args.profile.gittensor?.totals.openPullRequests ?? args.repoStats.reduce((sum, stat) => sum + stat.openPullRequests, 0),
    closedPullRequests: args.profile.gittensor?.totals.closedPullRequests ?? repoOutcomes.reduce((sum, outcome) => sum + outcome.closedPullRequests, 0),
    closedPullRequestRate: 0,
    issues: args.profile.registeredRepoActivity.issues,
    openIssues: args.profile.gittensor?.totals.openIssues ?? repoOutcomes.reduce((sum, outcome) => sum + outcome.openIssues, 0),
    closedIssues: args.profile.gittensor?.totals.closedIssues ?? repoOutcomes.reduce((sum, outcome) => sum + outcome.closedIssues, 0),
    solvedIssues: args.profile.gittensor?.totals.solvedIssues ?? 0,
    validSolvedIssues: args.profile.gittensor?.totals.validSolvedIssues ?? 0,
    credibility: args.profile.gittensor?.credibility ?? 0,
    issueCredibility: args.profile.gittensor?.issueCredibility ?? 0,
  };
  totals.closedPullRequestRate = rate(totals.closedPullRequests, totals.pullRequests);
  const history = {
    login: args.login,
    generatedAt: nowIso(),
    source: args.profile.source,
    reconciliation: undefined as ContributorReconciliationReport | undefined,
    totals,
    repoOutcomes,
    successPatterns: [] as OutcomePattern[],
    failurePatterns: [] as OutcomePattern[],
    summary: "",
  };
  history.successPatterns = outcomeSuccessPatterns(history);
  history.failurePatterns = outcomeFailurePatterns(history);
  history.reconciliation = buildContributorReconciliationReport({ ...args, history });
  history.summary = `${args.login} has ${totals.pullRequests} official/cached PR(s), ${totals.mergedPullRequests} merged, ${totals.closedPullRequests} closed, ${totals.openPullRequests} open, and ${history.repoOutcomes.length} repo-specific outcome profile(s).`;
  return history;
}

export function buildContributorReconciliationReport(args: {
  login: string;
  profile: ContributorProfile;
  repositories: RepositoryRecord[];
  pullRequests: PullRequestRecord[];
  issues: IssueRecord[];
  repoStats: ContributorRepoStatRecord[];
  cachedRepoStats?: ContributorRepoStatRecord[] | undefined;
  history?: ContributorOutcomeHistory | undefined;
}): ContributorReconciliationReport {
  const cachedStats = args.cachedRepoStats ?? args.repoStats;
  const repoNamesByKey = new Map<string, { repoFullName: string; priority: number }>();
  const addRepoName = (repoFullName: string, priority: number) => {
    const key = repoFullName.toLowerCase();
    const current = repoNamesByKey.get(key);
    if (!current || priority >= current.priority) repoNamesByKey.set(key, { repoFullName, priority });
  };
  for (const repoFullName of args.profile.registeredRepoActivity.reposTouched) addRepoName(repoFullName, 1);
  for (const stat of cachedStats.filter((stat) => sameLogin(stat.login, args.login))) addRepoName(stat.repoFullName, 2);
  for (const pr of args.pullRequests.filter((pr) => sameLogin(pr.authorLogin, args.login))) addRepoName(pr.repoFullName, 3);
  for (const issue of args.issues.filter((issue) => sameLogin(issue.authorLogin, args.login))) addRepoName(issue.repoFullName, 3);
  for (const repo of args.profile.gittensor?.repositories ?? []) addRepoName(repo.repoFullName, 4);
  const officialByRepo = new Map(args.profile.gittensor?.repositories.map((repo) => [repo.repoFullName.toLowerCase(), repo]) ?? []);
  const statByRepo = new Map(cachedStats.filter((stat) => sameLogin(stat.login, args.login)).map((stat) => [stat.repoFullName.toLowerCase(), stat]));
  const repoByName = new Map(args.repositories.map((repo) => [repo.fullName.toLowerCase(), repo]));
  const officialAuthoritative = Boolean(args.profile.gittensor);
  const repos = [...repoNamesByKey.values()].map((entry) => entry.repoFullName).sort((left, right) => left.localeCompare(right)).map((repoFullName) => {
    const key = repoFullName.toLowerCase();
    const official = officialByRepo.get(key);
    const cached = cachedReconciliationCounts(args.login, repoFullName, args.pullRequests, args.issues, statByRepo.get(key));
    const officialCounts = official
      ? {
          pullRequests: official.pullRequests,
          mergedPullRequests: official.mergedPullRequests,
          openPullRequests: official.openPullRequests,
          closedPullRequests: official.closedPullRequests,
          issues: official.openIssues + official.closedIssues,
          openIssues: official.openIssues,
          closedIssues: official.closedIssues,
          solvedIssues: official.solvedIssues,
          validSolvedIssues: official.validSolvedIssues,
        }
      : undefined;
    const repo = repoByName.get(key);
    const [repoOwner] = repoFullName.split("/");
    const maintainerLane =
      sameLogin(repo?.owner, args.login) ||
      sameLogin(repoOwner, args.login) ||
      args.pullRequests.some((pr) => sameRepo(pr.repoFullName, repoFullName) && sameLogin(pr.authorLogin, args.login) && isMaintainerAssociation(pr.authorAssociation)) ||
      args.issues.some((issue) => sameRepo(issue.repoFullName, repoFullName) && sameLogin(issue.authorLogin, args.login) && isMaintainerAssociation(issue.authorAssociation));
    return {
      repoFullName,
      maintainerLane,
      official: officialCounts,
      cached,
      effective: officialCounts ?? (officialAuthoritative ? emptyOutcomeCounts() : cached),
      discrepancyReasons: reconciliationReasons(officialCounts, cached, maintainerLane, officialAuthoritative),
      freshness: {
        officialUpdatedAt: args.profile.gittensor?.updatedAt ?? args.profile.gittensor?.evaluatedAt,
        cachedLastActivityAt: cachedLastActivityAt(args.login, repoFullName, args.pullRequests, args.issues),
      },
    };
  });
  const cachedTotals = sumReconciliationCounts(repos.map((repo) => repo.cached));
  const officialTotals = args.profile.gittensor
    ? {
        pullRequests: args.profile.gittensor.totals.pullRequests,
        mergedPullRequests: args.profile.gittensor.totals.mergedPullRequests,
        openPullRequests: args.profile.gittensor.totals.openPullRequests,
        closedPullRequests: args.profile.gittensor.totals.closedPullRequests,
        closedPullRequestRate: rate(args.profile.gittensor.totals.closedPullRequests, args.profile.gittensor.totals.pullRequests),
        issues: args.profile.gittensor.totals.openIssues + args.profile.gittensor.totals.closedIssues,
        openIssues: args.profile.gittensor.totals.openIssues,
        closedIssues: args.profile.gittensor.totals.closedIssues,
        solvedIssues: args.profile.gittensor.totals.solvedIssues,
        validSolvedIssues: args.profile.gittensor.totals.validSolvedIssues,
        credibility: args.profile.gittensor.credibility,
        issueCredibility: args.profile.gittensor.issueCredibility,
      }
    : undefined;
  const findings: SignalFinding[] = [
    ...(!officialTotals
      ? [
          {
            code: "official_source_unavailable",
            severity: "warning" as const,
            title: "Official contributor totals unavailable",
            detail: "Cached GitHub history is context only until official contributor totals are available.",
          },
        ]
      : []),
    ...repos
      .filter((repo) => repo.maintainerLane)
      .map((repo) => ({
        code: "maintainer_lane_context",
        severity: "info" as const,
        title: "Maintainer-lane history is separated",
        detail: `${repo.repoFullName} is maintainer-associated context and should not inflate normal contributor evidence.`,
      })),
  ];
  return {
    login: args.login,
    generatedAt: nowIso(),
    source: args.profile.source,
    officialAuthoritative: Boolean(officialTotals),
    totals: { official: officialTotals, cached: cachedTotals, effective: officialTotals ?? cachedTotals },
    repos,
    findings,
    summary: `${args.login} reconciliation: ${officialTotals ? "official totals authoritative" : "cached context only"}; ${repos.length} repo(s) compared.`,
  };
}

function cachedReconciliationCounts(
  login: string,
  repoFullName: string,
  pullRequests: PullRequestRecord[],
  issues: IssueRecord[],
  stat?: ContributorRepoStatRecord | undefined,
): ContributorOutcomeCounts {
  const cachedPrs = pullRequests.filter((pr) => sameRepo(pr.repoFullName, repoFullName) && sameLogin(pr.authorLogin, login));
  const cachedIssues = issues.filter((issue) => sameRepo(issue.repoFullName, repoFullName) && sameLogin(issue.authorLogin, login));
  const mergedPullRequests = Math.max(cachedPrs.filter((pr) => pr.mergedAt || pr.state === "merged").length, stat?.mergedPullRequests ?? 0);
  const openPullRequests = Math.max(cachedPrs.filter((pr) => pr.state === "open").length, stat?.openPullRequests ?? 0);
  const pullRequestCount = Math.max(cachedPrs.length, stat?.pullRequests ?? 0);
  const closedUnmergedPullRequests = cachedPrs.filter((pr) => pr.state === "closed" && !pr.mergedAt).length;
  const closedPullRequests = Math.max(closedUnmergedPullRequests, pullRequestCount - mergedPullRequests - openPullRequests, 0);
  const openIssueRows = cachedIssues.filter((issue) => issue.state === "open").length;
  const closedIssueRows = cachedIssues.filter((issue) => issue.state !== "open").length;
  const issueCount = Math.max(cachedIssues.length, stat?.issues ?? 0);
  const openIssues = openIssueRows;
  const closedIssues = Math.max(closedIssueRows, issueCount - openIssues, 0);
  return {
    pullRequests: pullRequestCount,
    mergedPullRequests,
    openPullRequests,
    closedPullRequests,
    issues: issueCount,
    openIssues,
    closedIssues,
    solvedIssues: 0,
    validSolvedIssues: 0,
  };
}

function sumReconciliationCounts(counts: ContributorOutcomeCounts[]): ContributorOutcomeHistory["totals"] {
  const summed = counts.reduce(
    (acc, count) => ({
      pullRequests: acc.pullRequests + count.pullRequests,
      mergedPullRequests: acc.mergedPullRequests + count.mergedPullRequests,
      openPullRequests: acc.openPullRequests + count.openPullRequests,
      closedPullRequests: acc.closedPullRequests + count.closedPullRequests,
      issues: acc.issues + count.issues,
      openIssues: acc.openIssues + count.openIssues,
      closedIssues: acc.closedIssues + count.closedIssues,
      solvedIssues: acc.solvedIssues + count.solvedIssues,
      validSolvedIssues: acc.validSolvedIssues + count.validSolvedIssues,
    }),
    { pullRequests: 0, mergedPullRequests: 0, openPullRequests: 0, closedPullRequests: 0, issues: 0, openIssues: 0, closedIssues: 0, solvedIssues: 0, validSolvedIssues: 0 },
  );
  return { ...summed, closedPullRequestRate: rate(summed.closedPullRequests, summed.pullRequests), credibility: 0, issueCredibility: 0 };
}

function emptyOutcomeCounts(): ContributorOutcomeCounts {
  return { pullRequests: 0, mergedPullRequests: 0, openPullRequests: 0, closedPullRequests: 0, issues: 0, openIssues: 0, closedIssues: 0, solvedIssues: 0, validSolvedIssues: 0 };
}

function reconciliationReasons(official: ContributorOutcomeCounts | undefined, cached: ContributorOutcomeCounts, maintainerLane: boolean, officialAuthoritative: boolean): string[] {
  return [
    ...(!official && officialAuthoritative && cached.pullRequests + cached.issues > 0 ? ["Official source omits this repo; cached GitHub history is context only."] : []),
    ...(!official && !officialAuthoritative ? ["Official source unavailable; cached GitHub history is context only."] : []),
    ...(official && official.pullRequests !== cached.pullRequests
      ? [`Official PR total ${official.pullRequests} differs from cached GitHub context ${cached.pullRequests}; official total is authoritative.`]
      : []),
    ...(official && official.mergedPullRequests !== cached.mergedPullRequests
      ? [`Official merged PR total ${official.mergedPullRequests} differs from cached GitHub context ${cached.mergedPullRequests}; official merge data is authoritative.`]
      : []),
    ...(official && official.openPullRequests !== cached.openPullRequests ? ["Official open PR count differs from cached GitHub context; refresh timing or lookback windows may differ."] : []),
    ...(official && official.closedPullRequests !== cached.closedPullRequests ? ["Official closed PR count differs from cached closed-unmerged context."] : []),
    ...(official && official.issues !== cached.issues
      ? [`Official issue total ${official.issues} differs from cached GitHub context ${cached.issues}; official issue data is authoritative.`]
      : []),
    ...(official && official.openIssues !== cached.openIssues ? ["Official open issue count differs from cached GitHub context."] : []),
    ...(official && official.closedIssues !== cached.closedIssues ? ["Official closed issue count differs from cached GitHub context."] : []),
    ...(official && official.solvedIssues !== cached.solvedIssues ? ["Official solved issue count differs from cached solver context."] : []),
    ...(official && official.validSolvedIssues !== cached.validSolvedIssues ? ["Official valid-solved issue count differs from cached solver context."] : []),
    ...(maintainerLane ? ["Maintainer-owned repo history is separated from normal contributor evidence."] : []),
  ];
}

function cachedLastActivityAt(login: string, repoFullName: string, pullRequests: PullRequestRecord[], issues: IssueRecord[]): string | undefined {
  return [...pullRequests, ...issues]
    .filter((item) => sameRepo(item.repoFullName, repoFullName) && sameLogin(item.authorLogin, login))
    .map((item) => item.updatedAt ?? item.createdAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

export function buildContributorPatternReport(history: ContributorOutcomeHistory, patternType: "success" | "failure"): ContributorPatternReport {
  const patterns = patternType === "success" ? history.successPatterns : history.failurePatterns;
  return {
    login: history.login,
    generatedAt: nowIso(),
    patternType,
    patterns,
    summary: `${patterns.length} ${patternType} pattern(s) generated from ${history.source === "gittensor_api" ? "official Gittensor API plus cached GitHub" : "cached GitHub"} evidence.`,
  };
}

export function buildRepoFitRecommendation(args: {
  login: string;
  repo: RepositoryRecord | null;
  repoFullName: string;
  profile: ContributorProfile;
  outcomeHistory: ContributorOutcomeHistory;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
}): RepoFitRecommendation {
  const roleContext = buildRoleContext({ login: args.login, repo: args.repo, repoFullName: args.repoFullName, pullRequests: args.pullRequests, issues: args.issues, profile: args.profile });
  const lane = buildLaneAdvice(args.repo, args.repoFullName);
  const repoOutcome = args.outcomeHistory.repoOutcomes.find((outcome) => outcome.repoFullName.toLowerCase() === args.repoFullName.toLowerCase());
  const collisions = buildCollisionReport(args.repoFullName, args.issues, args.pullRequests);
  const queueHealth = buildQueueHealth(args.repo, args.issues, args.pullRequests, collisions);
  const risks = [
    ...(repoOutcome?.risks ?? []),
    ...(lane.lane === "inactive" || lane.lane === "unknown" ? [lane.summary] : []),
    ...(queueHealth.level === "high" || queueHealth.level === "critical" ? [`Queue burden is ${queueHealth.level}.`] : []),
    ...(collisions.summary.highRiskCount > 0 ? [`${collisions.summary.highRiskCount} high-risk collision cluster(s).`] : []),
  ];
  const reasons = [
    lane.summary,
    ...(repoOutcome?.strengths ?? []),
    ...(roleContext.reasons ?? []),
  ];
  const recommendation: RepoFitRecommendation["recommendation"] = roleContext.maintainerLane
    ? "maintainer_lane"
    : lane.lane === "unknown" || lane.lane === "inactive"
      ? "unknown"
      : (repoOutcome?.openPullRequests ?? 0) >= 5 || (repoOutcome?.closedPullRequestRate ?? 0) >= 0.35 || queueHealth.level === "critical"
        ? "cleanup_first"
        : risks.some((risk) => /collision|Queue burden is high|direct-PR first/i.test(risk))
          ? "avoid_for_now"
          : "pursue";
  const nextActions = [
    ...(recommendation === "maintainer_lane" ? ["Use repo-health and contributor-triage actions instead of normal contributor work for this repo."] : []),
    ...(recommendation === "cleanup_first" ? ["Close, land, or update existing open work before opening another PR."] : []),
    ...(recommendation === "avoid_for_now" ? ["Pick a lower-collision or lower-burden repo unless the work is already well proven."] : []),
    ...(recommendation === "pursue" ? ["Run local diff preflight, check collisions, and keep the submission tightly scoped."] : []),
    ...(lane.lane === "issue_discovery" ? ["Use issue-discovery quality gates; do not file issues you plan to solve yourself."] : []),
  ];
  return {
    login: args.login,
    repoFullName: args.repoFullName,
    generatedAt: nowIso(),
    roleContext,
    lane,
    recommendation,
    confidence: args.profile.source === "gittensor_api" || repoOutcome ? "high" : args.repo ? "medium" : "low",
    reasons: [...new Set(reasons)],
    risks: [...new Set(risks)],
    nextActions: [...new Set(nextActions.length > 0 ? nextActions : ["Gather more repo-specific evidence before acting."])],
  };
}

export function buildContributorIntakeHealth(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  fullName: string,
  collisions = buildCollisionReport(fullName, issues, pullRequests),
  countOverrides: QueueSignalCounts = {},
): ContributorIntakeHealth {
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions, countOverrides);
  const configQuality = buildConfigQuality(repo, issues, pullRequests, fullName);
  const configPenalty = configQuality.level === "fragile" ? 30 : configQuality.level === "needs_attention" ? 18 : configQuality.level === "good" ? 6 : 0;
  const score = clamp(100 - queueHealth.burdenScore * 0.55 - collisions.summary.clusterCount * 8 - configPenalty, 0, 100);
  const level: ContributorIntakeHealth["level"] = score >= 75 ? "healthy" : score >= 50 ? "watch" : score >= 25 ? "strained" : "blocked";
  const findings: SignalFinding[] = [
    ...(queueHealth.findings ?? []),
    ...(configQuality.findings ?? []),
    ...(collisions.summary.highRiskCount > 0
      ? [
          {
            code: "high_risk_collisions",
            severity: "warning" as const,
            title: "High-risk duplicate clusters are present",
            detail: `${collisions.summary.highRiskCount} high-risk collision cluster(s) should be triaged before inviting more contributor work.`,
          },
        ]
      : []),
  ];
  return {
    repoFullName: fullName,
    generatedAt: nowIso(),
    level,
    score,
    queueHealth: {
      burdenScore: queueHealth.burdenScore,
      level: queueHealth.level,
      signals: queueHealth.signals,
    },
    configLevel: configQuality.level,
    duplicateClusters: collisions.summary.clusterCount,
    reviewablePullRequests: queueHealth.signals.likelyReviewablePullRequests,
    summary: `Contributor intake is ${level}; queue burden ${queueHealth.burdenScore}/100, config ${configQuality.level}, duplicate clusters ${collisions.summary.clusterCount}.`,
    findings,
  };
}

export function buildMaintainerCutReadiness(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  fullName: string,
  countOverrides: QueueSignalCounts = {},
  collisions = buildCollisionReport(fullName, issues, pullRequests),
): MaintainerCutReadiness {
  const configQuality = buildConfigQuality(repo, issues, pullRequests, fullName);
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions, countOverrides);
  const maintainerCut = repo?.registryConfig?.maintainerCut ?? 0;
  const warnings = [
    ...(!repo?.isRegistered ? ["Repository is not registered in the local snapshot."] : []),
    ...(configQuality.level === "fragile" || configQuality.level === "needs_attention" ? [`Config quality is ${configQuality.level}.`] : []),
    ...(queueHealth.level === "high" || queueHealth.level === "critical" ? [`Queue burden is ${queueHealth.level}.`] : []),
  ];
  const ready = Boolean(repo?.isRegistered) && warnings.length === 0;
  return {
    repoFullName: fullName,
    generatedAt: nowIso(),
    ready,
    maintainerCut,
    recommendedAction: maintainerCut > 0 ? "review_existing_cut" : ready ? "consider_small_cut" : repo?.isRegistered ? "fix_config_first" : "leave_disabled",
    reasons: [
      ...(maintainerCut > 0 ? [`Current maintainer_cut is ${maintainerCut}.`] : ["No maintainer_cut is configured."]),
      ...(ready ? ["Repo config and queue signals are clean enough to discuss maintainer-lane economics privately."] : []),
    ],
    warnings,
  };
}

export function buildMaintainerLaneReport(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  fullName: string,
  collisions = buildCollisionReport(fullName, issues, pullRequests),
  countOverrides: QueueSignalCounts = {},
): MaintainerLaneReport {
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions, countOverrides);
  const configQuality = buildConfigQuality(repo, issues, pullRequests, fullName);
  const contributorIntakeHealth = buildContributorIntakeHealth(repo, issues, pullRequests, fullName, collisions, countOverrides);
  const maintainerCut = repo?.registryConfig?.maintainerCut ?? 0;
  const findings: SignalFinding[] = [
    ...(maintainerCut === 0
      ? [
          {
            code: "maintainer_cut_not_configured",
            severity: "info" as const,
            title: "Maintainer cut is not configured",
            detail: "Maintainer-associated work is separate from normal contributor evidence; maintainer_cut is the explicit maintainer lane when configured.",
          },
        ]
      : []),
    ...contributorIntakeHealth.findings,
  ];
  return {
    repoFullName: fullName,
    generatedAt: nowIso(),
    lane: buildLaneAdvice(repo, fullName),
    maintainerCut,
    maintainerCutConfigured: maintainerCut > 0,
    queueHealth,
    configQuality,
    contributorIntakeHealth,
    summary: `Maintainer lane for ${fullName}: maintainer_cut ${maintainerCut > 0 ? "configured" : "not configured"}, contributor intake ${contributorIntakeHealth.level}.`,
    findings,
  };
}

export function buildPreflightResult(
  input: PreflightInput,
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  issueQuality?: IssueQualityReport | null | undefined,
): PreflightResult {
  const lane = buildLaneAdvice(repo, input.repoFullName);
  const linkedIssues = [...new Set([...(input.linkedIssues ?? []), ...extractLinkedIssueNumbers(input.body ?? "")])].sort((left, right) => left - right);
  const collisions = buildCollisionReport(input.repoFullName, issues, pullRequests).clusters.filter((cluster) =>
    cluster.items.some((item) => linkedIssues.includes(item.number) || item.title.toLowerCase().includes(input.title.toLowerCase())),
  );
  const findings: SignalFinding[] = [];
  if (lane.lane === "unknown" || lane.lane === "inactive") {
    findings.push({
      code: "lane_not_recommended",
      severity: "warning",
      title: "Repo lane is not ready for a confident recommendation",
      detail: lane.summary,
      action: "Refresh registry data or choose a registered active repo.",
    });
  }
  if (linkedIssues.length === 0 && lane.lane !== "issue_discovery") {
    findings.push({
      code: "missing_linked_issue",
      severity: "warning",
      title: "No linked issue detected",
      detail: "The planned PR does not reference a closing issue or explicit linked issue number.",
      action: "Link the issue being solved, or explicitly explain why this is a no-issue PR.",
    });
  }
  if (collisions.length > 0) {
    findings.push({
      code: "possible_duplicate_work",
      severity: collisions.some((cluster) => cluster.risk === "high") ? "warning" : "info",
      title: "Possible duplicate or overlapping work",
      detail: `${collisions.length} related open work cluster(s) were detected.`,
      action: "Check active issues and PRs before submitting.",
    });
  }
  findings.push(...issueQualityFindings(linkedIssues, issueQuality));
  const changedFiles = input.changedFiles ?? [];
  const tests = input.tests ?? [];
  if (changedFiles.some((file) => isCodeFile(file)) && tests.length === 0 && !changedFiles.some((file) => isTestFile(file))) {
    findings.push({
      code: "missing_test_evidence",
      severity: "warning",
      title: "No test evidence supplied",
      detail: "Code files are listed, but no tests or test files were supplied in preflight input.",
      action: "Add focused test evidence or explain why existing coverage is sufficient.",
    });
  }
  const reviewBurden = changedFiles.length >= 12 || collisions.length > 0 ? "high" : changedFiles.length >= 5 ? "medium" : "low";
  const hasWarning = findings.some((finding) => finding.severity === "warning" || finding.severity === "critical");
  return {
    repoFullName: input.repoFullName,
    generatedAt: nowIso(),
    status: lane.lane === "unknown" || lane.lane === "inactive" ? "hold" : hasWarning ? "needs_work" : "ready",
    lane,
    reviewBurden,
    linkedIssues,
    findings,
    collisions,
  };
}

export function buildLocalDiffPreflightResult(
  input: LocalDiffPreflightInput,
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  issueQuality?: IssueQualityReport | null | undefined,
): LocalDiffPreflightResult {
  const changedFiles = [...new Set([...(input.changedFiles ?? []), ...(input.testFiles ?? [])])];
  const linkedFromCommit = extractLinkedIssueNumbers([input.commitMessage, input.body, input.title].filter(Boolean).join("\n"));
  const base = buildPreflightResult(
    {
      ...input,
      changedFiles,
      linkedIssues: [...new Set([...(input.linkedIssues ?? []), ...linkedFromCommit])],
      tests: [...(input.tests ?? []), ...(input.testFiles ?? [])],
    },
    repo,
    issues,
    pullRequests,
    issueQuality,
  );
  const codeFileCount = changedFiles.filter(isCodeFile).length;
  const testFileCount = changedFiles.filter(isTestFile).length;
  const changedLineCount = input.changedLineCount ?? 0;
  const findings = [...base.findings];
  if (changedLineCount > 800) {
    findings.push({
      code: "large_local_diff",
      severity: "warning",
      title: "Local diff is large",
      detail: "The planned change is large enough to create avoidable review burden.",
      action: "Split unrelated work or clearly explain why the scope needs to stay together.",
    });
  }
  if (codeFileCount > 0 && testFileCount === 0 && (input.tests ?? []).length === 0) {
    findings.push({
      code: "local_diff_missing_tests",
      severity: "warning",
      title: "Local diff has code changes without test files",
      detail: "Changed paths include code files but no test paths.",
      action: "Add regression coverage or include concrete validation evidence.",
    });
  }
  return {
    ...base,
    findings,
    status: base.status === "hold" ? "hold" : findings.some((finding) => finding.severity === "warning" || finding.severity === "critical") ? "needs_work" : "ready",
    localDiff: {
      changedFileCount: changedFiles.length,
      changedLineCount,
      testFileCount,
      codeFileCount,
      inferredLinkedIssues: linkedFromCommit,
      summary: `${changedFiles.length} file(s), ${changedLineCount} changed line(s), ${testFileCount} test file(s), ${codeFileCount} code file(s).`,
    },
  };
}

export function buildMaintainerPacket(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  fullName: string,
): MaintainerPacket {
  const collisions = buildCollisionReport(fullName, issues, pullRequests);
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
  const configQuality = buildConfigQuality(repo, issues, pullRequests, fullName);
  const pullRequestPackets = pullRequests
    .filter((pr) => pr.state === "open")
    .slice(0, 25)
    .map((pr) => {
      const reasons = [
        ...(pr.linkedIssues.length === 0 ? ["Missing linked issue context."] : []),
        ...(isMaintainerAssociation(pr.authorAssociation) ? ["Author has maintainer association."] : []),
        ...(collisions.clusters.some((cluster) => cluster.items.some((item) => item.type === "pull_request" && item.number === pr.number))
          ? ["Potential overlap with other open work."]
          : []),
        ...(pr.labels.length > 0 ? [`Labels: ${pr.labels.join(", ")}.`] : []),
      ];
      return {
        number: pr.number,
        title: pr.title,
        authorLogin: pr.authorLogin,
        reviewPriority: reasons.some((reason) => reason.includes("Missing") || reason.includes("overlap")) ? "needs_author" : "review",
        reasons: reasons.length > 0 ? reasons : ["No obvious queue hygiene issue detected in cached metadata."],
      } as const;
    });
  const suggestedActions = [
    ...(queueHealth.signals.unlinkedPullRequests > 0 ? ["Ask authors of unlinked PRs to add issue context or a no-issue rationale."] : []),
    ...(collisions.summary.clusterCount > 0 ? ["Triage overlap clusters before deep technical review."] : []),
    ...(configQuality.level === "fragile" || configQuality.level === "needs_attention" ? ["Review repo Gittensor config quality before inviting more contributor flow."] : []),
    ...(queueHealth.level === "critical" || queueHealth.level === "high" ? ["Prioritize queue clearing before encouraging new work."] : []),
  ];
  return {
    repoFullName: fullName,
    generatedAt: nowIso(),
    queueHealth,
    configQuality,
    collisions,
    pullRequestPackets,
    suggestedActions: suggestedActions.length > 0 ? suggestedActions : ["Queue looks manageable from cached Gittensory signals."],
  };
}

export function buildPullRequestMaintainerPacket(args: {
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
}): PullRequestMaintainerPacket {
  const pr = args.pullRequest;
  const collisions = buildCollisionReport(args.repoFullName, args.issues, args.pullRequests, args.recentMergedPullRequests);
  const prCollisionCount = pr
    ? collisions.clusters.filter((cluster) => cluster.items.some((item) => item.type === "pull_request" && item.number === pr.number)).length
    : 0;
  const codeFiles = args.files.filter((file) => isCodeFile(file.path));
  const testFiles = args.files.filter((file) => isTestFile(file.path));
  const additions = args.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = args.files.reduce((sum, file) => sum + file.deletions, 0);
  const approvalCount = args.reviews.filter((review) => review.state.toUpperCase() === "APPROVED").length;
  const changeRequestCount = args.reviews.filter((review) => review.state.toUpperCase() === "CHANGES_REQUESTED").length;
  const checkFailureCount = args.checks.filter((check) => check.conclusion === "failure" || check.conclusion === "timed_out" || check.conclusion === "cancelled").length;
  const findings: SignalFinding[] = [];
  if (!pr) {
    findings.push({
      code: "pr_not_cached",
      severity: "warning",
      title: "PR is not cached",
      detail: "Gittensory does not have this pull request in the local cache.",
    });
  } else {
    if (pr.linkedIssues.length === 0) {
      findings.push({
        code: "missing_linked_issue",
        severity: "warning",
        title: "No linked issue detected",
        detail: "The PR body does not include a closing issue reference in cached metadata.",
        action: "Ask for issue context or a no-issue rationale before deep review.",
      });
    }
    if (prCollisionCount > 0) {
      findings.push({
        code: "pr_collision_context",
        severity: "warning",
        title: "PR overlaps active or recent work",
        detail: `${prCollisionCount} collision cluster(s) include this PR.`,
        action: "Review overlap before spending detailed review time.",
      });
    }
    if (codeFiles.length > 0 && testFiles.length === 0) {
      findings.push({
        code: "missing_test_files",
        severity: "warning",
        title: "Code changes do not include cached test files",
        detail: "Cached file metadata includes code paths but no obvious test paths.",
        action: "Ask for test evidence or a clear validation note.",
      });
    }
    if (checkFailureCount > 0) {
      findings.push({
        code: "checks_need_attention",
        severity: "warning",
        title: "Checks need attention",
        detail: `${checkFailureCount} cached check(s) ended with a non-success conclusion.`,
      });
    }
  }
  const reviewPriority = findings.some((finding) => finding.severity === "warning" || finding.severity === "critical")
    ? "needs_author"
    : approvalCount > 0 && checkFailureCount === 0
      ? "review"
      : "watch";
  return {
    repoFullName: args.repoFullName,
    pullNumber: args.pullNumber,
    generatedAt: nowIso(),
    reviewPriority,
    summary: pr
      ? `PR #${pr.number} has ${args.files.length} cached file(s), ${args.reviews.length} review(s), ${args.checks.length} check summary/summaries, and ${prCollisionCount} collision cluster(s).`
      : `PR #${args.pullNumber} is not cached yet.`,
    changeSummary: {
      fileCount: args.files.length,
      codeFileCount: codeFiles.length,
      testFileCount: testFiles.length,
      additions,
      deletions,
      topPaths: args.files.map((file) => file.path).slice(0, 12),
    },
    reviewSignals: {
      reviewCount: args.reviews.length,
      approvalCount,
      changeRequestCount,
      checkFailureCount,
      linkedIssues: pr?.linkedIssues ?? [],
      collisionClusters: prCollisionCount,
    },
    findings,
    contributorNextSteps: findings.flatMap((finding) => (finding.action ? [finding.action] : [])),
    maintainerNotes: findings.length > 0 ? findings.map((finding) => finding.title) : ["No obvious maintainer-blocking signal in cached metadata."],
  };
}

export function buildPullRequestReviewIntelligence(args: {
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
}): PullRequestReviewIntelligence {
  const packet = buildPullRequestMaintainerPacket(args);
  const login = args.pullRequest?.authorLogin ?? args.profile?.login ?? "unknown";
  const roleContext = buildRoleContext({
    login,
    repo: args.repo,
    repoFullName: args.repoFullName,
    pullRequests: args.pullRequests,
    issues: args.issues,
    profile: args.profile,
  });
  const outcomeContext = args.outcomeHistory?.repoOutcomes.find((outcome) => outcome.repoFullName.toLowerCase() === args.repoFullName.toLowerCase());
  const recommendation: PullRequestReviewIntelligence["recommendation"] = roleContext.maintainerLane
    ? "maintainer_lane"
    : packet.reviewSignals.collisionClusters > 0
      ? "likely_duplicate"
      : packet.reviewPriority === "needs_author"
        ? "needs_author"
        : packet.reviewPriority === "review"
          ? "review"
          : "watch";
  return {
    ...packet,
    roleContext,
    outcomeContext,
    recommendation,
    privateSummary: [
      `Role: ${roleContext.role}${roleContext.maintainerLane ? " (maintainer lane)" : ""}.`,
      ...(outcomeContext ? [`Repo history: ${outcomeContext.mergedPullRequests} merged, ${outcomeContext.closedPullRequests} closed, ${outcomeContext.openPullRequests} open PR(s).`] : []),
      `Recommended maintainer action: ${recommendation}.`,
    ].join(" "),
  };
}

export function buildIssueQualityReport(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  fullName: string,
  prebuiltCollisions?: CollisionReport,
  recentMergedPullRequests: RecentMergedPullRequestRecord[] = [],
): IssueQualityReport {
  const lane = buildLaneAdvice(repo, fullName);
  const collisions = prebuiltCollisions ?? buildCollisionReport(fullName, issues, pullRequests, recentMergedPullRequests);
  const lifecycleByIssue = new Map(buildIssueDiscoveryLifecycleReport(repo, issues, pullRequests, fullName, recentMergedPullRequests).states.map((entry) => [entry.number, entry]));
  const reports = issues
    .filter((issue) => issue.state === "open")
    .slice(0, 100)
    .map((issue) => {
      const linkedPrs = pullRequests.filter((pr) => pr.linkedIssues.includes(issue.number) || issue.linkedPrs.includes(pr.number));
      const linkedMergedPrs = recentMergedPullRequests.filter((pr) => pr.linkedIssues.includes(issue.number) || issue.linkedPrs.includes(pr.number));
      const issueCollisions = collisions.clusters.filter((cluster) => cluster.items.some((item) => item.type === "issue" && item.number === issue.number));
      const age = daysSince(issue.updatedAt ?? issue.createdAt);
      const lifecycle = lifecycleByIssue.get(issue.number)?.state ?? "open";
      const bodyLength = issue.body?.trim().length ?? 0;
      const linkedWorkCount = linkedPrs.length + linkedMergedPrs.length + issue.linkedPrs.length;
      const reasons = [
        ...(bodyLength >= 200 ? ["Issue has enough body detail to evaluate."] : []),
        ...(issue.labels.length > 0 ? [`Labels: ${issue.labels.join(", ")}.`] : []),
        ...(linkedWorkCount === 0 ? ["No active PR is linked in cached metadata."] : []),
      ];
      const warnings = [
        ...(bodyLength < 80 ? ["Issue body is thin; contributor may need more proof before acting."] : []),
        ...(linkedPrs.length > 0 ? [`${linkedPrs.length} active PR(s) already reference this issue.`] : []),
        ...(linkedMergedPrs.length > 0 ? [`${linkedMergedPrs.length} merged PR(s) already reference this issue.`] : []),
        ...(issue.linkedPrs.length > 0 && linkedPrs.length === 0 && linkedMergedPrs.length === 0 ? [`Cached issue metadata already references PR(s): ${issue.linkedPrs.map((number) => `#${number}`).join(", ")}.`] : []),
        ...(issueCollisions.length > 0 ? ["Potential duplicate or overlapping issue/PR context exists."] : []),
        ...(age > 90 ? ["Issue is stale in cached metadata."] : []),
        ...(lifecycle !== "open" ? [`Issue lifecycle is ${lifecycle.replace(/_/g, " ")}.`] : []),
        ...(lane.lane === "direct_pr" ? ["Repo is direct-PR first; issue filing is not the primary Gittensor lane."] : []),
      ];
      const score = clamp(100 - warnings.length * 18 + reasons.length * 5 - (age > 180 ? 15 : 0), 0, 100);
      const status: IssueQualityReport["issues"][number]["status"] =
        linkedWorkCount > 0 || issueCollisions.some((cluster) => cluster.risk === "high") || ["duplicate", "invalid", "solved", "valid_solved"].includes(lifecycle)
          ? "do_not_use"
          : warnings.some((warning) => /thin|stale|direct-PR/i.test(warning)) || lifecycle === "stale"
            ? "needs_proof"
            : score < 45
              ? "hold"
              : "ready";
      return { number: issue.number, title: issue.title, lifecycle, status, score, reasons, warnings };
    })
    .sort((left, right) => right.score - left.score || left.number - right.number);
  return {
    repoFullName: fullName,
    generatedAt: nowIso(),
    lane,
    issues: reports,
    summary: `${reports.length} open issue(s) evaluated; ${reports.filter((report) => report.status === "ready").length} look ready from cached metadata.`,
  };
}

export function buildIssueDiscoveryLifecycleReport(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  fullName: string,
  recentMergedPullRequests: RecentMergedPullRequestRecord[] = [],
): IssueDiscoveryLifecycleReport {
  const lane = buildLaneAdvice(repo, fullName);
  const states = issues
    .slice(0, 300)
    .map((issue) => classifyIssueDiscoveryLifecycle(issue, pullRequests, recentMergedPullRequests, lane))
    .sort((left, right) => lifecycleRank(left.state) - lifecycleRank(right.state) || left.number - right.number);
  return {
    repoFullName: fullName,
    generatedAt: nowIso(),
    lane,
    states,
    summary: `${states.length} issue lifecycle state(s) classified; ${states.filter((entry) => entry.state === "valid_solved").length} valid solved issue(s), ${states.filter((entry) => entry.state === "closed_not_solved").length} closed without solver evidence.`,
  };
}

function classifyIssueDiscoveryLifecycle(
  issue: IssueRecord,
  pullRequests: PullRequestRecord[],
  recentMergedPullRequests: RecentMergedPullRequestRecord[],
  lane: LaneAdvice,
): IssueDiscoveryLifecycleReport["states"][number] {
  const linkedOpenPrs = pullRequests.filter((pr) => pr.linkedIssues.includes(issue.number) || issue.linkedPrs.includes(pr.number));
  const linkedMergedPrs = recentMergedPullRequests.filter((pr) => pr.linkedIssues.includes(issue.number) || issue.linkedPrs.includes(pr.number));
  const solvedByPullRequests = [...new Set([...linkedOpenPrs.filter((pr) => pr.mergedAt || pr.state === "merged").map((pr) => pr.number), ...linkedMergedPrs.map((pr) => pr.number)])].sort(
    (left, right) => left - right,
  );
  const labels = issue.labels.map((label) => label.toLowerCase());
  const stale = daysSince(issue.updatedAt ?? issue.createdAt) > 90;
  const duplicate = labels.some((label) => /duplicate/.test(label));
  const invalid = labels.some((label) => /invalid|wontfix|not planned|won't fix/.test(label));
  const state: IssueDiscoveryLifecycleState = duplicate
    ? "duplicate"
    : invalid
      ? "invalid"
      : solvedByPullRequests.length > 0
        ? lane.lane === "issue_discovery" || lane.lane === "split"
          ? "valid_solved"
          : "solved"
        : issue.state !== "open"
          ? "closed_not_solved"
          : stale
            ? "stale"
            : "open";
  const reasons = [
    ...(duplicate ? ["Issue carries duplicate labeling."] : []),
    ...(invalid ? ["Issue carries invalid or not-planned labeling."] : []),
    ...(solvedByPullRequests.length > 0 ? [`Linked solver PR(s): ${solvedByPullRequests.map((number) => `#${number}`).join(", ")}.`] : []),
    ...(issue.state !== "open" && solvedByPullRequests.length === 0 ? ["Issue is closed without cached solver PR evidence."] : []),
    ...(stale && issue.state === "open" ? ["Issue is stale in cached metadata."] : []),
    ...(lane.lane === "direct_pr" ? ["Repo is direct-PR first; lifecycle should not encourage issue filing."] : []),
  ];
  return { number: issue.number, title: issue.title, state, solvedByPullRequests, reasons: reasons.length > 0 ? reasons : ["Issue is open with no solver or duplicate signal."] };
}

function lifecycleRank(state: IssueDiscoveryLifecycleState): number {
  return { valid_solved: 0, solved: 1, open: 2, stale: 3, closed_not_solved: 4, duplicate: 5, invalid: 6 }[state];
}

function issueQualityFindings(linkedIssues: number[], issueQuality: IssueQualityReport | null | undefined): SignalFinding[] {
  if (!issueQuality || linkedIssues.length === 0) return [];
  const byIssue = new Map(issueQuality.issues.map((issue) => [issue.number, issue]));
  return linkedIssues.flatMap((issueNumber) => {
    const quality = byIssue.get(issueNumber);
    if (!quality || quality.status === "ready") return [];
    const detail = quality.warnings[0] ?? `Issue quality report marks #${issueNumber} as ${quality.status}.`;
    if (quality.status === "do_not_use") {
      return [
        {
          code: "issue_quality_do_not_use",
          severity: "warning" as const,
          title: "Linked issue is already covered or duplicate-prone",
          detail,
          action: "Confirm the linked issue is still actionable before posting public PR context.",
        },
      ];
    }
    if (quality.status === "needs_proof") {
      return [
        {
          code: "issue_quality_needs_proof",
          severity: "warning" as const,
          title: "Linked issue needs stronger proof",
          detail,
          action: "Add concrete reproduction, scope, or maintainer context before proceeding.",
        },
      ];
    }
    return [
      {
        code: "issue_quality_hold",
        severity: "warning" as const,
        title: "Linked issue is on hold",
        detail,
        action: "Choose a clearer candidate or wait for maintainer context.",
      },
    ];
  });
}

export function buildBurdenForecast(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  collisions: CollisionReport,
  horizonDays: 7 | 30 = 30,
  countOverrides: QueueSignalCounts = {},
): BurdenForecast {
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions, countOverrides);
  const openPrs = pullRequests.filter((pr) => pr.state === "open");
  const updatedRecently = openPrs.filter((pr) => daysSince(pr.updatedAt ?? pr.createdAt) <= horizonDays).length;
  const stalePrs = openPrs.filter((pr) => daysSince(pr.updatedAt ?? pr.createdAt) > 30).length;
  const projectedReviewLoad = clamp(openPrs.length * 3 + updatedRecently * 2 + collisions.summary.highRiskCount * 4 + stalePrs, 0, 100);
  const queueGrowthRisk = clamp((openPrs.length - queueHealth.signals.likelyReviewablePullRequests) * 5 + collisions.summary.clusterCount * 7, 0, 100);
  const level = projectedReviewLoad >= 80 || queueGrowthRisk >= 80 ? "critical" : projectedReviewLoad >= 55 || queueGrowthRisk >= 55 ? "high" : projectedReviewLoad >= 25 ? "medium" : "low";
  const findings: SignalFinding[] = [
    ...(queueGrowthRisk >= 55
      ? [
          {
            code: "queue_growth_risk",
            severity: "warning" as const,
            title: "Queue growth risk is elevated",
            detail: "Cached PR volume, reviewable count, and collision signals suggest maintainers may see avoidable triage load.",
            action: "Prefer smaller, linked, lower-collision submissions until the queue clears.",
          },
        ]
      : []),
    ...(stalePrs > 0
      ? [
          {
            code: "stale_review_load",
            severity: "info" as const,
            title: "Stale PRs affect maintainer load",
            detail: `${stalePrs} open PR(s) appear stale in cached metadata.`,
          },
        ]
      : []),
  ];
  return {
    repoFullName: repo?.fullName ?? collisions.repoFullName,
    generatedAt: nowIso(),
    horizonDays,
    level,
    forecast: {
      projectedReviewLoad,
      reviewablePullRequests: queueHealth.signals.likelyReviewablePullRequests,
      stalePullRequests: stalePrs,
      duplicateTrend: collisions.summary.clusterCount,
      queueGrowthRisk,
    },
    findings,
    summary: `${horizonDays}-day maintainer load forecast is ${level}; projected review load ${projectedReviewLoad}/100 and queue growth risk ${queueGrowthRisk}/100.`,
  };
}

export function buildContributorScoringProfile(args: {
  login: string;
  fit: ContributorFit;
  scoringSnapshot: ScoringModelSnapshotRecord;
}): ContributorScoringProfile {
  const stats = args.fit.repoStats;
  const mergedPullRequests = stats.reduce((sum, stat) => sum + stat.mergedPullRequests, 0);
  const openPullRequests = stats.reduce((sum, stat) => sum + stat.openPullRequests, 0);
  const stalePullRequests = stats.reduce((sum, stat) => sum + stat.stalePullRequests, 0);
  const unlinkedPullRequests = stats.reduce((sum, stat) => sum + stat.unlinkedPullRequests, 0);
  const languageMatches = args.fit.languageFit.filter((fit) => fit.match).length;
  const credibilityAssumption = clamp(0.75 + mergedPullRequests * 0.04 + languageMatches * 0.02 - stalePullRequests * 0.03 - unlinkedPullRequests * 0.02, 0.25, 1);
  const officialTotals = args.fit.profile.gittensor?.totals;
  const officialSource = args.fit.profile.source === "gittensor_api";
  const issueDiscoveryReports = officialTotals
    ? Math.max(officialTotals.validSolvedIssues, officialTotals.solvedIssues)
    : args.fit.profile.registeredRepoActivity.issues;
  const sourceLabel = officialSource ? "Gittensor API" : "cached";
  const privateSignals = [
    `${mergedPullRequests} ${sourceLabel} merged registered-repo PR(s).`,
    `${openPullRequests} ${sourceLabel} open registered-repo PR(s).`,
    `${issueDiscoveryReports} ${sourceLabel} valid/solved issue-discovery report(s).`,
    `${languageMatches} cached registered repo language match(es).`,
    ...(unlinkedPullRequests > 0 ? [`${unlinkedPullRequests} ${sourceLabel} unlinked PR pattern(s).`] : []),
  ];
  return {
    login: args.login,
    generatedAt: nowIso(),
    scoringModelSnapshotId: args.scoringSnapshot.id,
    evidence: {
      registeredRepoPullRequests: args.fit.profile.registeredRepoActivity.pullRequests,
      mergedPullRequests,
      openPullRequests,
      stalePullRequests,
      unlinkedPullRequests,
      issueDiscoveryReports,
      languageMatches,
      credibilityAssumption,
    },
    privateSignals,
  };
}

export function buildContributorStrategy(args: {
  login: string;
  fit: ContributorFit;
  scoringProfile: ContributorScoringProfile;
  scoringSnapshot: ScoringModelSnapshotRecord;
  outcomeHistory?: ContributorOutcomeHistory | null | undefined;
}): ContributorStrategy {
  const outcomeByRepo = new Map((args.outcomeHistory?.repoOutcomes ?? []).map((outcome) => [outcome.repoFullName, outcome]));
  const bestFitRepos = args.fit.opportunities.slice(0, 10).map((opportunity) => {
    const outcome = outcomeByRepo.get(opportunity.repoFullName);
    const privateScoringReadiness: ContributorStrategy["bestFitRepos"][number]["privateScoringReadiness"] =
      outcome?.maintainerLane
        ? "hold"
        : opportunity.fit === "hold" || opportunity.warnings.some((warning) => /busy|duplicate|inactive|unknown/i.test(warning)) || (outcome?.closedPullRequestRate ?? 0) >= 0.35
        ? "hold"
        : args.scoringProfile.evidence.credibilityAssumption >= 0.8 && opportunity.fit === "good" && (outcome?.openPullRequests ?? 0) < 5
          ? "good"
          : "caution";
    return {
      repoFullName: opportunity.repoFullName,
      lane: opportunity.lane,
      fit: opportunity.fit,
      opportunityScore: opportunity.score,
      privateScoringReadiness,
      reasons: [...opportunity.reasons, ...(outcome?.strengths ?? [])],
      warnings: [...opportunity.warnings, ...(outcome?.risks.filter((risk) => !/No major/i.test(risk)) ?? [])],
    };
  });
  const avoidRepos = (args.outcomeHistory?.repoOutcomes ?? [])
    .filter((outcome) => !outcome.maintainerLane && (outcome.closedPullRequestRate >= 0.35 || outcome.credibility > 0 && outcome.credibility < 0.8))
    .map((outcome) => ({
      repoFullName: outcome.repoFullName,
      reason: outcome.closedPullRequestRate >= 0.35 ? `Closed PR rate is ${percent(outcome.closedPullRequestRate)}.` : `Official repo credibility is ${round(outcome.credibility)}.`,
    }))
    .slice(0, 8);
  const cleanupFirst = (args.outcomeHistory?.repoOutcomes ?? [])
    .filter((outcome) => !outcome.maintainerLane && outcome.openPullRequests >= 3)
    .map((outcome) => ({ repoFullName: outcome.repoFullName, reason: `${outcome.openPullRequests} open PR(s) are still active.` }))
    .slice(0, 8);
  const maintainerLaneRepos = (args.outcomeHistory?.repoOutcomes ?? [])
    .filter((outcome) => outcome.maintainerLane)
    .map((outcome) => ({ repoFullName: outcome.repoFullName, reason: "Maintainer-associated repo; use repo-health guidance instead of contributor-lane guidance." }))
    .slice(0, 8);
  const laneWarnings = [
    ...bestFitRepos.filter((repo) => repo.lane === "direct_pr").map((repo) => `${repo.repoFullName}: direct PR lane; prioritize tested implementation work.`),
    ...bestFitRepos.filter((repo) => repo.lane === "issue_discovery").map((repo) => `${repo.repoFullName}: issue-discovery lane; prioritize actionable reports and avoid duplicate reports.`),
    ...maintainerLaneRepos.map((repo) => `${repo.repoFullName}: maintainer lane; treat as repo health and contributor triage.`),
  ];
  const nextActions = [
    ...(bestFitRepos.some((repo) => repo.privateScoringReadiness === "good") ? ["Start with the highest-fit repo that has low duplicate and queue pressure."] : []),
    ...(args.scoringProfile.evidence.unlinkedPullRequests > 0 ? ["Clean up linked issue/context patterns before adding more open PRs."] : []),
    ...(cleanupFirst.length > 0 ? ["Clean up active open PR pressure before adding more work in those repos."] : []),
    ...(maintainerLaneRepos.length > 0 ? ["For maintainer-owned repos, focus on config quality, labels, queue health, and contributor intake rather than contributor-lane submissions."] : []),
    ...(args.scoringProfile.evidence.languageMatches === 0 ? ["Prefer repos where the changed files match prior language evidence, or keep first submissions small."] : []),
    "Use local diff preflight before opening the PR so maintainers get a cleaner submission.",
  ];
  return {
    login: args.login,
    generatedAt: nowIso(),
    scoringModelSnapshotId: args.scoringSnapshot.id,
    summary: `${args.login} has ${bestFitRepos.length} ranked private strategy candidate(s), ${cleanupFirst.length} cleanup-first repo(s), and ${maintainerLaneRepos.length} maintainer-lane repo(s).`,
    bestFitRepos,
    avoidRepos,
    cleanupFirst,
    maintainerLaneRepos,
    successPatterns: args.outcomeHistory?.successPatterns ?? [],
    failurePatterns: args.outcomeHistory?.failurePatterns ?? [],
    laneWarnings: [...new Set(laneWarnings)],
    nextActions: [...new Set(nextActions)],
  };
}

export function buildCollisionEdges(report: CollisionReport): CollisionEdgeRecord[] {
  return report.clusters.flatMap((cluster) => {
    const [left, right] = cluster.items;
    if (!left || !right) return [];
    const rightTerms = new Set(tokenize(collisionItemText(right)));
    return [
      {
        id: `${report.repoFullName}#${cluster.id}`,
        repoFullName: report.repoFullName,
        leftType: left.type,
        leftNumber: left.number,
        leftTitle: left.title,
        rightType: right.type,
        rightNumber: right.number,
        rightTitle: right.title,
        risk: cluster.risk,
        reason: cluster.reason,
        sharedTerms: [...new Set(tokenize(collisionItemText(left)).filter((term) => rightTerms.has(term)))],
        generatedAt: report.generatedAt,
      },
    ];
  });
}

export function buildRegistryChangeReport(snapshots: RegistrySnapshot[]): RegistryChangeReport {
  const [current, previous] = snapshots;
  if (!current) {
    return {
      generatedAt: nowIso(),
      addedRepos: [],
      removedRepos: [],
      changedRepos: [],
      summary: "No registry snapshots are available.",
    };
  }
  if (!previous) {
    return {
      generatedAt: nowIso(),
      currentSnapshotId: current.id,
      addedRepos: current.repositories.map((repo) => repo.repo).sort(),
      removedRepos: [],
      changedRepos: [],
      summary: "Only one registry snapshot is available; every current repo is treated as newly observed.",
    };
  }
  const currentByRepo = new Map(current.repositories.map((repo) => [repo.repo, repo]));
  const previousByRepo = new Map(previous.repositories.map((repo) => [repo.repo, repo]));
  const addedRepos = [...currentByRepo.keys()].filter((repo) => !previousByRepo.has(repo)).sort();
  const removedRepos = [...previousByRepo.keys()].filter((repo) => !currentByRepo.has(repo)).sort();
  const changedRepos = [...currentByRepo.entries()]
    .flatMap(([repoFullName, repo]) => {
      const old = previousByRepo.get(repoFullName);
      if (!old) return [];
      const changes = [
        ...(repo.emissionShare !== old.emissionShare ? [`emission_share ${old.emissionShare} -> ${repo.emissionShare}`] : []),
        ...(repo.issueDiscoveryShare !== old.issueDiscoveryShare ? [`issue_discovery_share ${old.issueDiscoveryShare} -> ${repo.issueDiscoveryShare}`] : []),
        ...(repo.maintainerCut !== old.maintainerCut ? [`maintainer_cut ${old.maintainerCut} -> ${repo.maintainerCut}`] : []),
        ...(JSON.stringify(repo.labelMultipliers) !== JSON.stringify(old.labelMultipliers) ? ["label_multipliers changed"] : []),
        ...(repo.trustedLabelPipeline !== old.trustedLabelPipeline ? [`trusted_label_pipeline ${old.trustedLabelPipeline ?? false} -> ${repo.trustedLabelPipeline ?? false}`] : []),
      ];
      return changes.length > 0 ? [{ repoFullName, changes }] : [];
    })
    .sort((left, right) => left.repoFullName.localeCompare(right.repoFullName));
  return {
    generatedAt: nowIso(),
    currentSnapshotId: current.id,
    previousSnapshotId: previous.id,
    addedRepos,
    removedRepos,
    changedRepos,
    summary: `${addedRepos.length} added, ${removedRepos.length} removed, ${changedRepos.length} changed repo(s) between the latest registry snapshots.`,
  };
}

export function buildBountyAdvisory(bounty: BountyRecord, repo: RepositoryRecord | null, issue: IssueRecord | null): BountyAdvisory {
  const status = bounty.status.toLowerCase();
  const lifecycle = status.includes("complete") || status.includes("cancel") || status.includes("closed") ? "historical" : status ? "active" : "unknown";
  const target = bounty.payload.target_bounty ?? bounty.payload.target_alpha;
  const amount = bounty.payload.bounty_amount ?? bounty.payload.bounty_alpha;
  const fundingStatus = amount && amount !== 0 && amount !== "0.0000" ? "funded" : target ? "target_only" : "unknown";
  const findings: SignalFinding[] = [];
  if (lifecycle === "historical") {
    findings.push({
      code: "historical_bounty",
      severity: "info",
      title: "Bounty is historical",
      detail: "This bounty is completed, cancelled, or otherwise not active in the local bounty cache.",
    });
  }
  if (!repo?.isRegistered) {
    findings.push({
      code: "bounty_repo_unregistered",
      severity: "warning",
      title: "Bounty repo is not registered locally",
      detail: "The bounty references a repository that is not in the current local registry cache.",
    });
  }
  if (!issue) {
    findings.push({
      code: "bounty_issue_not_cached",
      severity: "info",
      title: "Linked issue is not cached",
      detail: "Gittensory has not cached the GitHub issue associated with this bounty.",
    });
  }
  return {
    id: bounty.id,
    repoFullName: bounty.repoFullName,
    issueNumber: bounty.issueNumber,
    status: bounty.status,
    lifecycle,
    fundingStatus,
    consensusRisk: issue && issue.linkedPrs.length > 1 ? "medium" : lifecycle === "active" && !issue ? "high" : "low",
    findings,
  };
}

export function buildPublicPrIntelligenceComment(args: {
  repo: RepositoryRecord | null;
  pr: PullRequestRecord;
  profile: ContributorProfile;
  detection: ContributorDetection;
  queueHealth: QueueHealth;
  collisions: CollisionReport;
  preflight: PreflightResult;
  settings: RepositorySettings;
}): string {
  const publicFindings = args.preflight.findings
    .filter((finding) => finding.severity !== "critical")
    .filter((finding) => args.settings.requireLinkedIssue || finding.code !== "missing_linked_issue")
    .filter((finding) => !containsPrivatePublicTerm([finding.code, finding.title, finding.detail, finding.publicText, finding.action].filter(Boolean).join(" ")))
    .slice(0, args.settings.publicSignalLevel === "minimal" ? 2 : 5);
  const collisionCount = args.collisions.clusters.length;
  const linkedIssues =
    args.pr.linkedIssues.length > 0
      ? args.pr.linkedIssues.map((issue) => `#${issue}`).join(", ")
      : args.settings.requireLinkedIssue
        ? "None detected"
        : "Not required by this repo setting";
  const roleContext = buildRoleContext({
    login: args.pr.authorLogin ?? args.profile.login,
    repo: args.repo,
    repoFullName: args.pr.repoFullName,
    pullRequests: [args.pr],
    issues: [],
    profile: args.profile,
  });
  const nextSteps = [
    ...(roleContext.maintainerLane ? ["Treat this as maintainer-lane context rather than normal contributor-lane activity."] : []),
    ...(args.settings.requireLinkedIssue && args.pr.linkedIssues.length === 0 ? ["Link the issue being solved, or explain why this is a no-issue PR."] : []),
    ...(collisionCount > 0 ? ["Check overlapping issues/PRs before review continues."] : []),
    ...(publicFindings.length > 0 ? publicFindings.flatMap((finding) => (finding.action ? [finding.action] : [])) : []),
  ].filter((step) => !containsPrivatePublicTerm(step));
  return [
    "<!-- gittensory-pr-intelligence -->",
    "## Gittensory contribution context",
    "",
    "_Advisory context generated from public GitHub metadata and Gittensory's registered-repo cache. This is not an endorsement._",
    "",
    "### Contributor context",
    `- Author: \`${args.pr.authorLogin ?? "unknown"}\``,
    `- Confirmed Gittensor miner: ${args.detection.source === "official_gittensor_api" ? "yes" : "not confirmed"}`,
    `- Role context: ${roleContext.role}${roleContext.maintainerLane ? " (maintainer lane)" : ""}`,
    `- Gittensory signal: ${args.detection.detected ? args.detection.reason : "No confirmed Gittensor miner activity detected."}`,
    `- Prior cached PRs/issues: ${args.detection.priorPullRequests} PR(s), ${args.detection.priorIssues} issue(s)`,
    `- Public profile languages: ${args.profile.github.topLanguages.length > 0 ? args.profile.github.topLanguages.join(", ") : "not available"}`,
    "",
    "### PR hygiene",
    `- Linked issues: ${linkedIssues}`,
    `- Lane context: ${buildLaneAdvice(args.repo, args.pr.repoFullName).summary}`,
    `- Review burden: ${args.preflight.reviewBurden}`,
    "",
    "### Duplicate/WIP risk",
    `- Collision clusters found: ${collisionCount}`,
    `- Queue level: ${args.queueHealth.level}`,
    "",
    "### Maintainer notes",
    ...(publicFindings.length > 0
      ? publicFindings.map((finding) => `- ${finding.title}: ${finding.publicText ?? finding.detail}`)
      : ["- No public-safe advisory findings were generated from cached metadata."]),
    "",
    "### Contributor next steps",
    ...(nextSteps.length > 0 ? [...new Set(nextSteps)].map((step) => `- ${step}`) : ["- Keep the PR focused and include validation evidence before maintainer review."]),
  ].join("\n");
}

function containsPrivatePublicTerm(value: string): boolean {
  return /\b(reward|payout|farming|wallet|hotkey|trust score|raw trust|estimated score|scoreability|likely_duplicate|reviewability\s*\d|\/100)\b/i.test(value);
}

function issueItem(issue: IssueRecord): CollisionItem {
  return {
    type: "issue",
    number: issue.number,
    title: issue.title,
    authorLogin: issue.authorLogin,
    htmlUrl: issue.htmlUrl,
    labels: issue.labels,
    linkedIssues: [issue.number],
    body: issue.body,
  };
}

function prItem(pr: PullRequestRecord): CollisionItem {
  return {
    type: "pull_request",
    number: pr.number,
    title: pr.title,
    authorLogin: pr.authorLogin,
    htmlUrl: pr.htmlUrl,
    labels: pr.labels,
    linkedIssues: pr.linkedIssues,
    body: pr.body,
  };
}

function recentMergedItem(pr: RecentMergedPullRequestRecord): CollisionItem {
  return {
    type: "recent_merged_pull_request",
    number: pr.number,
    title: pr.title,
    authorLogin: pr.authorLogin,
    htmlUrl: pr.htmlUrl,
    labels: pr.labels,
    linkedIssues: pr.linkedIssues,
    changedFiles: pr.changedFiles,
  };
}

function boundedCollisionIssues(openIssues: IssueRecord[], openPullRequests: PullRequestRecord[]): IssueRecord[] {
  if (openIssues.length <= MAX_COLLISION_PAIRWISE_ISSUES) return openIssues;
  const linkedIssueNumbers = new Set(openPullRequests.flatMap((pr) => pr.linkedIssues));
  const selected = new Map<number, IssueRecord>();
  for (const issue of openIssues) {
    if (linkedIssueNumbers.has(issue.number)) selected.set(issue.number, issue);
    if (selected.size >= MAX_COLLISION_PAIRWISE_ISSUES) return [...selected.values()];
  }
  for (const issue of openIssues) {
    selected.set(issue.number, issue);
    if (selected.size >= MAX_COLLISION_PAIRWISE_ISSUES) break;
  }
  return [...selected.values()];
}

function itemKey(item: CollisionItem): string {
  return `${item.type}-${item.number}`;
}

type CollisionTerms = {
  terms: Set<string>;
  size: number;
};

function collisionTerms(item: CollisionItem): CollisionTerms {
  const terms = new Set(tokenize(collisionItemText(item)));
  return { terms, size: terms.size };
}

function termOverlap(left: CollisionTerms, right: CollisionTerms): { score: number; shared: number } {
  if (left.size === 0 || right.size === 0) return { score: 0, shared: 0 };
  let shared = 0;
  const [smaller, larger] = left.size <= right.size ? [left.terms, right.terms] : [right.terms, left.terms];
  for (const term of smaller) {
    if (larger.has(term)) shared += 1;
  }
  return { score: shared / Math.min(left.size, right.size), shared };
}

function collisionItemText(item: CollisionItem): string {
  return [item.title, item.body, ...(item.labels ?? []), ...(item.changedFiles ?? [])].filter(Boolean).join(" ");
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));
}

function extractLinkedIssueNumbers(text: string): number[] {
  const matches = [...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)];
  return [...new Set(matches.map((match) => Number(match[1])).filter((value) => Number.isInteger(value) && value > 0))];
}

function outcomeSuccessPatterns(history: ContributorOutcomeHistory): OutcomePattern[] {
  const patterns: OutcomePattern[] = [];
  for (const outcome of history.repoOutcomes) {
    if (outcome.maintainerLane) {
      patterns.push({
        repoFullName: outcome.repoFullName,
        title: "Maintainer-side repo context",
        detail: `${outcome.repoFullName} is maintainer-lane for this user; use it for repo health and contributor triage, not normal contributor fit.`,
        confidence: "high",
      });
      continue;
    }
    if (outcome.mergedPullRequests >= 5 && outcome.closedPullRequestRate < 0.3) {
      patterns.push({
        repoFullName: outcome.repoFullName,
        title: "Strong merge history",
        detail: `${outcome.mergedPullRequests} merged PR(s) with ${percent(outcome.closedPullRequestRate)} closed PR rate.`,
        confidence: outcome.credibility >= 0.9 || outcome.mergedPullRequests >= 10 ? "high" : "medium",
      });
    } else if (outcome.mergedPullRequests > 0) {
      patterns.push({
        repoFullName: outcome.repoFullName,
        title: "Emerging repo fit",
        detail: `${outcome.mergedPullRequests} merged PR(s) show usable repo familiarity.`,
        confidence: "medium",
      });
    }
    if (outcome.validSolvedIssues > 0) {
      patterns.push({
        repoFullName: outcome.repoFullName,
        title: "Valid issue-discovery evidence",
        detail: `${outcome.validSolvedIssues} valid solved issue-discovery report(s) are visible in official data.`,
        confidence: "high",
      });
    }
  }
  return patterns.sort((left, right) => patternRank(right) - patternRank(left) || (left.repoFullName ?? "").localeCompare(right.repoFullName ?? "")).slice(0, 12);
}

function outcomeFailurePatterns(history: ContributorOutcomeHistory): OutcomePattern[] {
  const patterns: OutcomePattern[] = [];
  if (history.totals.openPullRequests >= 5) {
    patterns.push({
      title: "Open PR pressure",
      detail: `${history.totals.openPullRequests} open PR(s) are visible; clean up active work before adding more.`,
      confidence: "high",
    });
  }
  if (history.totals.closedPullRequestRate >= 0.25) {
    patterns.push({
      title: "Closed PR credibility pressure",
      detail: `Overall closed PR rate is ${percent(history.totals.closedPullRequestRate)}.`,
      confidence: "medium",
    });
  }
  if (history.totals.openIssues > 0 && history.totals.validSolvedIssues === 0) {
    patterns.push({
      title: "Raw issue activity is not solved discovery evidence",
      detail: `${history.totals.openIssues} open issue(s) are visible, but no valid solved issue-discovery evidence is visible in official totals.`,
      confidence: "medium",
    });
  }
  for (const outcome of history.repoOutcomes) {
    if (outcome.openIssues >= 10 && outcome.validSolvedIssues === 0) {
      patterns.push({
        repoFullName: outcome.repoFullName,
        title: "Raw issue activity is not solved discovery evidence",
        detail: `${outcome.repoFullName} has ${outcome.openIssues} open issue(s), but no valid solved issue-discovery evidence for that repo.`,
        confidence: outcome.maintainerLane ? "high" : "medium",
      });
    }
    if (!outcome.maintainerLane && outcome.closedPullRequestRate >= 0.35) {
      patterns.push({
        repoFullName: outcome.repoFullName,
        title: "Repo-specific closed PR risk",
        detail: `${outcome.repoFullName} has ${outcome.closedPullRequests} closed PR(s) and ${percent(outcome.closedPullRequestRate)} closed PR rate.`,
        confidence: "high",
      });
    }
    if (!outcome.maintainerLane && outcome.openPullRequests >= 3) {
      patterns.push({
        repoFullName: outcome.repoFullName,
        title: "Repo-specific open PR pressure",
        detail: `${outcome.repoFullName} has ${outcome.openPullRequests} open PR(s).`,
        confidence: "medium",
      });
    }
  }
  return patterns.sort((left, right) => patternRank(right) - patternRank(left) || (left.repoFullName ?? "").localeCompare(right.repoFullName ?? "")).slice(0, 12);
}

function strongestAssociation(values: string[]): string | undefined {
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    if (values.includes(association)) return association;
  }
  return values[0];
}

function isMaintainerAssociation(value: string | null | undefined): boolean {
  return value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR";
}

function sameLogin(value: string | null | undefined, login: string): boolean {
  return value?.toLowerCase() === login.toLowerCase();
}

function sameRepo(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function topItems(items: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([item]) => item);
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator) : 0;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function patternRank(pattern: OutcomePattern): number {
  return pattern.confidence === "high" ? 3 : pattern.confidence === "medium" ? 2 : 1;
}

function daysSince(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

function isCodeFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|py|rb|rs|kt|scala|java|go|sql)$/i.test(file) && !isTestFile(file);
}

function isTestFile(file: string): boolean {
  return (
    /(^|\/)(test|tests|spec|__tests__)\//i.test(file) ||
    /(^|\/)src\/test\//i.test(file) ||
    /(^|\/)[^/]+_test\.(go|py|rb)$/i.test(file) ||
    /(^|\/)[^/]+_spec\.rb$/i.test(file) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|py|rb|rs)$/i.test(file)
  );
}

function riskRank(risk: CollisionCluster["risk"]): number {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  return 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
