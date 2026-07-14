// Local mirrors from src/types.ts, src/signals/engine.ts, and src/signals/focus-manifest.ts.
// Keep in sync by hand — the engine package cannot import across into src/.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RegistryRepoConfig = {
  repo: string;
  emissionShare: number;
  issueDiscoveryShare: number;
  labelMultipliers: Record<string, number>;
  trustedLabelPipeline?: boolean | null;
  maintainerCut: number;
  defaultLabelMultiplier?: number | null;
  fixedBaseScore?: number | null;
  eligibilityMode?: string | null;
  raw: Record<string, JsonValue>;
};

export type AdvisoryConclusion = "success" | "neutral" | "action_required";
export type AdvisorySeverity = "info" | "warning" | "critical";

export type AdvisoryFinding = {
  code: string;
  title: string;
  severity: AdvisorySeverity;
  detail: string;
  action?: string;
  publicText?: string;
  confidence?: number;
};

export type Advisory = {
  id: string;
  targetType: "repository" | "pull_request" | "issue";
  targetKey: string;
  repoFullName: string;
  pullNumber?: number;
  issueNumber?: number;
  headSha?: string;
  conclusion: AdvisoryConclusion;
  severity: AdvisorySeverity;
  title: string;
  summary: string;
  findings: AdvisoryFinding[];
  generatedAt: string;
};

export type RepositoryRecord = {
  fullName: string;
  owner: string;
  name: string;
  installationId?: number | null | undefined;
  isInstalled: boolean;
  isRegistered: boolean;
  isPrivate: boolean;
  htmlUrl?: string | null | undefined;
  defaultBranch?: string | null | undefined;
  registryConfig?: RegistryRepoConfig | null | undefined;
};

export type PullRequestRecord = {
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  authorLogin?: string | null | undefined;
  authorAssociation?: string | null | undefined;
  headSha?: string | null | undefined;
  headRef?: string | null | undefined;
  baseRef?: string | null | undefined;
  htmlUrl?: string | null | undefined;
  mergedAt?: string | null | undefined;
  isDraft?: boolean | null | undefined;
  mergeableState?: string | null | undefined;
  reviewDecision?: string | null | undefined;
  body?: string | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  closedAt?: string | null | undefined;
  linkedIssueClaimedAt?: string | null | undefined;
  labels: string[];
  linkedIssues: number[];
  slopRisk?: number | null | undefined;
  slopBand?: string | null | undefined;
  mergeAttemptCount?: number | null | undefined;
  mergeBlockedSha?: string | null | undefined;
  mergeBlockedReason?: string | null | undefined;
  approvedHeadSha?: string | null | undefined;
  lastRegatedAt?: string | null | undefined;
  lastPublishedSurfaceSha?: string | null | undefined;
  changedFiles?: string[] | undefined;
};

export type IssueRecord = {
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  authorLogin?: string | null | undefined;
  authorAssociation?: string | null | undefined;
  htmlUrl?: string | null | undefined;
  body?: string | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  closedAt?: string | null | undefined;
  labels: string[];
  linkedPrs: number[];
};

export type BountyRecord = {
  id: string;
  repoFullName: string;
  issueNumber: number;
  status: string;
  amountText?: string | null | undefined;
  sourceUrl?: string | null | undefined;
  payload: Record<string, JsonValue>;
  discoveredAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

export type GateRuleMode = "off" | "advisory" | "block";
export type GatePolicyPack = "gittensor" | "oss-anti-slop";

export type RepositorySettings = {
  repoFullName: string;
  hardGuardrailGlobs?: string[] | null | undefined;
  hardGuardrailGlobsOverridesInvariants?: boolean | null | undefined;
};

export type RecentMergedPullRequestRecord = {
  repoFullName: string;
  number: number;
  title: string;
  authorLogin?: string | null | undefined;
  htmlUrl?: string | null | undefined;
  labels: string[];
  linkedIssues: number[];
  changedFiles?: string[] | undefined;
};

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
  linkedIssueClaimedAt?: string | null | undefined;
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
    draftPullRequests: number;
    maintainerAuthoredPullRequests: number;
    collisionClusters: number;
    /** Open PRs with slop band elevated or high (public-safe flag count for trend snapshots). */
    slopFlaggedPullRequests: number;
    /** Open PRs in a high-risk duplicate cluster with 2+ pull requests (public-safe flag count). */
    duplicateFlaggedPullRequests: number;
    ageBuckets: {
      under7Days: number;
      days7To30: number;
      over30Days: number;
    };
    likelyReviewablePullRequests: number;
    cachedOpenPullRequests?: number | undefined;
    likelyReviewablePullRequestsSource?: "cache" | "sampled_cache" | "authoritative" | undefined;
  };
  findings: AdvisoryFinding[];
};

export type QueueSignalCounts = {
  openIssues?: number | undefined;
  openPullRequests?: number | undefined;
  likelyReviewablePullRequests?: number | undefined;
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

export type IssueQualityReport = {
  repoFullName: string;
  generatedAt: string;
  lane: LaneAdvice;
  issues: Array<{
    number: number;
    title: string;
    status: "ready" | "needs_proof" | "hold" | "do_not_use";
    score: number;
    reasons: string[];
    warnings: string[];
  }>;
  summary: string;
};

export type BountyLifecycle = "active" | "historical" | "completed" | "cancelled" | "stale" | "ambiguous" | "unknown";

export type FocusManifestSource = "repo_file" | "api_record" | "none";
export type FocusManifestLinkedIssuePolicy = "required" | "preferred" | "optional";
export type FocusManifestIssueDiscoveryPolicy = "encouraged" | "neutral" | "discouraged";
export type ReviewCheckMode = "required" | "visible" | "disabled";
export type CombineStrategy = "single" | "consensus" | "synthesis";
export type OnMerge = "either" | "both";

export type FocusManifestGateConfig = {
  present: boolean;
  enabled: boolean | null;
  checkMode: ReviewCheckMode | null;
  pack: GatePolicyPack | null;
  linkedIssue: GateRuleMode | null;
  duplicates: GateRuleMode | null;
  readinessMode: GateRuleMode | null;
  readinessMinScore: number | null;
  slopMode: GateRuleMode | null;
  slopMinScore: number | null;
  slopAiAdvisory: boolean | null;
  sizeMode: GateRuleMode | null;
  lockfileIntegrityMode: GateRuleMode | null;
  aiReviewMode: GateRuleMode | null;
  aiReviewByok: boolean | null;
  aiReviewProvider: "anthropic" | "openai" | null;
  aiReviewModel: string | null;
  aiReviewAllAuthors: boolean | null;
  aiReviewCloseConfidence: number | null;
  aiReviewCombine: CombineStrategy | null;
  aiReviewOnMerge: OnMerge | null;
  aiReviewReviewers: ReadonlyArray<{ model: string; fallback?: string | null | undefined }> | null;
  mergeReadiness: GateRuleMode | null;
  manifestPolicy: GateRuleMode | null;
  selfAuthoredLinkedIssue: GateRuleMode | null;
  dryRun: boolean | null;
  firstTimeContributorGrace: boolean | null;
  premergeContentRecheck: boolean | null;
  requireFreshRebaseWindowMinutes: number | null;
  claMode: GateRuleMode | null;
  claConsentPhrase: string | null;
  claCheckRunName: string | null;
  claCheckRunAppSlug: string | null;
  expectedCiContexts: ReadonlyArray<string> | null;
};

export type PreMergeCheck = {
  name: string;
  whenPaths: string[];
  titleContains: string | null;
  descriptionContains: string | null;
  requireLabel: string | null;
  enforce: boolean;
};

export type FocusManifestReviewConfig = {
  present: boolean;
  preMergeChecks: PreMergeCheck[];
};

export type FocusManifestSettings = {
  hardGuardrailGlobs?: string[] | null | undefined;
  hardGuardrailGlobsOverridesInvariants?: boolean | null | undefined;
};

export type FocusManifest = {
  present: boolean;
  source: FocusManifestSource;
  wantedPaths: string[];
  preferredLabels: string[];
  linkedIssuePolicy: FocusManifestLinkedIssuePolicy;
  testExpectations: string[];
  issueDiscoveryPolicy: FocusManifestIssueDiscoveryPolicy;
  maintainerNotes: string[];
  publicNotes: string[];
  gate: FocusManifestGateConfig;
  settings: FocusManifestSettings;
  review: FocusManifestReviewConfig;
  warnings: string[];
};

export type FocusManifestFinding = {
  code:
    | "manifest_off_focus"
    | "manifest_preferred_path"
    | "manifest_missing_preferred_label"
    | "manifest_linked_issue_required"
    | "manifest_linked_issue_preferred"
    | "manifest_missing_tests"
    | "manifest_issue_discovery_discouraged"
    | "manifest_malformed";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  action?: string | undefined;
};

export type FocusManifestGuidance = {
  present: boolean;
  source: FocusManifestSource;
  linkedIssuePolicy: FocusManifestLinkedIssuePolicy;
  issueDiscoveryPolicy: FocusManifestIssueDiscoveryPolicy;
  matchedWantedPaths: string[];
  preferredLabelHits: string[];
  findings: FocusManifestFinding[];
  publicNextSteps: string[];
  warnings: string[];
  summary: string;
};
