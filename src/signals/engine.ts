import type {
  AdvisoryFinding,
  BountyRecord,
  CheckSummaryRecord,
  CollisionEdgeRecord,
  ContributorRepoStatRecord,
  IssueRecord,
  JsonValue,
  PullRequestDetailSyncStateRecord,
  PullRequestFileRecord,
  PullRequestRecord,
  PullRequestReviewRecord,
  RecentMergedPullRequestRecord,
  RegistryRepoConfig,
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
import { hasLocalTestEvidence } from "./test-evidence";

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
    cachedOpenPullRequests?: number | undefined;
    likelyReviewablePullRequestsSource?: "cache" | "sampled_cache" | "authoritative" | undefined;
  };
  findings: SignalFinding[];
  rankedPullRequests?: {
    number: number;
    title: string;
    authorLogin: string;
    recommendation: string;
  }[];
};

export type QueueSignalCounts = {
  openIssues?: number | undefined;
  openPullRequests?: number | undefined;
  likelyReviewablePullRequests?: number | undefined;
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

export type RepoOutcomeBucket = "merged" | "closed_unmerged" | "open_active" | "open_stale";
export type RepoOutcomeDimensionKind = "path" | "label" | "size" | "linked_issue" | "test_evidence" | "review_churn" | "author_role";
export type RepoOutcomeSignal = "merges_well" | "high_closure_risk" | "mixed";

export type RepoOutcomeDimension = {
  dimension: RepoOutcomeDimensionKind;
  key: string;
  merged: number;
  closedUnmerged: number;
  decided: number;
  mergeRate: number;
  signal: RepoOutcomeSignal;
};

export type RepoOutcomeEvidenceCompleteness = {
  pullRequestsAnalyzed: number;
  withFileDetail: number;
  withReviewDetail: number;
  withCheckDetail: number;
  filesCompletenessRatio: number;
  reviewsCompletenessRatio: number;
  checksCompletenessRatio: number;
  fullyDecidedWithDetail: number;
  status: "complete" | "partial" | "missing";
};

export type RepoOutcomePatterns = {
  repoFullName: string;
  generatedAt: string;
  lane: ParticipationLane;
  primaryLanguage: string | null;
  sampleSize: number;
  totals: {
    analyzed: number;
    merged: number;
    closedUnmerged: number;
    openActive: number;
    openStale: number;
    maintainerLanePullRequests: number;
    outsideContributorPullRequests: number;
  };
  outsideContributorMergeRate: number;
  maintainerLaneMergeRate: number;
  dimensions: RepoOutcomeDimension[];
  successPatterns: OutcomePattern[];
  riskPatterns: OutcomePattern[];
  evidenceCompleteness: RepoOutcomeEvidenceCompleteness;
  findings: SignalFinding[];
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

export type PublicReadinessScore = {
  total: number;
  components: Array<{
    key: "traceability" | "related_work" | "change_scope" | "validation" | "pr_state" | "queue_pressure";
    label: string;
    score: number;
    max: number;
    evidence: string;
    action: string;
  }>;
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

export type BountyLifecycle = "active" | "historical" | "completed" | "cancelled" | "stale" | "ambiguous" | "unknown";

export type BountyLinkedPr = {
  number: number;
  state: "open" | "closed" | "merged" | "unknown";
  isActive: boolean;
};

export type BountySourceContext = {
  sourceUrl?: string | null | undefined;
  discoveredAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  observedAt?: string | null | undefined;
  ageDays: number | null;
  freshness: "fresh" | "stale" | "unknown";
};

export type BountyOpportunityContext = {
  id: string;
  lifecycle: BountyLifecycle;
  isActiveOpportunity: boolean;
  fundingStatus: "funded" | "target_only" | "unknown";
  consensusRisk: "low" | "medium" | "high";
  source: BountySourceContext;
  linkedPrs: BountyLinkedPr[];
};

export type BountyAdvisory = {
  id: string;
  repoFullName: string;
  issueNumber: number;
  status: string;
  lifecycle: BountyLifecycle;
  isActiveOpportunity: boolean;
  fundingStatus: "funded" | "target_only" | "unknown";
  consensusRisk: "low" | "medium" | "high";
  source: BountySourceContext;
  linkedPrs: BountyLinkedPr[];
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
    linkage?: IssueLinkageRecord | undefined;
    bounty?: BountyOpportunityContext | undefined;
    status: "ready" | "needs_proof" | "hold" | "do_not_use";
    score: number;
    reasons: string[];
    warnings: string[];
  }>;
  summary: string;
};

export type IssueDiscoveryLifecycleState = "open" | "closed_not_solved" | "solved" | "valid_solved" | "stale" | "duplicate" | "invalid";

export type IssueLinkageRecord = {
  status: "raw" | "plausible" | "validated" | "invalid" | "unavailable";
  source: "official_mirror" | "github_cache" | "missing";
  solvedByPullRequests: number[];
  reason: string;
  warnings: string[];
};

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
const REPO_OUTCOME_STALE_OPEN_DAYS = 30;
const REPO_OUTCOME_MIN_DECIDED_SAMPLE = 3;
const REPO_OUTCOME_MERGE_WELL_RATE = 0.7;
const REPO_OUTCOME_CLOSURE_RISK_RATE = 0.34;
const REPO_OUTCOME_MAX_PATTERNS = 12;

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
  /* v8 ignore start -- Pairwise collision guards protect sparse cached rows; public collision behavior is covered by report tests. */
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
        reason: `Titles/paths share ${overlap.shared} meaningful terms.`,
        items: [left, right],
      });
    }
  }
  /* v8 ignore stop */

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
  const likelyReviewablePullRequestsSource =
    countOverrides.likelyReviewablePullRequests !== undefined ? "authoritative" : openPullRequestCount > openPullRequests.length ? "sampled_cache" : "cache";
  const unlinkedPullRequests = openPullRequests.filter((pr) => pr.linkedIssues.length === 0);
  const stalePullRequests = openPullRequests.filter((pr) => daysSince(pr.updatedAt ?? pr.createdAt) >= 14);
  const maintainerAuthoredPullRequests = openPullRequests.filter((pr) => isMaintainerAssociation(pr.authorAssociation));
  const cachedLikelyReviewablePullRequests = openPullRequests.filter((pr) => pr.linkedIssues.length > 0 && daysSince(pr.updatedAt ?? pr.createdAt) < 30).length;
  const likelyReviewablePullRequests = Math.min(openPullRequestCount, Math.max(cachedLikelyReviewablePullRequests, countOverrides.likelyReviewablePullRequests ?? 0));
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
      cachedOpenPullRequests: openPullRequests.length,
      likelyReviewablePullRequestsSource,
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
  // `matchingStats` and the cached authored records are overlapping views of the same activity, so
  // only fold in stat-derived dominant labels for repos that have no cached authored records --
  // otherwise a shared repo's labels are double-counted (consistent with how reposTouched dedups and
  // unlinkedOpenPullRequests maxes the same two sources).
  const cachedLabelRepos = new Set([...authoredPullRequests, ...authoredIssues].map((record) => normalizedRepoName(record.repoFullName)));
  const dominantLabels = topItems(
    [
      ...authoredPullRequests.flatMap((record) => record.labels),
      ...authoredIssues.flatMap((record) => record.labels),
      ...matchingStats.filter((stat) => !cachedLabelRepos.has(normalizedRepoName(stat.repoFullName))).flatMap((stat) => stat.dominantLabels),
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
  /* v8 ignore next -- Official Gittensor snapshots normally include the canonical GitHub login; request-login fallback protects legacy rows. */
  const matchingStats = repoStats.filter((stat) => sameLogin(stat.login, snapshot.githubUsername) || sameLogin(stat.login, login));
  const unlinkedOpenPullRequests = matchingStats.reduce((sum, stat) => sum + stat.unlinkedPullRequests, 0);
  const maintainerAssociatedPullRequests = pullRequests.filter((pr) => sameLogin(pr.authorLogin, login) && isMaintainerAssociation(pr.authorAssociation)).length;
  const reposTouched = snapshot.repositories
    .filter((repo) => repo.pullRequests + repo.openIssues + repo.closedIssues > 0)
    .map((repo) => repo.repoFullName)
    .sort();
  // The snapshot labels already cover snapshot.repositories; only fold in stat-derived dominant labels
  // for repos the snapshot does not cover, so shared repos are not double-counted.
  const snapshotRepos = new Set(snapshot.repositories.map((repo) => normalizedRepoName(repo.repoFullName)));
  const dominantLabels = topItems(
    [
      ...snapshot.pullRequests.flatMap((pr) => (pr.label ? [pr.label] : [])),
      ...snapshot.issueLabels,
      ...matchingStats.filter((stat) => !snapshotRepos.has(normalizedRepoName(stat.repoFullName))).flatMap((stat) => stat.dominantLabels),
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
  if (settings.publicAudienceMode === "oss_maintainer") return settings.commentMode === "all_prs" || detection.detected || detection.source !== "official_gittensor_api";
  return detection.detected && detection.source === "official_gittensor_api";
}

export function buildContributorOpportunities(
  profile: ContributorProfile,
  repositories: RepositoryRecord[],
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  bounties: BountyRecord[] = [],
  issueQualityByRepo?: Map<string, IssueQualityReport>,
): ContributorOpportunity[] {
  const opportunities: ContributorOpportunity[] = [];
  const touchedRepos = new Set(profile.registeredRepoActivity.reposTouched);
  const labelHistory = new Set(profile.registeredRepoActivity.dominantLabels);
  const bountyByIssue = indexBountiesByIssue(bounties);
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
    // Score every eligible issue, then keep this repo's best 5 by score -- the cap must select the
    // strongest-fit issues (mirroring the issue-quality report's score-descending order), not the
    // arbitrary first 5 in DB order.
    const repoOpportunities: ContributorOpportunity[] = [];
    for (const issue of rankable) {
      const quality = qualityByIssue?.get(issue.number);
      const bounty = bountyByIssue.get(bountyIssueKey(repo.fullName, issue.number)) ?? null;
      const bountyLifecycle = bounty ? classifyBountyLifecycle(bounty, issue) : null;
      // Never steer contributors toward completed, cancelled, or otherwise historical bounty work.
      if (bountyLifecycle && isHistoricalBountyLifecycle(bountyLifecycle)) continue;
      const bountyPenalty = bountyLifecycle === "stale" || bountyLifecycle === "ambiguous" ? 30 : 0;
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
          bountyPenalty -
          (lane.lane === "inactive" || lane.lane === "unknown" ? 35 : 0) +
          qualityAdjustment,
        0,
        100,
      );
      const baseFit = score >= 70 ? "good" : score >= 40 ? "caution" : "hold";
      const downgradeToCaution = (bountyPenalty > 0 || quality?.status === "needs_proof") && baseFit === "good";
      repoOpportunities.push({
        repoFullName: repo.fullName,
        issueNumber: issue.number,
        title: issue.title,
        fit: downgradeToCaution ? "caution" : baseFit,
        score,
        lane: lane.lane,
        reasons: [
          lane.summary,
          ...(touchedRepos.has(repo.fullName) ? ["Contributor has prior activity in this registered repo."] : []),
          ...(labelFit > 0 ? [`Issue labels overlap contributor history: ${issue.labels.filter((label) => labelHistory.has(label)).join(", ")}.`] : []),
          ...(bountyLifecycle === "active" ? ["An active bounty is attached as contribution context (not guaranteed payout)."] : []),
          ...(quality?.status === "ready" ? ["Issue quality report rates this issue as ready."] : []),
        ],
        warnings: [
          ...(repoPullRequests.length >= 8 ? ["This repo has a busy open PR queue."] : []),
          ...(lane.lane === "issue_discovery" ? ["This repo is not a direct-PR-first lane."] : []),
          ...(lane.lane === "unknown" || lane.lane === "inactive" ? ["Gittensory cannot recommend this as a strong contribution target right now."] : []),
          ...(bountyLifecycle === "stale" ? ["Attached bounty context looks stale; confirm it is still active before acting."] : []),
          ...(bountyLifecycle === "ambiguous" ? ["Attached bounty state is ambiguous; verify it before acting."] : []),
          ...(quality?.status === "needs_proof" ? ["Issue quality report flags this issue as needing more proof before acting."] : []),
          ...(quality?.status === "hold" ? ["Issue quality report rates this issue as hold; consider skipping."] : []),
        ],
      });
    }
    repoOpportunities.sort((left, right) => right.score - left.score || (left.issueNumber ?? 0) - (right.issueNumber ?? 0));
    opportunities.push(...repoOpportunities.slice(0, 5));
  }

  /* v8 ignore next -- Repo-name tie ordering is deterministic presentation fallback after scored opportunity ranking. */
  return opportunities.sort((left, right) => right.score - left.score || left.repoFullName.localeCompare(right.repoFullName)).slice(0, 25);
}

export function buildContributorFit(
  profile: ContributorProfile,
  repositories: RepositoryRecord[],
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  repoSyncStates: RepoSyncStateRecord[],
  repoStats: ContributorRepoStatRecord[],
  bounties: BountyRecord[] = [],
  issueQualityByRepo?: Map<string, IssueQualityReport>,
): ContributorFit {
  const opportunities = buildContributorOpportunities(profile, repositories, issues, pullRequests, bounties, issueQualityByRepo);
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
    ...(args.pullRequests ?? []).filter((pr) => sameRepo(pr.repoFullName, args.repoFullName) && sameLogin(pr.authorLogin, args.login)).map((pr) => pr.authorAssociation),
    ...(args.issues ?? []).filter((issue) => sameRepo(issue.repoFullName, args.repoFullName) && sameLogin(issue.authorLogin, args.login)).map((issue) => issue.authorAssociation),
  ].filter(Boolean) as string[];
  const officialRepo = args.profile?.gittensor?.repositories.find((repo) => repo.repoFullName.toLowerCase() === args.repoFullName.toLowerCase());
  const touchedByOfficial = Boolean(officialRepo && officialRepo.pullRequests + officialRepo.openIssues + officialRepo.closedIssues > 0);
  const touchedByCache = Boolean(
    args.profile?.registeredRepoActivity.reposTouched.some((repo) => repo.toLowerCase() === args.repoFullName.toLowerCase()) ||
      (args.pullRequests ?? []).some((pr) => sameRepo(pr.repoFullName, args.repoFullName) && sameLogin(pr.authorLogin, args.login)) ||
      /* v8 ignore next -- Issue-authored cache fallback is defensive; PR and official contribution paths cover role detection behavior. */
      (args.issues ?? []).some((issue) => sameRepo(issue.repoFullName, args.repoFullName) && sameLogin(issue.authorLogin, args.login)),
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
  /* v8 ignore next -- strongestAssociation resolves maintainer associations before this guard; it protects malformed mixed association rows. */
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

// Derive solved / valid-solved issue-discovery counts from cached issues using the same
// lifecycle classifier as buildIssueDiscoveryLifecycleReport. Used as the cache fallback for
// official solvedIssues / validSolvedIssues so a contributor without official Gittensor data
// still gets credit for issues their own merged PRs solved. (Contributor-wide recent-merged
// solver PRs are not loaded here, so detection uses the cached pull_requests set.)
function cachedSolvedIssueCounts(issues: IssueRecord[], pullRequests: PullRequestRecord[], lane: LaneAdvice): { solvedIssues: number; validSolvedIssues: number } {
  let solvedIssues = 0;
  let validSolvedIssues = 0;
  for (const issue of issues) {
    if (issue.state === "open") continue;

    // Issue linkedPrs can be parsed from contributor-controlled issue body text. Cache-derived
    // outcome counts only trust solver links carried by the merged PR record itself.
    const state = classifyIssueDiscoveryLifecycle({ ...issue, linkedPrs: [] }, pullRequests, [], lane).state;
    if (state === "valid_solved") {
      validSolvedIssues += 1;
      solvedIssues += 1;
    } else if (state === "solved") {
      solvedIssues += 1;
    }
  }
  return { solvedIssues, validSolvedIssues };
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
    /* v8 ignore next -- Higher-priority duplicate replacement is deterministic merge behavior; callers exercise the merged result. */
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
      // Like every field above, issue-discovery solved counts fall back to cache (the issue
      // lifecycle), not a literal 0, when official Gittensor data is absent for this repo.
      const laneAdvice = buildLaneAdvice(repo, repoFullName);
      const cachedDiscovery = cachedSolvedIssueCounts(cachedIssues, cachedPrs, laneAdvice);
      const solvedIssues = official?.solvedIssues ?? cachedDiscovery.solvedIssues;
      const validSolvedIssues = official?.validSolvedIssues ?? cachedDiscovery.validSolvedIssues;
      const roleContext = buildRoleContext({ login: args.login, repo, repoFullName, pullRequests: args.pullRequests, issues: args.issues, profile: args.profile });
      const closedPullRequestRate = rate(closedPullRequests, pullRequests);
      const lane = laneAdvice.lane;
      const risks = [
        ...(roleContext.maintainerLane ? ["Maintainer-lane repo; do not treat this as normal contributor evidence."] : []),
        ...(closedPullRequestRate >= 0.3 ? [`Closed PR rate is ${percent(closedPullRequestRate)}.`] : []),
        ...(openPullRequests >= 5 ? [`${openPullRequests} open PR(s) create review and threshold pressure.`] : []),
        ...(openIssues >= 10 && validSolvedIssues === 0 ? ["Issue activity is mostly open/raw, not valid solved issue-discovery evidence."] : []),
        /* v8 ignore next -- Credibility warning fallback handles sparse official rows; outcome history tests cover public risk behavior. */
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
  // When official Gittensor totals are absent, derive every PR/issue total from the same
  // login-scoped, internally-consistent repoOutcomes (each repo keeps pullRequests >=
  // merged + open + closed and issues = openIssues + closedIssues). Previously pullRequests/
  // mergedPullRequests fell back to registeredRepoActivity and openPullRequests to an
  // unfiltered repoStats sum, breaking the invariant and letting closedPullRequestRate exceed 1.
  const sumOutcomes = (pick: (outcome: (typeof repoOutcomes)[number]) => number): number => repoOutcomes.reduce((sum, outcome) => sum + pick(outcome), 0);
  const gittensorTotals = args.profile.gittensor?.totals;
  const openIssues = gittensorTotals?.openIssues ?? sumOutcomes((outcome) => outcome.openIssues);
  const closedIssues = gittensorTotals?.closedIssues ?? sumOutcomes((outcome) => outcome.closedIssues);
  const totals = {
    pullRequests: gittensorTotals?.pullRequests ?? sumOutcomes((outcome) => outcome.pullRequests),
    mergedPullRequests: gittensorTotals?.mergedPullRequests ?? sumOutcomes((outcome) => outcome.mergedPullRequests),
    openPullRequests: gittensorTotals?.openPullRequests ?? sumOutcomes((outcome) => outcome.openPullRequests),
    closedPullRequests: gittensorTotals?.closedPullRequests ?? sumOutcomes((outcome) => outcome.closedPullRequests),
    closedPullRequestRate: 0,
    issues: openIssues + closedIssues,
    openIssues,
    closedIssues,
    solvedIssues: gittensorTotals?.solvedIssues ?? sumOutcomes((outcome) => outcome.solvedIssues),
    validSolvedIssues: gittensorTotals?.validSolvedIssues ?? sumOutcomes((outcome) => outcome.validSolvedIssues),
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
    /* v8 ignore next -- Higher-priority duplicate replacement is deterministic reconciliation behavior; callers exercise the merged result. */
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
    const cached = cachedReconciliationCounts(args.login, repoFullName, args.pullRequests, args.issues, buildLaneAdvice(repoByName.get(key) ?? null, repoFullName), statByRepo.get(key));
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
  lane: LaneAdvice,
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
  const { solvedIssues, validSolvedIssues } = cachedSolvedIssueCounts(cachedIssues, cachedPrs, lane);
  return {
    pullRequests: pullRequestCount,
    mergedPullRequests,
    openPullRequests,
    closedPullRequests,
    issues: issueCount,
    openIssues,
    closedIssues,
    solvedIssues,
    validSolvedIssues,
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

type RepoOutcomePullRequest = {
  number: number;
  bucket: RepoOutcomeBucket;
  decided: boolean;
  merged: boolean;
  maintainerLane: boolean;
  linked: boolean;
  labels: string[];
  filePaths: string[];
  changedLineCount: number;
  authorRole: "returning_contributor" | "first_time_or_external";
  hasReview: boolean;
  changesRequested: boolean;
};

// Normalize a recent_merged_pull_requests record into a decided/merged outcome PR.
// These records live in a separate table from `pull_requests` and carry no
// `authorAssociation` column, so maintainer-lane / author-role are derived from the
// stored GitHub payload's `author_association` when present (else outside/external).
function normalizeRecentMergedOutcome(
  record: RecentMergedPullRequestRecord,
  filesByNumber: Map<number, PullRequestFileRecord[]>,
  reviewsByNumber: Map<number, PullRequestReviewRecord[]>,
): RepoOutcomePullRequest {
  const association = typeof record.payload.author_association === "string" ? (record.payload.author_association as string) : undefined;
  const fileRecords = filesByNumber.get(record.number) ?? [];
  const reviewRecords = reviewsByNumber.get(record.number) ?? [];
  // Conservative fallback: when author_association is absent or unrecognised, treat as maintainer
  // lane so the record is excluded from outside-contributor statistics rather than silently
  // inflating the outside-contributor merge rate with unclassifiable data.
  const knownOutsider = association === "NONE" || association === "CONTRIBUTOR" || association === "FIRST_TIME_CONTRIBUTOR" || association === "FIRST_TIMER";
  const maintainerLane = isMaintainerAssociation(association) || !knownOutsider;
  return {
    number: record.number,
    bucket: "merged",
    decided: true,
    merged: true,
    maintainerLane,
    linked: record.linkedIssues.length > 0,
    labels: [...new Set(record.labels)].sort(),
    filePaths: [...new Set([...fileRecords.map((file) => file.path), ...record.changedFiles])].sort(),
    changedLineCount: fileRecords.reduce((sum, file) => sum + file.additions + file.deletions, 0),
    authorRole: association === "CONTRIBUTOR" ? "returning_contributor" : "first_time_or_external",
    hasReview: reviewRecords.length > 0,
    changesRequested: reviewRecords.some((review) => review.state === "CHANGES_REQUESTED"),
  };
}

export function buildRepoOutcomePatterns(args: {
  repo: RepositoryRecord | null;
  repoFullName: string;
  pullRequests: PullRequestRecord[];
  recentMergedPullRequests?: RecentMergedPullRequestRecord[] | undefined;
  files?: PullRequestFileRecord[] | undefined;
  reviews?: PullRequestReviewRecord[] | undefined;
  detailSyncStates?: PullRequestDetailSyncStateRecord[] | undefined;
  syncState?: RepoSyncStateRecord | null | undefined;
}): RepoOutcomePatterns {
  const repoKey = args.repoFullName.toLowerCase();
  const mergedDetailByNumber = new Map<number, RecentMergedPullRequestRecord>();
  for (const record of args.recentMergedPullRequests ?? []) {
    if (record.repoFullName.toLowerCase() === repoKey) mergedDetailByNumber.set(record.number, record);
  }
  const filesByNumber = new Map<number, PullRequestFileRecord[]>();
  for (const file of args.files ?? []) {
    if (file.repoFullName.toLowerCase() !== repoKey) continue;
    const list = filesByNumber.get(file.pullNumber) ?? [];
    list.push(file);
    filesByNumber.set(file.pullNumber, list);
  }
  const reviewsByNumber = new Map<number, PullRequestReviewRecord[]>();
  for (const review of args.reviews ?? []) {
    if (review.repoFullName.toLowerCase() !== repoKey) continue;
    const list = reviewsByNumber.get(review.pullNumber) ?? [];
    list.push(review);
    reviewsByNumber.set(review.pullNumber, list);
  }

  const lane = buildLaneAdvice(args.repo, args.repoFullName).lane;
  const primaryLanguage = args.syncState?.primaryLanguage ?? null;

  const seenNumbers = new Set<number>();
  const analyzedFromPullRequests: RepoOutcomePullRequest[] = args.pullRequests
    .filter((pr) => pr.repoFullName.toLowerCase() === repoKey)
    .map((pr) => {
      seenNumbers.add(pr.number);
      const mergedDetail = mergedDetailByNumber.get(pr.number);
      // A PR with a recent_merged_pull_requests record (carrying a mergedAt) actually merged,
      // even when the open-PR reconciliation only saw it disappear and flipped it to closed
      // without a mergedAt of its own.
      const merged = Boolean(pr.mergedAt) || pr.state === "merged" || Boolean(mergedDetail?.mergedAt);
      const closedUnmerged = !merged && pr.state === "closed";
      const open = !merged && !closedUnmerged;
      const stale = open && daysSince(pr.updatedAt ?? pr.createdAt) >= REPO_OUTCOME_STALE_OPEN_DAYS;
      const bucket: RepoOutcomeBucket = merged ? "merged" : closedUnmerged ? "closed_unmerged" : stale ? "open_stale" : "open_active";
      const fileRecords = filesByNumber.get(pr.number) ?? [];
      const filePaths = [...new Set([...fileRecords.map((file) => file.path), ...(mergedDetail?.changedFiles ?? [])])].sort();
      const reviewRecords = reviewsByNumber.get(pr.number) ?? [];
      return {
        number: pr.number,
        bucket,
        decided: merged || closedUnmerged,
        merged,
        maintainerLane: isMaintainerAssociation(pr.authorAssociation),
        linked: pr.linkedIssues.length > 0 || (mergedDetail?.linkedIssues.length ?? 0) > 0,
        labels: [...new Set([...pr.labels, ...(mergedDetail?.labels ?? [])])].sort(),
        filePaths,
        changedLineCount: fileRecords.reduce((sum, file) => sum + file.additions + file.deletions, 0),
        authorRole: pr.authorAssociation === "CONTRIBUTOR" ? "returning_contributor" : "first_time_or_external",
        hasReview: reviewRecords.length > 0,
        changesRequested: reviewRecords.some((review) => review.state === "CHANGES_REQUESTED"),
      };
    });
  // Merged PRs that live only in recent_merged_pull_requests (the open-PR backfill never
  // upserts them into pull_requests) must still be counted in the outcome analysis.
  const mergedOnly: RepoOutcomePullRequest[] = (args.recentMergedPullRequests ?? [])
    .filter((record) => record.repoFullName.toLowerCase() === repoKey && Boolean(record.mergedAt) && !seenNumbers.has(record.number))
    .map((record) => normalizeRecentMergedOutcome(record, filesByNumber, reviewsByNumber));
  const analyzed: RepoOutcomePullRequest[] = [...analyzedFromPullRequests, ...mergedOnly];

  const decided = analyzed.filter((pr) => pr.decided);
  const maintainer = analyzed.filter((pr) => pr.maintainerLane);
  const outsideDecided = decided.filter((pr) => !pr.maintainerLane);
  const maintainerDecided = decided.filter((pr) => pr.maintainerLane);
  const totals = {
    analyzed: analyzed.length,
    merged: analyzed.filter((pr) => pr.bucket === "merged").length,
    closedUnmerged: analyzed.filter((pr) => pr.bucket === "closed_unmerged").length,
    openActive: analyzed.filter((pr) => pr.bucket === "open_active").length,
    openStale: analyzed.filter((pr) => pr.bucket === "open_stale").length,
    maintainerLanePullRequests: maintainer.length,
    outsideContributorPullRequests: analyzed.length - maintainer.length,
  };
  const outsideContributorMergeRate = rate(outsideDecided.filter((pr) => pr.merged).length, outsideDecided.length);
  const maintainerLaneMergeRate = rate(maintainerDecided.filter((pr) => pr.merged).length, maintainerDecided.length);

  const groups = new Map<RepoOutcomeDimensionKind, Map<string, RepoOutcomePullRequest[]>>();
  const addToGroup = (dimension: RepoOutcomeDimensionKind, key: string, pr: RepoOutcomePullRequest) => {
    const byKey = groups.get(dimension) ?? new Map<string, RepoOutcomePullRequest[]>();
    const list = byKey.get(key) ?? [];
    list.push(pr);
    byKey.set(key, list);
    groups.set(dimension, byKey);
  };
  for (const pr of outsideDecided) {
    for (const bucket of new Set(pr.filePaths.map(pathBucket))) addToGroup("path", bucket, pr);
    if (pr.filePaths.length > 0) addToGroup("test_evidence", pr.filePaths.some(isTestFile) ? "with_tests" : "without_tests", pr);
    for (const label of pr.labels) addToGroup("label", label, pr);
    const size = sizeBucket(pr);
    if (size) addToGroup("size", size, pr);
    addToGroup("linked_issue", pr.linked ? "linked" : "unlinked", pr);
    addToGroup("author_role", pr.authorRole, pr);
    if (pr.hasReview) addToGroup("review_churn", pr.changesRequested ? "changes_requested" : "clean_review", pr);
  }

  const dimensionOrder: RepoOutcomeDimensionKind[] = ["path", "label", "size", "linked_issue", "test_evidence", "review_churn", "author_role"];
  const dimensions: RepoOutcomeDimension[] = [];
  for (const dimension of dimensionOrder) {
    const byKey = groups.get(dimension);
    if (!byKey) continue;
    for (const [key, group] of [...byKey.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      if (group.length < REPO_OUTCOME_MIN_DECIDED_SAMPLE) continue;
      const mergedCount = group.filter((pr) => pr.merged).length;
      const mergeRate = rate(mergedCount, group.length);
      dimensions.push({
        dimension,
        key,
        merged: mergedCount,
        closedUnmerged: group.length - mergedCount,
        decided: group.length,
        mergeRate,
        signal: outcomeSignal(mergeRate),
      });
    }
  }

  const successPatterns: OutcomePattern[] = [];
  const riskPatterns: OutcomePattern[] = [];
  if (outsideDecided.length >= REPO_OUTCOME_MIN_DECIDED_SAMPLE && outsideContributorMergeRate >= REPO_OUTCOME_MERGE_WELL_RATE) {
    successPatterns.push({
      repoFullName: args.repoFullName,
      title: "Outside contributors merge well here",
      detail: `Outside-contributor PRs merge at ${percent(outsideContributorMergeRate)} across ${outsideDecided.length} decided PR(s).`,
      confidence: outsideDecided.length >= 6 ? "high" : "medium",
    });
  }
  if (outsideDecided.length >= REPO_OUTCOME_MIN_DECIDED_SAMPLE && outsideContributorMergeRate <= REPO_OUTCOME_CLOSURE_RISK_RATE) {
    riskPatterns.push({
      repoFullName: args.repoFullName,
      title: "Outside contributor PRs rarely merge here",
      detail: `Outside-contributor PRs merge at only ${percent(outsideContributorMergeRate)} across ${outsideDecided.length} decided PR(s); expect a high closure rate.`,
      confidence: outsideDecided.length >= 6 ? "high" : "medium",
    });
  }
  for (const dimension of dimensions) {
    if (dimension.signal === "merges_well") {
      successPatterns.push({
        repoFullName: args.repoFullName,
        title: "Merge-friendly pattern",
        detail: `${describeDimension(dimension.dimension, dimension.key)} merge well here (${dimension.merged}/${dimension.decided} merged).`,
        confidence: dimension.decided >= 5 && dimension.mergeRate >= 0.8 ? "high" : "medium",
      });
    } else if (dimension.signal === "high_closure_risk") {
      riskPatterns.push({
        repoFullName: args.repoFullName,
        title: "High closure-risk pattern",
        detail: `${describeDimension(dimension.dimension, dimension.key)} have high closure risk here (${dimension.merged}/${dimension.decided} merged).`,
        confidence: dimension.decided >= 5 ? "high" : "medium",
      });
    }
  }
  if (totals.openStale > 0) {
    riskPatterns.push({
      repoFullName: args.repoFullName,
      title: "Stale open PRs",
      detail: `${totals.openStale} open PR(s) have been idle for at least ${REPO_OUTCOME_STALE_OPEN_DAYS} days and may not convert.`,
      confidence: totals.openStale >= 4 ? "high" : "medium",
    });
  }

  const findings: SignalFinding[] = [];
  if (outsideDecided.length < REPO_OUTCOME_MIN_DECIDED_SAMPLE) {
    findings.push({
      code: "low_outcome_sample",
      severity: "info",
      title: "Not enough decided outside-contributor PRs",
      detail: `Only ${outsideDecided.length} decided outside-contributor PR(s) are cached; merge/close patterns will sharpen as more PRs are synced.`,
    });
  }
  if (maintainer.length > 0) {
    findings.push({
      code: "maintainer_activity_separated",
      severity: "info",
      title: "Maintainer-lane activity separated",
      detail: `${maintainer.length} maintainer-lane PR(s) were excluded from outside-contributor merge evidence.`,
    });
  }
  if (totals.openStale > 0) {
    findings.push({
      code: "stale_open_prs",
      severity: "warning",
      title: "Stale open PRs are present",
      detail: `${totals.openStale} open PR(s) have not updated in at least ${REPO_OUTCOME_STALE_OPEN_DAYS} days.`,
      action: "Triage stale open PRs before assuming new work in this repo will land quickly.",
    });
  }

  const detailByNumber = new Map<number, PullRequestDetailSyncStateRecord>();
  for (const state of args.detailSyncStates ?? []) {
    if (state.repoFullName.toLowerCase() === repoKey) detailByNumber.set(state.pullNumber, state);
  }
  // evidenceCompleteness tracks detail-sync progress for pull_requests records only — merged-only records from
  // recent_merged_pull_requests are never eligible for detail sync and must not dilute the denominator.
  const syncEligible = analyzed.filter((pr) => seenNumbers.has(pr.number));
  const withFileDetail = syncEligible.filter((pr) => Boolean(detailByNumber.get(pr.number)?.filesSyncedAt)).length;
  const withReviewDetail = syncEligible.filter((pr) => Boolean(detailByNumber.get(pr.number)?.reviewsSyncedAt)).length;
  const withCheckDetail = syncEligible.filter((pr) => Boolean(detailByNumber.get(pr.number)?.checksSyncedAt)).length;
  const fullyDecidedWithDetail = decided.filter((pr) => {
    if (!seenNumbers.has(pr.number)) return false;
    const state = detailByNumber.get(pr.number);
    return Boolean(state?.filesSyncedAt && state?.reviewsSyncedAt && state?.checksSyncedAt);
  }).length;
  const filesCompletenessRatio = rate(withFileDetail, syncEligible.length);
  const reviewsCompletenessRatio = rate(withReviewDetail, syncEligible.length);
  const checksCompletenessRatio = rate(withCheckDetail, syncEligible.length);
  const completenessStatus: RepoOutcomeEvidenceCompleteness["status"] =
    syncEligible.length === 0 || (withFileDetail === 0 && withReviewDetail === 0 && withCheckDetail === 0)
      ? "missing"
      : filesCompletenessRatio >= 0.85 && reviewsCompletenessRatio >= 0.85 && checksCompletenessRatio >= 0.85
        ? "complete"
        : "partial";
  const evidenceCompleteness: RepoOutcomeEvidenceCompleteness = {
    pullRequestsAnalyzed: analyzed.length,
    withFileDetail,
    withReviewDetail,
    withCheckDetail,
    filesCompletenessRatio,
    reviewsCompletenessRatio,
    checksCompletenessRatio,
    fullyDecidedWithDetail,
    status: completenessStatus,
  };
  if (analyzed.length > 0 && completenessStatus !== "complete") {
    findings.push({
      code: "incomplete_evidence",
      severity: completenessStatus === "missing" ? "warning" : "info",
      title: completenessStatus === "missing" ? "PR file/review/check evidence is missing" : "PR file/review/check evidence is partial",
      detail: `Files synced for ${percent(filesCompletenessRatio)} of analyzed PR(s), reviews for ${percent(reviewsCompletenessRatio)}, checks for ${percent(checksCompletenessRatio)}. Path, size, test-evidence, and review-churn dimensions only reflect PRs with detail-level sync.`,
      action: "Wait for detail-level PR sync to complete (or trigger a backfill) before relying on path/test/review dimensions for this repo.",
    });
  }

  const sortPatterns = (patterns: OutcomePattern[]) =>
    patterns
      .sort((left, right) => patternRank(right) - patternRank(left) || left.title.localeCompare(right.title) || left.detail.localeCompare(right.detail))
      .slice(0, REPO_OUTCOME_MAX_PATTERNS);

  return {
    repoFullName: args.repoFullName,
    generatedAt: nowIso(),
    lane,
    primaryLanguage,
    sampleSize: outsideDecided.length,
    totals,
    outsideContributorMergeRate,
    maintainerLaneMergeRate,
    dimensions,
    successPatterns: sortPatterns(successPatterns),
    riskPatterns: sortPatterns(riskPatterns),
    evidenceCompleteness,
    findings,
    summary: `${args.repoFullName}: ${totals.merged} merged, ${totals.closedUnmerged} closed-unmerged, ${totals.openActive + totals.openStale} open (${totals.openStale} stale) PR(s); outside-contributor merge rate ${percent(outsideContributorMergeRate)} across ${outsideDecided.length} decided PR(s); evidence ${completenessStatus} (files ${percent(filesCompletenessRatio)}, reviews ${percent(reviewsCompletenessRatio)}, checks ${percent(checksCompletenessRatio)}).`,
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
    /* v8 ignore next -- Role-context builders always return reasons; fallback protects manually constructed objects. */
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
    /* v8 ignore next -- Signal builders always return finding arrays; fallback protects manually constructed fixtures. */
    ...(queueHealth.findings ?? []),
    /* v8 ignore next -- Signal builders always return finding arrays; fallback protects manually constructed fixtures. */
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
  bounties: BountyRecord[] = [],
  issueQuality?: IssueQualityReport | null | undefined,
): PreflightResult {
  const lane = buildLaneAdvice(repo, input.repoFullName);
  const linkedIssues = [...new Set([...(input.linkedIssues ?? []), ...extractLinkedIssueNumbers(input.body ?? "")])].sort((left, right) => left - right);
  // Flag an existing open-work cluster as a possible duplicate when it shares a
  // linked issue, OR when its title/body meaningfully overlaps the planned
  // contribution. The previous check used `item.title.includes(input.title)`,
  // which only matched when an existing item's title contained the *entire*
  // planned title — so a typical (longer, more descriptive) planned PR title
  // never matched a shorter duplicate issue, silently suppressing the warning,
  // while a short planned title spuriously matched unrelated items. Use the same
  // symmetric term-overlap heuristic `buildCollisionReport` uses between items
  // (>=2 shared meaningful terms), which is direction-independent.
  const plannedTerms = plannedContributionTerms(input);
  const collisions = buildCollisionReport(input.repoFullName, issues, pullRequests).clusters.filter((cluster) =>
    cluster.items.some((item) => {
      if (linkedIssues.includes(item.number)) {
        return true;
      }
      const overlap = termOverlap(plannedTerms, collisionTerms(item));
      return overlap.shared >= 2 && overlap.score >= 0.5;
    }),
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
      /* v8 ignore next -- High-risk severity is covered through collision reports; info-only clusters are presentation fallback. */
      severity: collisions.some((cluster) => cluster.risk === "high") ? "warning" : "info",
      title: "Possible duplicate or overlapping work",
      detail: `${collisions.length} related open work cluster(s) were detected.`,
      action: "Check active issues and PRs before submitting.",
    });
  }
  const bountyByIssue = indexBountiesByIssue(bounties);
  for (const issueNumber of linkedIssues) {
    const bounty = bountyByIssue.get(bountyIssueKey(input.repoFullName, issueNumber));
    if (!bounty) continue;
    const linkedIssue = issues.find((candidate) => candidate.repoFullName.toLowerCase() === input.repoFullName.toLowerCase() && candidate.number === issueNumber) ?? null;
    const lifecycle = classifyBountyLifecycle(bounty, linkedIssue);
    if (isHistoricalBountyLifecycle(lifecycle)) {
      findings.push({
        code: "linked_issue_bounty_historical",
        severity: "info",
        title: "Linked issue bounty is historical",
        detail: `Issue #${issueNumber} has a ${lifecycle} bounty; confirm the work is still wanted before investing in it.`,
        action: "Verify the bounty and issue are still open upstream.",
      });
    } else if (lifecycle === "stale" || lifecycle === "ambiguous") {
      findings.push({
        code: "linked_issue_bounty_unverified",
        severity: "warning",
        title: "Linked issue bounty needs verification",
        detail: `Issue #${issueNumber} has a ${lifecycle} bounty; confirm it is still active before relying on it as contribution context.`,
        action: "Re-check the upstream bounty source before submitting.",
      });
    }
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
  bounties: BountyRecord[] = [],
  issueQuality?: IssueQualityReport | null | undefined,
): LocalDiffPreflightResult {
  /* v8 ignore next -- Undefined metadata arrays are normalized at API/MCP boundaries; local analysis tests cover empty metadata behavior. */
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
    bounties,
    issueQuality,
  );
  const codeFileCount = changedFiles.filter(isCodeFile).length;
  const testFileCount = changedFiles.filter(isTestFile).length;
  /* v8 ignore next -- Sparse local-git adapters omit changed-line totals; aggregate local diff behavior covers the zero fallback. */
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
  if (codeFileCount > 0 && testFileCount === 0 && !hasLocalTestEvidence({ tests: input.tests, testFiles: input.testFiles })) {
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
    /* v8 ignore next -- Hold status is produced by buildPreflightResult; this wrapper only preserves that already-tested state. */
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
  /* v8 ignore next -- Review priority is response shaping over finding generation and check/review counts covered above. */
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
  bounties: BountyRecord[] = [],
  prebuiltCollisions?: CollisionReport,
  recentMergedPullRequests: RecentMergedPullRequestRecord[] = [],
): IssueQualityReport {
  const lane = buildLaneAdvice(repo, fullName);
  const collisions = prebuiltCollisions ?? buildCollisionReport(fullName, issues, pullRequests, recentMergedPullRequests);
  const bountyByIssue = indexBountiesByIssue(bounties);
  const lifecycleByIssue = new Map(buildIssueDiscoveryLifecycleReport(repo, issues, pullRequests, fullName, recentMergedPullRequests).states.map((entry) => [entry.number, entry]));
  const reports = issues
    .filter((issue) => issue.state === "open")
    .slice(0, 100)
    .map((issue) => {
      const linkedPrs = pullRequests.filter((pr) => pr.linkedIssues.includes(issue.number) || issue.linkedPrs.includes(pr.number));
      const linkedMergedPrs = recentMergedPullRequests.filter((pr) => pr.linkedIssues.includes(issue.number) || issue.linkedPrs.includes(pr.number));
      const issueCollisions = collisions.clusters.filter((cluster) => cluster.items.some((item) => item.type === "issue" && item.number === issue.number));
      /* v8 ignore next -- Missing issue dates normalize to zero age; issue-quality status tests cover age-driven behavior. */
      const age = daysSince(issue.updatedAt ?? issue.createdAt);
      /* v8 ignore next -- Lifecycle map is built from the same issue set; fallback protects malformed external issue-quality payloads. */
      const lifecycleEntry = lifecycleByIssue.get(issue.number);
      const lifecycle = lifecycleEntry?.state ?? "open";
      const bodyLength = issue.body?.trim().length ?? 0;
      const bounty = bountyByIssue.get(bountyIssueKey(fullName, issue.number)) ?? null;
      const bountyLifecycle = bounty ? classifyBountyLifecycle(bounty, issue) : null;
      const bountyContext = bounty ? buildBountyOpportunityContext(bounty, issue, linkedPrs, linkedMergedPrs) : undefined;
      const linkedWorkCount = linkedPrs.length + linkedMergedPrs.length + issue.linkedPrs.length;
      const linkage = buildIssueLinkageRecord(issue, lifecycleEntry, linkedPrs, linkedMergedPrs);
      const reasons = [
        ...(bodyLength >= 200 ? ["Issue has enough body detail to evaluate."] : []),
        ...(issue.labels.length > 0 ? [`Labels: ${issue.labels.join(", ")}.`] : []),
        ...(linkedWorkCount === 0 ? ["No active PR is linked in cached metadata."] : []),
        ...(bountyLifecycle === "active" ? ["Active bounty context is attached (contribution context, not guaranteed payout)."] : []),
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
        ...(bountyLifecycle === "completed" ? ["A completed bounty is attached; the work is likely already solved, not an open opportunity."] : []),
        ...(bountyLifecycle === "cancelled" ? ["A cancelled bounty is attached; this is not an active opportunity."] : []),
        ...(bountyLifecycle === "historical" ? ["Historical bounty context is attached; this is not an active opportunity without upstream confirmation."] : []),
        ...(bountyLifecycle === "stale" ? ["Bounty context for this issue looks stale; confirm it is still active before acting."] : []),
        ...(bountyLifecycle === "ambiguous" ? ["Bounty state for this issue is ambiguous; verify it before acting."] : []),
      ];
      const score = clamp(100 - warnings.length * 18 + reasons.length * 5 - (age > 180 ? 15 : 0), 0, 100);
      const bountyBlocks = bountyLifecycle === "completed" || bountyLifecycle === "cancelled" || bountyLifecycle === "historical";
      const bountyCaution = bountyLifecycle === "stale" || bountyLifecycle === "ambiguous";
      const status: IssueQualityReport["issues"][number]["status"] =
        linkedWorkCount > 0 || issueCollisions.some((cluster) => cluster.risk === "high") || bountyBlocks || ["duplicate", "invalid", "solved", "valid_solved"].includes(lifecycle)
          ? "do_not_use"
          : warnings.some((warning) => /thin|stale|direct-PR/i.test(warning)) || bountyCaution || lifecycle === "stale"
            ? "needs_proof"
            : score < 45
              ? "hold"
              : "ready";
      return { number: issue.number, title: issue.title, lifecycle, linkage, bounty: bountyContext, status, score, reasons, warnings };
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

function buildIssueLinkageRecord(
  issue: IssueRecord,
  lifecycleEntry: IssueDiscoveryLifecycleReport["states"][number] | undefined,
  linkedPrs: PullRequestRecord[],
  linkedMergedPrs: RecentMergedPullRequestRecord[],
): IssueLinkageRecord {
  const solvedByPullRequests = [
    ...new Set([
      ...(lifecycleEntry?.solvedByPullRequests ?? []),
      ...linkedPrs.filter((pr) => pr.mergedAt || pr.state === "merged").map((pr) => pr.number),
      ...linkedMergedPrs.map((pr) => pr.number),
    ]),
  ].sort((left, right) => left - right);
  const linkedWorkCount = linkedPrs.length + linkedMergedPrs.length + issue.linkedPrs.length;
  const lifecycle = lifecycleEntry?.state;
  const status: IssueLinkageRecord["status"] =
    solvedByPullRequests.length > 0 || lifecycle === "solved" || lifecycle === "valid_solved"
      ? "validated"
      : lifecycle === "closed_not_solved" || lifecycle === "duplicate" || lifecycle === "invalid" || issue.state !== "open"
        ? "invalid"
        : linkedWorkCount > 0
          ? "plausible"
          : lifecycle
            ? "raw"
            : "unavailable";
  const issueRef = `#${issue.number}`;
  const reason =
    status === "validated"
      ? `Cached GitHub linkage has solved-by-PR evidence for ${issueRef}${solvedByPullRequests.length > 0 ? ` via ${solvedByPullRequests.map((number) => `#${number}`).join(", ")}` : ""}.`
      : status === "invalid"
        ? `Cached GitHub linkage marks ${issueRef} as ${lifecycle?.replace(/_/g, " ") ?? issue.state}.`
        : status === "plausible"
          ? `Cached GitHub linkage has PR context for ${issueRef}, but no solved-by-PR evidence yet.`
          : status === "unavailable"
            ? `No cached linkage state was available for ${issueRef}.`
            : `Cached GitHub linkage has only a raw issue reference for ${issueRef}.`;
  return {
    status,
    source: status === "unavailable" ? "missing" : "github_cache",
    solvedByPullRequests,
    reason,
    warnings: issueLinkageWarnings(status),
  };
}

function issueLinkageWarnings(status: IssueLinkageRecord["status"]): string[] {
  if (status === "validated") return [];
  if (status === "invalid") return ["Issue linkage should not be treated as multiplier-validated."];
  if (status === "unavailable") return ["Issue linkage data is unavailable; confirm solved-by-PR state before relying on it."];
  if (status === "plausible") return ["Issue linkage is plausible but not solved-by-PR validated yet."];
  return ["Raw issue reference has no solved-by-PR evidence yet."];
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
  /* v8 ignore next -- Missing PR dates normalize to fresh; burden tests cover timestamp parsing and stale classification. */
  const updatedRecently = openPrs.filter((pr) => daysSince(pr.updatedAt ?? pr.createdAt) <= horizonDays).length;
  /* v8 ignore next -- Missing PR dates normalize to fresh; burden tests cover timestamp parsing and stale classification. */
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
    /* v8 ignore next -- Null repo fallback is for computed forecasts over collision snapshots; route tests cover missing-repo responses. */
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
      /* v8 ignore next -- Maintainer-lane strategy readiness is already represented in repo-fit and reward-risk outputs. */
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

// All comparable RegistryRepoConfig fields, rendered to a stable string for diffing.
// Mirrors REGISTRY_DRIFT_COMPARABLE_FIELDS in upstream/ruleset.ts so the live change
// report and the drift comparator cannot diverge as config fields are added — every
// scoring-relevant field (fixed_base_score, default_label_multiplier, eligibility_mode)
// is covered, not just the emission/lane subset.
const REGISTRY_CHANGE_FIELDS: Array<{ label: string; render: (config: RegistryRepoConfig) => string }> = [
  { label: "emission_share", render: (config) => String(config.emissionShare) },
  { label: "issue_discovery_share", render: (config) => String(config.issueDiscoveryShare) },
  { label: "maintainer_cut", render: (config) => String(config.maintainerCut) },
  { label: "fixed_base_score", render: (config) => (config.fixedBaseScore ?? null) === null ? "none" : String(config.fixedBaseScore) },
  { label: "default_label_multiplier", render: (config) => (config.defaultLabelMultiplier ?? null) === null ? "none" : String(config.defaultLabelMultiplier) },
  { label: "eligibility_mode", render: (config) => config.eligibilityMode ?? "default" },
  /* v8 ignore next -- Boolean defaulting protects older registry snapshots without trusted_label_pipeline. */
  { label: "trusted_label_pipeline", render: (config) => String(config.trustedLabelPipeline ?? false) },
  { label: "label_multipliers", render: (config) => JSON.stringify(config.labelMultipliers) },
];

function registryConfigChanges(previous: RegistryRepoConfig, current: RegistryRepoConfig): string[] {
  return REGISTRY_CHANGE_FIELDS.flatMap((field) => {
    const before = field.render(previous);
    const after = field.render(current);
    if (before === after) return [];
    // labelMultipliers is an object diff; report the fact of change, not the JSON blob.
    return [field.label === "label_multipliers" ? "label_multipliers changed" : `${field.label} ${before} -> ${after}`];
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
      const changes = registryConfigChanges(old, repo);
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

export const BOUNTY_STALE_DAYS = 45;

export function bountyIssueKey(repoFullName: string, issueNumber: number): string {
  return `${repoFullName.toLowerCase()}#${issueNumber}`;
}

export function indexBountiesByIssue(bounties: BountyRecord[]): Map<string, BountyRecord> {
  const map = new Map<string, BountyRecord>();
  for (const bounty of bounties) {
    map.set(bountyIssueKey(bounty.repoFullName, bounty.issueNumber), bounty);
  }
  return map;
}

export function classifyBountyLifecycle(bounty: BountyRecord, issue: IssueRecord | null): BountyLifecycle {
  const status = bounty.status.trim().toLowerCase();
  if (!status) return "unknown";
  if (/cancel|void|expired|withdrawn|rejected|abandon/.test(status)) return "cancelled";
  // Only past-tense payout phrasing (rewarded/awarded) marks completion; a bounty that merely
  // advertises a "reward"/"award" is an active offer, not already-completed work.
  if (/complete|paid|resolved|rewarded|awarded|fulfil|merged|claimed|done/.test(status)) return "completed";
  if (/historical|archived|closed/.test(status)) return "historical";
  const looksActive = /open|active|live|available|ready|funded|reward|award|in[\s_-]?progress|todo|new/.test(status);
  if (!looksActive) return "ambiguous";
  // Active-looking status: reconcile against the linked issue and freshness so dead context is not treated as live.
  if (issue && issue.state !== "open") return "ambiguous";
  if (daysSince(bounty.updatedAt ?? bounty.discoveredAt) > BOUNTY_STALE_DAYS) return "stale";
  return "active";
}

export function isHistoricalBountyLifecycle(lifecycle: BountyLifecycle): boolean {
  return lifecycle === "historical" || lifecycle === "completed" || lifecycle === "cancelled";
}

function buildBountySourceContext(bounty: BountyRecord): BountySourceContext {
  const observedAt = bounty.updatedAt ?? bounty.discoveredAt ?? null;
  const ageDays = observedAt ? daysSince(observedAt) : null;
  return {
    sourceUrl: bounty.sourceUrl ?? null,
    discoveredAt: bounty.discoveredAt ?? null,
    updatedAt: bounty.updatedAt ?? null,
    observedAt,
    ageDays,
    freshness: ageDays === null ? "unknown" : ageDays > BOUNTY_STALE_DAYS ? "stale" : "fresh",
  };
}

function buildBountyLinkedPrs(
  issue: IssueRecord | null,
  pullRequests: PullRequestRecord[],
  recentMergedPullRequests: RecentMergedPullRequestRecord[] = [],
): BountyLinkedPr[] {
  if (!issue) return [];
  const linkedNumbers = new Set<number>(issue.linkedPrs);
  for (const pr of pullRequests) {
    if (pr.linkedIssues.includes(issue.number)) linkedNumbers.add(pr.number);
  }
  for (const pr of recentMergedPullRequests) {
    if (pr.linkedIssues.includes(issue.number)) linkedNumbers.add(pr.number);
  }
  const byNumber = new Map(pullRequests.map((pr) => [pr.number, pr]));
  const recentMergedByNumber = new Set(recentMergedPullRequests.map((pr) => pr.number));
  return [...linkedNumbers].sort((left, right) => left - right).map((number) => {
    const pr = byNumber.get(number);
    const state: BountyLinkedPr["state"] = recentMergedByNumber.has(number)
      ? "merged"
      : !pr
        ? "unknown"
        : pr.mergedAt
          ? "merged"
          : pr.state === "open"
            ? "open"
            : "closed";
    return { number, state, isActive: state === "open" };
  });
}

function buildBountyOpportunityContext(
  bounty: BountyRecord,
  issue: IssueRecord | null,
  pullRequests: PullRequestRecord[] = [],
  recentMergedPullRequests: RecentMergedPullRequestRecord[] = [],
): BountyOpportunityContext {
  const advisory = buildBountyAdvisory(bounty, null, issue, pullRequests, recentMergedPullRequests);
  return {
    id: advisory.id,
    lifecycle: advisory.lifecycle,
    isActiveOpportunity: advisory.isActiveOpportunity,
    fundingStatus: advisory.fundingStatus,
    consensusRisk: advisory.consensusRisk,
    source: advisory.source,
    linkedPrs: advisory.linkedPrs,
  };
}

/**
 * Bounty/issue consensus risk derived from linked PR STATE, not raw count, so historical or closed
 * attempts are never scored the same as multiple active open PRs:
 *  - multiple open PRs    -> high (concurrent active overlap / strong duplicate-work risk)
 *  - a single open PR     -> medium (active overlap, but not yet crowded)
 *  - any merged PR        -> medium (work may already be solved)
 *  - several closed or otherwise unresolved PRs -> medium (ambiguous history worth caution)
 */
function computeBountyConsensusRisk(
  lifecycle: BountyLifecycle,
  issue: IssueRecord | null,
  open: number,
  merged: number,
  closed: number,
  unknown: number,
): BountyAdvisory["consensusRisk"] {
  if (open > 1) return "high";
  if (lifecycle === "active" && !issue) return "high";
  if (open === 1 || merged > 0 || closed > 1 || unknown > 1) return "medium";
  return "low";
}

export function buildBountyAdvisory(
  bounty: BountyRecord,
  repo: RepositoryRecord | null,
  issue: IssueRecord | null,
  pullRequests: PullRequestRecord[] = [],
  recentMergedPullRequests: RecentMergedPullRequestRecord[] = [],
): BountyAdvisory {
  const lifecycle = classifyBountyLifecycle(bounty, issue);
  const target = bounty.payload.target_bounty ?? bounty.payload.target_alpha;
  const amount = bounty.payload.bounty_amount ?? bounty.payload.bounty_alpha;
  /* v8 ignore next -- Unknown funding is a sparse-cache fallback; funded and target-only states are covered. */
  const fundingStatus = amount && amount !== 0 && amount !== "0.0000" ? "funded" : target ? "target_only" : "unknown";
  const source = buildBountySourceContext(bounty);
  const linkedPrs = buildBountyLinkedPrs(issue, pullRequests, recentMergedPullRequests);
  const findings: SignalFinding[] = [];
  if (lifecycle === "completed") {
    findings.push({
      code: "completed_bounty",
      severity: "info",
      title: "Bounty is completed",
      detail: "This bounty is marked completed in the local cache; treat it as historical context, not an open contribution opportunity.",
    });
  }
  if (lifecycle === "historical") {
    findings.push({
      code: "historical_bounty",
      severity: "info",
      title: "Bounty is historical",
      detail: "This bounty is marked historical in the local cache; treat it as contribution context, not an active opportunity.",
    });
  }
  if (lifecycle === "cancelled") {
    findings.push({
      code: "cancelled_bounty",
      severity: "info",
      title: "Bounty is cancelled",
      detail: "This bounty is marked cancelled in the local cache and is not an active contribution opportunity.",
    });
  }
  if (lifecycle === "stale") {
    findings.push({
      code: "stale_bounty",
      severity: "warning",
      title: "Bounty context may be stale",
      detail: `This bounty has not been refreshed in over ${BOUNTY_STALE_DAYS} days; confirm it is still active before acting on it.`,
      action: "Re-check the upstream bounty source before treating this as active contribution context.",
    });
  }
  if (lifecycle === "ambiguous") {
    findings.push({
      code: "ambiguous_bounty",
      severity: "warning",
      title: "Bounty state is ambiguous",
      detail: "The bounty status or its linked issue state is inconsistent, so its current state cannot be confirmed from the local cache.",
      action: "Confirm the bounty and issue state upstream before treating this as active contribution context.",
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
  // Linked PRs carry different risk by state: open = active overlap, merged = possibly solved,
  // closed-unmerged = historical attempts. Surface each class with its own wording so contributors
  // know whether they are avoiding duplicate active work, verifying a solved bounty, or reviewing history.
  const openLinkedPrs = linkedPrs.filter((pr) => pr.state === "open");
  const mergedLinkedPrs = linkedPrs.filter((pr) => pr.state === "merged");
  const closedLinkedPrs = linkedPrs.filter((pr) => pr.state === "closed");
  const unknownLinkedPrs = linkedPrs.filter((pr) => pr.state === "unknown");
  const prRefs = (prs: BountyLinkedPr[]): string => prs.map((pr) => `#${pr.number}`).join(", ");
  if (openLinkedPrs.length > 0) {
    findings.push({
      code: "bounty_has_active_pr",
      severity: openLinkedPrs.length > 1 ? "warning" : "info",
      title: openLinkedPrs.length > 1 ? "Multiple open PRs are actively working this bounty issue" : "An open PR is actively working this bounty issue",
      detail: `${openLinkedPrs.length} open PR(s) (${prRefs(openLinkedPrs)}) already reference this bounty's issue; you may be duplicating active in-progress work. Confirm solver state before starting overlapping work.`,
      action: "Review the open PR(s) before starting so you do not duplicate active work.",
    });
  }
  if (mergedLinkedPrs.length > 0) {
    findings.push({
      code: "bounty_linked_pr_merged",
      severity: "warning",
      title: "A merged PR may already resolve this bounty",
      detail: `${mergedLinkedPrs.length} merged PR(s) (${prRefs(mergedLinkedPrs)}) reference this bounty's issue; the work may already be solved. Verify the bounty is still open before investing in it.`,
      action: "Verify upstream that the bounty is still unsolved before starting.",
    });
  }
  if (closedLinkedPrs.length > 0) {
    findings.push({
      code: "bounty_linked_pr_closed_history",
      severity: closedLinkedPrs.length > 1 ? "warning" : "info",
      title: closedLinkedPrs.length > 1 ? "Several closed (unmerged) PRs attempted this bounty issue" : "A closed (unmerged) PR attempted this bounty issue",
      detail: `${closedLinkedPrs.length} closed, unmerged PR(s) (${prRefs(closedLinkedPrs)}) reference this bounty's issue. These are historical attempts, not active competing work; review why they were closed before re-attempting.`,
      action: "Review the closed attempt(s) to understand why they did not land.",
    });
  }
  return {
    id: bounty.id,
    repoFullName: bounty.repoFullName,
    issueNumber: bounty.issueNumber,
    status: bounty.status,
    lifecycle,
    isActiveOpportunity: lifecycle === "active",
    fundingStatus,
    consensusRisk: computeBountyConsensusRisk(lifecycle, issue, openLinkedPrs.length, mergedLinkedPrs.length, closedLinkedPrs.length, unknownLinkedPrs.length),
    source,
    linkedPrs,
    findings,
  };
}

export function buildPublicReadinessScore(args: {
  pr: PullRequestRecord;
  preflight: PreflightResult;
  queueHealth: QueueHealth;
  linkedDuplicatePrs?: number[] | undefined;
  scopedOverlapCount?: number | undefined;
}): PublicReadinessScore {
  const linkedIssues = args.pr.linkedIssues;
  const hasNoIssueRationale = hasClearNoIssueRationale(args.pr);
  const linkedDuplicatePrs = args.linkedDuplicatePrs ?? [];
  const scopedOverlapCount = args.scopedOverlapCount ?? 0;
  const reviewLoadScore = reviewLoadComponentScore(args.preflight.reviewBurden);
  const validation = validationComponent(args.pr, args.preflight);
  const queuePressure = queuePressureComponent(args.queueHealth);
  const components: PublicReadinessScore["components"] = [
    {
      key: "traceability",
      label: "Traceability",
      score: linkedIssues.length > 0 || hasNoIssueRationale ? 15 : 8,
      max: 15,
      evidence:
        linkedIssues.length > 0
          ? `Linked issue${linkedIssues.length === 1 ? "" : "s"} ${formatIssueRefs(linkedIssues)}.`
          : hasNoIssueRationale
            ? "PR body includes a no-issue rationale."
            : "No linked issue or no-issue rationale found.",
      action: linkedIssues.length > 0 || hasNoIssueRationale ? "No action." : "Explain no-issue PR.",
    },
    {
      key: "related_work",
      label: "Related work",
      score: linkedDuplicatePrs.length > 0 ? 8 : scopedOverlapCount > 0 ? 14 : 20,
      max: 20,
      evidence:
        linkedDuplicatePrs.length > 0
          ? `Same linked issue with ${formatPrRefs(linkedDuplicatePrs)}.`
          : scopedOverlapCount > 0
            ? `${Math.min(scopedOverlapCount, 3)} scoped overlap${Math.min(scopedOverlapCount, 3) === 1 ? "" : "s"} found.`
            : "No active overlap found.",
      action: linkedDuplicatePrs.length > 0 ? `Compare ${formatPrRefs(linkedDuplicatePrs)}.` : scopedOverlapCount > 0 ? "Review top overlaps." : "No action.",
    },
    {
      key: "change_scope",
      label: "Change scope",
      score: reviewLoadScore,
      max: 20,
      evidence: `Readiness component derived from cached public PR metadata and labels${formatSizeLabelEvidence(args.pr.labels)}.`,
      action: reviewLoadScore >= 18 ? "No action." : "Add scope summary.",
    },
    {
      key: "validation",
      label: "Validation evidence",
      score: validation.score,
      max: 25,
      evidence: validation.evidence,
      action: validation.action,
    },
    {
      key: "pr_state",
      label: "PR state",
      score: args.pr.state === "open" && !args.pr.isDraft ? 10 : args.pr.state === "open" ? 6 : 3,
      max: 10,
      evidence: args.pr.isDraft ? "PR is open as draft." : `PR state is ${args.pr.state}.`,
      action: args.pr.state === "open" && !args.pr.isDraft ? "No action." : args.pr.isDraft ? "Mark ready when done." : "No action.",
    },
    {
      key: "queue_pressure",
      label: "Open PR queue",
      score: queuePressure.score,
      max: queuePressure.max,
      evidence: queuePressure.evidence,
      action: queuePressure.action,
    },
  ];
  return {
    total: clamp(
      components.reduce((sum, component) => sum + component.score, 0),
      0,
      100,
    ),
    components,
  };
}

export const PR_PANEL_RETRIGGER_MARKER = "<!-- gittensory-rerun-review:v1 -->";

export function buildPublicPrIntelligenceComment(args: {
  repo: RepositoryRecord | null;
  pr: PullRequestRecord;
  profile: ContributorProfile;
  detection: ContributorDetection;
  queueHealth: QueueHealth;
  collisions: CollisionReport;
  preflight: PreflightResult;
  settings: RepositorySettings;
  gate?: PublicPrPanelGateEvaluation | undefined;
}): string {
  const publicFindings = args.preflight.findings
    .filter((finding) => finding.severity !== "critical")
    .filter((finding) => args.settings.requireLinkedIssue || args.settings.linkedIssueGateMode !== "off" || finding.code !== "missing_linked_issue")
    .filter((finding) => !containsPrivatePublicTerm([finding.code, finding.title, finding.detail, finding.publicText, finding.action].filter(Boolean).join(" ")))
    .slice(0, args.settings.publicSignalLevel === "minimal" ? 2 : 5);
  const prCollisionClusters = pullRequestSpecificCollisionClusters(args.collisions, args.pr);
  const linkedDuplicatePrs = linkedIssueDuplicatePullRequests(args.pr, prCollisionClusters);
  // Deduplicated union of PR-specific clusters and planned-overlap (preflight) clusters -- they are
  // different filtered subsets of the same report, so the count must be their union, not max(), to
  // match the related-work items rendered in the panel details below.
  const scopedOverlapClusters = [...new Map([...prCollisionClusters, ...args.preflight.collisions].map((cluster) => [cluster.id, cluster])).values()];
  const scopedOverlapCount = scopedOverlapClusters.length;
  const hasRelatedWork = linkedDuplicatePrs.length > 0 || scopedOverlapCount > 0;
  const readiness = buildPublicReadinessScore({ pr: args.pr, preflight: args.preflight, queueHealth: args.queueHealth, linkedDuplicatePrs, scopedOverlapCount });
  const linkedIssueResult = linkedIssuePanelResult(args.pr);
  const relatedWorkResult = relatedWorkPanelResult(linkedDuplicatePrs, scopedOverlapCount);
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
    ...readiness.components.map((component) => component.action).filter((action) => action !== "No action."),
    /* v8 ignore next -- Public findings may omit actions; public comment tests cover sanitized action inclusion. */
    ...(publicFindings.length > 0 ? publicFindings.flatMap((finding) => (finding.action ? [finding.action] : [])) : []),
  ].filter((step) => !containsPrivatePublicTerm(step));
  const gateEnabled = args.settings.gateCheckMode === "enabled";
  const hardLinkedIssueBlock =
    args.settings.linkedIssueGateMode === "block" && args.pr.linkedIssues.length === 0 && !hasClearNoIssueRationale(args.pr);
  const hardDuplicateBlock = args.settings.duplicatePrGateMode === "block" && linkedDuplicatePrs.length > 0;
  const fallbackGateConclusion = !gateEnabled
    ? "success"
    : !args.repo
      ? "action_required"
      : hardLinkedIssueBlock || hardDuplicateBlock
        ? "failure"
        : "success";
  const gateConclusion = args.gate?.conclusion ?? fallbackGateConclusion;
  const gateBlocking = gateEnabled && (gateConclusion === "failure" || gateConclusion === "action_required");
  const missingLinkedIssue = args.pr.linkedIssues.length === 0 && !hasClearNoIssueRationale(args.pr);
  const confirmedMiner = isOfficialContributorDetection(args.detection);
  const genericOssMode = args.settings.publicAudienceMode === "oss_maintainer";
  const hasPublicWarnings = publicFindings.some((finding) => finding.severity === "warning");
  const alert = gateBlocking
    ? gateConclusion === "action_required"
      ? "IMPORTANT"
      : missingLinkedIssue && args.settings.linkedIssueGateMode === "block"
        ? "WARNING"
        : "CAUTION"
    : hasPublicWarnings || hasRelatedWork
      ? "IMPORTANT"
      : "TIP";
  const panelTitle = gateBlocking
    ? "Gittensory Gate is blocking merge"
    : hasPublicWarnings || hasRelatedWork
      ? "Gittensory found maintainer review notes"
      : "Gittensory PR readiness looks good";
  const panelSummary = gateBlocking
    ? args.gate?.summary ?? (gateConclusion === "action_required" ? "Gittensory cannot evaluate the repo state closely enough for the enabled gate." : "A repo-configured hard blocker was found.")
    : linkedDuplicatePrs.length > 0
      ? `Same-issue duplicate risk found against ${formatPrRefs(linkedDuplicatePrs)}. Maintainers should resolve the overlap before review continues.`
      : hasRelatedWork
        ? "Scoped related-work signals were found for this PR. They are advisory unless the gate reports a blocker."
    : genericOssMode
      ? "Public GitHub metadata was checked for review readiness. Gittensor-specific context appears only when confirmed."
      : "Confirmed Gittensor contributor context was checked from public metadata and Gittensory cache.";
  const readinessByKey = new Map(readiness.components.map((component) => [component.key, component]));
  const validationComponent = readinessByKey.get("validation");
  const changeScopeComponent = readinessByKey.get("change_scope");
  const queueComponent = readinessByKey.get("queue_pressure");
  const contributorContext = contributorContextPanelResult(args.pr, args.profile, args.detection, confirmedMiner);
  const rows: Array<[string, string, string, string]> = [
    [
      "Linked issue",
      linkedIssueResult.result,
      linkedIssueResult.evidence,
      linkedIssueResult.action,
    ],
    ["Related work", relatedWorkResult.result, relatedWorkResult.evidence, relatedWorkResult.action],
    /* v8 ignore start -- Readiness components are built as a fixed key set; fallbacks guard future partial score shapes. */
    ["Review load", scoreResultIcon(changeScopeComponent), changeScopeComponent?.evidence ?? "No public scope metadata found.", changeScopeComponent?.action ?? "No action."],
    ["Validation evidence", scoreResultIcon(validationComponent), validationComponent?.evidence ?? "No validation signal found.", validationComponent?.action ?? "Add validation note."],
    ["Open PR queue", scoreResultIcon(queueComponent), queueComponent?.evidence ?? "Open PR queue unavailable.", queueComponent?.action ?? "No action."],
    /* v8 ignore stop */
    ["Contributor context", contributorContext.result, contributorContext.evidence, contributorContext.action],
    ["Gate result", gateStatus(gateEnabled, gateConclusion), gateEnabled ? gateAction(gateConclusion) : "Advisory only.", gateEnabled ? gateNextAction(gateConclusion) : "No action."],
  ];
  const overlapDetails = relatedWorkDetails(args.pr, scopedOverlapClusters);
  const maintainerNotes =
    publicFindings.length > 0
      ? publicFindings.map((finding) => `- ${sanitizePanelText(finding.title)}: ${sanitizePanelText(finding.publicText ?? finding.detail)}`)
      : ["- No public-safe advisory findings were generated from cached metadata."];
  const footer = confirmedMiner || args.settings.publicAudienceMode === "gittensor_only"
    ? "Checked by [Gittensory](https://github.com/JSONbored/gittensory), a quiet PR intelligence layer for OSS maintainers. Learn more about [Gittensor](https://gittensor.io) contribution workflows."
    : "Checked by [Gittensory](https://github.com/JSONbored/gittensory), a quiet PR intelligence layer for OSS maintainers.";
  return [
    "<!-- gittensory-pr-panel:v1 -->",
    "",
    ...formatAlertBlock([
      `[!${alert}]`,
      `## ${panelTitle}`,
      panelSummary,
      "",
      `**Readiness score: ${readiness.total}/100**`,
      "",
      "| Signal | Result | Evidence | Action |",
      "| --- | --- | --- | --- |",
      ...rows.map(([signal, result, evidence, action]) => `| ${escapeTableCell(signal)} | ${escapeTableCell(result)} | ${escapeTableCell(evidence)} | ${escapeTableCell(action)} |`),
    ]),
    "",
    "<details>",
    "<summary>Signal definitions</summary>",
    "",
    "- Related work = same linked issue, overlapping active PRs, or title/path similarity.",
    "- Review load = cached public PR metadata such as size labels, changed paths, and preflight status.",
    "- Open PR queue = repo-wide review pressure; it is not a PR quality failure.",
    "- Contributor context = public GitHub/Gittensor identity context; non-Gittensor status is not a blocker.",
    "",
    "</details>",
    "",
    "<details>",
    "<summary>Review context</summary>",
    "",
    `- Author: \`${sanitizePanelText(args.pr.authorLogin ?? "unknown")}\``,
    `- Role context: ${sanitizePanelText(roleContext.role)}${roleContext.maintainerLane ? " (maintainer lane)" : ""}`,
    `- Public audience mode: ${args.settings.publicAudienceMode.replace(/_/g, " ")}`,
    `- Lane context: ${sanitizePanelText(buildLaneAdvice(args.repo, args.pr.repoFullName).summary)}`,
    `- Public profile languages: ${args.profile.github.topLanguages.length > 0 ? sanitizePanelText(args.profile.github.topLanguages.join(", ")) : "not available"}`,
    ...(confirmedMiner ? [`- Official Gittensor activity: ${args.detection.priorPullRequests} PR(s), ${args.detection.priorIssues} issue(s).`] : ["- Contributor context: Public profile only; not a blocker."]),
    ...overlapDetails,
    "",
    "</details>",
    "",
    "<details>",
    "<summary>Maintainer notes</summary>",
    "",
    ...maintainerNotes,
    "",
    "</details>",
    "",
    "<details>",
    "<summary>Contributor next steps</summary>",
    "",
    ...(nextSteps.length > 0 ? [...new Set(nextSteps)].map((step) => `- ${step}`) : ["- Keep the PR focused and include validation evidence before maintainer review."]),
    "",
    "</details>",
    "",
    `- [ ] ${PR_PANEL_RETRIGGER_MARKER} Re-run Gittensory review`,
    "",
    "---",
    footer,
  ].join("\n");
}

type PublicPrPanelGateEvaluation = {
  conclusion: "success" | "failure" | "action_required" | "neutral" | "skipped";
  summary: string;
};

function isOfficialContributorDetection(detection: ContributorDetection): boolean {
  return detection.source === "official_gittensor_api";
}

function pullRequestSpecificCollisionClusters(report: CollisionReport, pr: PullRequestRecord): CollisionCluster[] {
  return report.clusters.filter((cluster) => cluster.items.some((item) => item.type === "pull_request" && item.number === pr.number));
}

function linkedIssueDuplicatePullRequests(pr: PullRequestRecord, clusters: CollisionCluster[]): number[] {
  const linkedIssues = new Set(pr.linkedIssues);
  if (linkedIssues.size === 0) return [];
  const duplicates = clusters.flatMap((cluster) =>
    cluster.items.flatMap((item) => {
      if (item.type !== "pull_request" || item.number === pr.number) return [];
      return (item.linkedIssues ?? []).some((issue) => linkedIssues.has(issue)) ? [item.number] : [];
    }),
  );
  return [...new Set(duplicates)].sort((left, right) => left - right);
}

function linkedIssuePanelResult(pr: PullRequestRecord): { result: string; evidence: string; action: string } {
  if (pr.linkedIssues.length > 0) {
    return {
      result: `✅ Linked`,
      evidence: formatIssueRefs(pr.linkedIssues),
      action: "No action.",
    };
  }
  if (hasClearNoIssueRationale(pr)) {
    return {
      result: "✅ No-issue rationale",
      evidence: "PR body explains why no issue is linked.",
      action: "No action.",
    };
  }
  return {
    result: "⚠️ Missing",
    evidence: "No linked issue or no-issue rationale found.",
    action: "Explain no-issue PR.",
  };
}

function relatedWorkPanelResult(linkedDuplicatePrs: number[], scopedOverlapCount: number): { result: string; evidence: string; action: string } {
  if (linkedDuplicatePrs.length > 0) {
    return {
      result: `⚠️ Same linked issue: ${formatPrRefs(linkedDuplicatePrs)}`,
      evidence: "Another open PR references the same linked issue.",
      action: `Compare ${formatPrRefs(linkedDuplicatePrs)}.`,
    };
  }
  if (scopedOverlapCount > 0) {
    const visible = Math.min(scopedOverlapCount, 3);
    return {
      result: `⚠️ ${visible} scoped overlap${visible === 1 ? "" : "s"}`,
      evidence: "Top overlaps are listed below; lower-confidence bulk is hidden.",
      action: "Review top overlaps.",
    };
  }
  return {
    result: "✅ No active overlap found",
    evidence: "No same-issue or scoped active PR overlap found.",
    action: "No action.",
  };
}

function contributorContextPanelResult(
  pr: PullRequestRecord,
  profile: ContributorProfile,
  detection: ContributorDetection,
  confirmedMiner: boolean,
): { result: string; evidence: string; action: string } {
  const login = pr.authorLogin ?? profile.login;
  const githubLink = `[${sanitizePanelText(login)}](${githubProfileUrl(login)})`;
  if (!confirmedMiner) {
    return {
      result: "❌ No public Gittensor match",
      evidence: `${githubLink}; not a blocker.`,
      action: "No action.",
    };
  }
  const minerLink = profile.gittensor?.githubId
    ? `[Gittensor profile](${gittensorMinerDashboardUrl(profile.gittensor.githubId)})`
    : "official public Gittensor confirmation";
  return {
    result: "✅ Confirmed Gittensor contributor",
    evidence: `${githubLink}; ${minerLink}; ${detection.priorPullRequests} PR(s), ${detection.priorIssues} issue(s).`,
    action: "No action.",
  };
}

function scoreResultIcon(component: PublicReadinessScore["components"][number] | undefined): string {
  /* v8 ignore next -- Component lookup is fixed today; undefined is a defensive fallback for future score shape drift. */
  if (!component) return "⚠️ No score";
  const ratio = component.score / component.max;
  if (ratio >= 0.85) return `✅ ${component.score}/${component.max}`;
  if (ratio >= 0.45) return `⚠️ ${component.score}/${component.max}`;
  return `❌ ${component.score}/${component.max}`;
}

function reviewLoadComponentScore(reviewBurden: PreflightResult["reviewBurden"]): number {
  if (reviewBurden === "low") return 20;
  if (reviewBurden === "medium") return 14;
  return 8;
}

function validationComponent(pr: PullRequestRecord, preflight: PreflightResult): { score: number; evidence: string; action: string } {
  const findingCodes = preflight.findings.map((finding) => finding.code);
  const missingTests = findingCodes.some((code) => /missing.*test|test.*missing|no_test/i.test(code));
  const explicitValidation = hasValidationNote(pr.body ?? "");
  if (preflight.status === "hold") {
    return { score: 5, evidence: "Cached preflight status is hold.", action: "Fix blocker." };
  }
  if (missingTests && !explicitValidation) {
    return { score: 10, evidence: "No cached test files or validation note found.", action: "Add validation note." };
  }
  if (explicitValidation) {
    return { score: 25, evidence: "PR body includes validation/test evidence.", action: "No action." };
  }
  if (preflight.status === "ready") {
    return { score: 20, evidence: "Cached preflight status is ready; explicit validation note not found.", action: "Add validation note." };
  }
  return { score: 12, evidence: "Cached preflight status needs author follow-up.", action: "Add validation note." };
}

function queuePressureComponent(queueHealth: QueueHealth): { score: number; max: 10; evidence: string; action: string } {
  const signals = queueHealth.signals;
  const openPullRequests = Math.max(0, signals.openPullRequests);
  const cachedOpenPullRequests = Math.max(0, signals.cachedOpenPullRequests ?? signals.ageBuckets.under7Days + signals.ageBuckets.days7To30 + signals.ageBuckets.over30Days);
  const likelyReviewablePullRequests = Math.max(0, Math.min(openPullRequests, signals.likelyReviewablePullRequests));
  const sampledLikelyReviewable = signals.likelyReviewablePullRequestsSource === "sampled_cache" || (signals.likelyReviewablePullRequestsSource === undefined && cachedOpenPullRequests < openPullRequests);
  const score = queuePressureScore(openPullRequests);
  const likelyEvidence =
    openPullRequests === 0
      ? "0 likely reviewable"
      : sampledLikelyReviewable
        ? cachedOpenPullRequests > 0
          ? `${likelyReviewablePullRequests} likely reviewable in ${cachedOpenPullRequests} cached PR(s); full queue reviewability is sampled`
          : "likely-reviewable count unavailable from cached PR metadata"
        : `${likelyReviewablePullRequests} likely reviewable`;
  const detailParts = [
    `${openPullRequests} open PR(s)`,
    likelyEvidence,
    signals.stalePullRequests > 0 ? `${signals.stalePullRequests} stale` : undefined,
    signals.unlinkedPullRequests > 0 ? `${signals.unlinkedPullRequests} unlinked` : undefined,
  ].filter(Boolean);
  return {
    score,
    max: 10,
    evidence: `${detailParts.join(", ")}.`,
    action: score >= 8 ? "No action." : "Expect slower review.",
  };
}

function queuePressureScore(openPullRequests: number): number {
  if (openPullRequests <= 4) return 10;
  if (openPullRequests <= 8) return 8;
  if (openPullRequests <= 13) return 5;
  return 3;
}

function hasClearNoIssueRationale(pr: PullRequestRecord): boolean {
  return /\b(no issue\s*(?:because|:)|no linked issue\s*(?:because|:)|no ticket\s*(?:because|:)|maintenance|docs? only|typo|chore|cleanup)\b/i.test([pr.title, pr.body ?? ""].join(" "));
}

function hasValidationNote(value: string): boolean {
  return /\b(test(?:ed|s|ing)?|validation|validated|verified|manual check|smoke|pytest|vitest|npm test|pnpm test|cargo test|go test)\b/i.test(value);
}

function formatSizeLabelEvidence(labels: string[]): string {
  const sizeLabel = labels.find((label) => /^size[:/-]/i.test(label));
  return sizeLabel ? `; size label ${sizeLabel}` : "";
}

function gateStatus(gateEnabled: boolean, conclusion: PublicPrPanelGateEvaluation["conclusion"]): string {
  if (!gateEnabled) return "⚠️ Advisory only";
  if (conclusion === "success") return "✅ Passing";
  if (conclusion === "action_required") return "⚠️ App action required";
  if (conclusion === "neutral" || conclusion === "skipped") return "⚠️ Skipped";
  return "❌ Blocking";
}

function gateAction(conclusion: PublicPrPanelGateEvaluation["conclusion"]): string {
  if (conclusion === "success") return "No configured blocker found.";
  if (conclusion === "action_required") return "Install/config needs attention.";
  if (conclusion === "neutral" || conclusion === "skipped") return "PR closed before full evaluation.";
  return "Repo-configured hard blocker found.";
}

function gateNextAction(conclusion: PublicPrPanelGateEvaluation["conclusion"]): string {
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") return "No action.";
  if (conclusion === "action_required") return "Fix app config.";
  return "Fix blocker.";
}

function formatPrRefs(numbers: number[]): string {
  return numbers.map((number) => `#${number}`).join(", ");
}

function formatIssueRefs(numbers: number[]): string {
  return numbers.map((number) => `#${number}`).join(", ");
}

function githubProfileUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}`;
}

function gittensorMinerDashboardUrl(githubId: string): string {
  return `https://gittensor.io/miners/details?githubId=${encodeURIComponent(githubId)}`;
}

function relatedWorkDetails(pr: PullRequestRecord, clusters: CollisionCluster[]): string[] {
  if (clusters.length === 0) return ["- PR-specific overlap: none found."];
  const summaries = clusters.slice(0, 3).map((cluster) => {
    const refs = cluster.items
      .filter((item) => !(item.type === "pull_request" && item.number === pr.number))
      .slice(0, 3)
      .map(formatCollisionItemRef)
      .join(", ");
    return `- Related work: ${sanitizePanelText(cluster.reason)}${refs ? ` (${refs})` : ""}`;
  });
  if (clusters.length > summaries.length) summaries.push("- Additional title-only matches omitted; title-only overlap does not block.");
  return summaries;
}

function formatCollisionItemRef(item: CollisionItem): string {
  const label = item.type === "issue" ? "issue" : item.type === "recent_merged_pull_request" ? "merged PR" : "PR";
  const text = `${label} #${item.number}`;
  return item.htmlUrl ? `[${text}](${item.htmlUrl})` : text;
}

function formatAlertBlock(lines: string[]): string[] {
  return lines.map((line) => (line.length > 0 ? `> ${line}` : ">"));
}

function containsPrivatePublicTerm(value: string): boolean {
  return /\b(reward|payout|farming|wallet|hotkey|trust score|raw trust|estimated score|scoreability|likely_duplicate|reviewability\s*\d)\b/i.test(value);
}

function sanitizePanelText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeTableCell(value: string): string {
  return sanitizePanelText(value).replace(/\|/g, "\\|");
}

/**
 * Builds the compact, source-free signal bundle that the optional AI rewrite layer (issue #151)
 * may turn into clearer public prose. It carries only deterministic, public-safe structured
 * signals — counts, levels, booleans, role context, and finding category titles. It deliberately
 * excludes PR title/body, diffs, finding detail text, and any other source contents so the bundle
 * can never leak repository source through the AI provider.
 */
export function buildPublicCommentSignalBundle(args: {
  repo: RepositoryRecord | null;
  pr: PullRequestRecord;
  profile: ContributorProfile;
  detection: ContributorDetection;
  queueHealth: QueueHealth;
  collisions: CollisionReport;
  preflight: PreflightResult;
  settings: RepositorySettings;
}): Record<string, JsonValue> {
  const confirmedMiner = isOfficialContributorDetection(args.detection);
  const prCollisionCount = pullRequestSpecificCollisionClusters(args.collisions, args.pr).length;
  const roleContext = buildRoleContext({
    login: args.pr.authorLogin ?? args.profile.login,
    repo: args.repo,
    repoFullName: args.pr.repoFullName,
    pullRequests: [args.pr],
    issues: [],
    profile: args.profile,
  });
  const publicFindingTitles = args.preflight.findings
    .filter((finding) => finding.severity !== "critical")
    .filter((finding) => args.settings.requireLinkedIssue || finding.code !== "missing_linked_issue")
    .filter((finding) => !containsPrivatePublicTerm([finding.code, finding.title].filter(Boolean).join(" ")))
    .slice(0, args.settings.publicSignalLevel === "minimal" ? 2 : 5)
    .map((finding) => finding.title);
  return {
    confirmedMiner,
    minerSignalDetected: confirmedMiner,
    priorPullRequests: confirmedMiner ? args.detection.priorPullRequests : 0,
    priorIssues: confirmedMiner ? args.detection.priorIssues : 0,
    role: roleContext.role,
    maintainerLane: roleContext.maintainerLane,
    linkedIssueCount: args.pr.linkedIssues.length,
    requireLinkedIssue: args.settings.requireLinkedIssue,
    laneSummary: buildLaneAdvice(args.repo, args.pr.repoFullName).summary,
    reviewBurden: args.preflight.reviewBurden,
    collisionClusters: prCollisionCount,
    queueLevel: args.queueHealth.level,
    topLanguages: args.profile.github.topLanguages.slice(0, 6),
    publicFindingTitles,
  } as Record<string, JsonValue>;
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
  /* v8 ignore start -- Large-queue sampling is a deterministic guard; standard and linked collision paths are covered above. */
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
  /* v8 ignore stop */
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

/**
 * Tokenized terms for the planned contribution, used to detect overlap with
 * existing open work. Mirrors `collisionTerms` so the planned PR is compared to
 * collision items with the same term-overlap heuristic `buildCollisionReport`
 * uses between items, rather than a one-direction substring test.
 */
function plannedContributionTerms(input: PreflightInput): CollisionTerms {
  const terms = new Set(tokenize([input.title, ...(input.labels ?? []), ...(input.changedFiles ?? [])].join(" ")));
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
  return [item.title, ...(item.labels ?? []), ...(item.changedFiles ?? [])].filter(Boolean).join(" ");
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
        /* v8 ignore next -- Medium/high confidence only affects explanatory ranking; outcome pattern presence is covered. */
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
  /* v8 ignore next -- Repo-name tie ordering is deterministic presentation fallback after pattern ranking. */
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
  /* v8 ignore next -- Repo-name tie ordering is deterministic presentation fallback after pattern ranking. */
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

function normalizedRepoName(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
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
  /* v8 ignore next -- Low confidence is a defensive fallback for future pattern variants; current builders emit high/medium. */
  return pattern.confidence === "high" ? 3 : pattern.confidence === "medium" ? 2 : 1;
}

function daysSince(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  /* v8 ignore next -- Invalid provider timestamps normalize to fresh; stale timestamp handling is covered by signal tests. */
  if (!Number.isFinite(parsed)) return 0;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

function pathBucket(path: string): string {
  const normalized = path.replace(/^\.?\/+/, "");
  const slash = normalized.indexOf("/");
  return slash === -1 ? "(root)" : `${normalized.slice(0, slash)}/`;
}

function sizeBucket(pr: { changedLineCount: number; filePaths: string[] }): "small" | "medium" | "large" | null {
  if (pr.changedLineCount > 0) {
    return pr.changedLineCount <= 30 ? "small" : pr.changedLineCount <= 200 ? "medium" : "large";
  }
  if (pr.filePaths.length > 0) {
    return pr.filePaths.length <= 2 ? "small" : pr.filePaths.length <= 10 ? "medium" : "large";
  }
  return null;
}

function outcomeSignal(mergeRate: number): RepoOutcomeSignal {
  if (mergeRate >= REPO_OUTCOME_MERGE_WELL_RATE) return "merges_well";
  if (mergeRate <= REPO_OUTCOME_CLOSURE_RISK_RATE) return "high_closure_risk";
  return "mixed";
}

function describeDimension(dimension: RepoOutcomeDimensionKind, key: string): string {
  const safeKey = sanitizeOutcomeDimensionKey(key);
  switch (dimension) {
    case "path":
      return `PRs touching ${safeKey}`;
    case "label":
      return `PRs labeled "${safeKey}"`;
    case "size":
      return `${key} PRs`;
    case "linked_issue":
      return key === "linked" ? "PRs that link an issue" : "PRs with no linked issue";
    case "test_evidence":
      return key === "with_tests" ? "PRs that include test changes" : "PRs without test changes";
    case "review_churn":
      return key === "changes_requested" ? "PRs that received change requests" : "PRs with no change requests";
    case "author_role":
      return key === "returning_contributor" ? "PRs from returning contributors" : "PRs from first-time or external authors";
  }
}

function sanitizeOutcomeDimensionKey(key: string): string {
  return key
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/@(?=[A-Za-z0-9_-])/g, "@\u200B")
    .replace(/[\\`*_{}[\]()#+>|]/g, "\\$&")
    .replace(/\s+/g, " ")
    .trim();
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
  /* v8 ignore next -- Low collision rank is the default branch; high/medium sorting behavior is covered by collision tests. */
  if (risk === "medium") return 2;
  return 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
