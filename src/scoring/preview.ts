import type { ContributorEvidenceRecord, JsonValue, RepositoryRecord, RepoTimeDecayOverrides, ScoringModelSnapshotRecord, ScorePreviewRecord } from "../types";
import { DEFAULT_SCORING_CONSTANTS } from "./model";
import { nowIso } from "../utils/json";

export type ScorePreviewInput = {
  repoFullName: string;
  targetType?: ScorePreviewRecord["targetType"];
  targetKey?: string | undefined;
  contributorLogin?: string | undefined;
  labels?: string[] | undefined;
  linkedIssueMode?: "none" | "standard" | "maintainer" | undefined;
  linkedIssueContext?: LinkedIssueMultiplierContext | undefined;
  sourceTokenScore?: number | undefined;
  totalTokenScore?: number | undefined;
  sourceLines?: number | undefined;
  testTokenScore?: number | undefined;
  nonCodeTokenScore?: number | undefined;
  /** Raw non-code line count before upstream's MAX_LINES_SCORED_FOR_NON_CODE_EXT cap. */
  nonCodeLines?: number | undefined;
  existingContributorTokenScore?: number | undefined;
  openPrCount?: number | undefined;
  /** Contributor's current open-issue count for the repo, used for the open-issue spam gate (#808). */
  openIssueCount?: number | undefined;
  /** Repo-level merged PR count for upstream contributor-history eligibility (#808). */
  mergedPullRequests?: number | undefined;
  /** Count of valid solved issues for upstream issue-discovery eligibility (#808). */
  validSolvedIssues?: number | undefined;
  /** Issue-discovery credibility for upstream issue-discovery eligibility (#808). */
  issueCredibility?: number | undefined;
  credibility?: number | undefined;
  changesRequestedCount?: number | undefined;
  fixedBaseScore?: number | undefined;
  metadataOnly?: boolean | undefined;
  pendingMergedPrCount?: number | undefined;
  pendingClosedPrCount?: number | undefined;
  approvedPrCount?: number | undefined;
  observedApprovedPrCount?: number | undefined;
  observedStalePrCount?: number | undefined;
  observedClosedPrCount?: number | undefined;
  observedDraftPrCount?: number | undefined;
  observedBlockedPrCount?: number | undefined;
  observedMaintainerPrCount?: number | undefined;
  duplicateRiskCount?: number | undefined;
  expectedOpenPrCountAfterMerge?: number | undefined;
  projectedCredibility?: number | undefined;
  scenarioNotes?: string[] | undefined;
  pendingScenarioObserved?: boolean | undefined;
  observedScenarioNotes?: string[] | undefined;
  branchEligibility?: BranchEligibilityInput | undefined;
  /** Hours since the PR merged, for upstream time-decay (#703). Absent / below the grace period = a fresh
   *  PR (multiplier 1.0). Only consulted when `applyTimeDecay` is on. */
  prAgeHours?: number | undefined;
  /** Opt-in upstream time-decay (#703), default OFF and env-gated (SCORING_TIME_DECAY_ENABLED) at the call
   *  site. Even when on, a fresh PR is unaffected, so it never changes a normal new-PR preview. */
  applyTimeDecay?: boolean | undefined;
};

export type BranchEligibilityInput = {
  status: "eligible" | "ineligible" | "unknown";
  source?: "github_metadata" | "local_metadata" | "registry" | "user_supplied" | undefined;
  reason?: string | undefined;
  checkedAt?: string | undefined;
  stale?: boolean | undefined;
};

export type BranchEligibilityResult = {
  required: boolean;
  status: "eligible" | "ineligible" | "unknown" | "not_required";
  evidence: "provided" | "missing";
  source: "github_metadata" | "local_metadata" | "registry" | "user_supplied" | "missing";
  reason?: string | undefined;
  checkedAt?: string | undefined;
  stale: boolean;
  warnings: string[];
};

export type LinkedIssueMultiplierStatus = "not_required" | "raw" | "plausible" | "validated" | "invalid" | "unavailable";

export type LinkedIssueMultiplierSource = "none" | "user_supplied" | "official_mirror" | "github_cache" | "issue_quality" | "missing";

export type LinkedIssueMultiplierContext = {
  status?: Exclude<LinkedIssueMultiplierStatus, "not_required"> | undefined;
  source?: Exclude<LinkedIssueMultiplierSource, "none"> | undefined;
  issueNumbers?: number[] | undefined;
  solvedByPullRequests?: number[] | undefined;
  reason?: string | undefined;
  warnings?: string[] | undefined;
};

const PROJECTED_SOLVED_BY_PULL_REQUEST_VALIDATION = Symbol("projectedSolvedByPullRequestValidation");

type ProjectedLinkedIssueMultiplierContext = LinkedIssueMultiplierContext & {
  [PROJECTED_SOLVED_BY_PULL_REQUEST_VALIDATION]?: true;
};

export type LinkedIssueMultiplierDecision = {
  mode: "none" | "standard" | "maintainer";
  status: LinkedIssueMultiplierStatus;
  source: LinkedIssueMultiplierSource;
  eligible: boolean;
  issueNumbers: number[];
  solvedByPullRequests: number[];
  baseMultiplier: number;
  appliedMultiplier: number;
  reason: string;
  warnings: string[];
};

export type ScoreGateBlocker = {
  code:
    | "repo_not_registered"
    | "inactive_allocation"
    | "base_token_gate"
    | "open_pr_threshold"
    | "open_issue_threshold"
    | "merged_pr_history_floor"
    | "issue_discovery_validity_floor"
    | "credibility_floor"
    | "review_penalty"
    | "metadata_only"
    | "linked_issue_invalid"
    | "linked_issue_unvalidated"
    | "branch_ineligible"
    | "branch_eligibility_missing"
    | "duplicate_risk"
    | "stale_work";
  severity: "blocker" | "reducer" | "context";
  detail: string;
};

export type ScoreGateDelta = {
  gate:
    | "open_pr_threshold"
    | "open_issue_threshold"
    | "merged_pr_history_floor"
    | "issue_discovery_validity_floor"
    | "credibility_floor"
    | "linked_issue_multiplier";
  current: string;
  projected: string;
  explanation: string;
};

export type ScoreScenarioPreview = {
  name: "current" | "cleanGates" | "afterPendingMerges" | "afterApprovedPrsMerge" | "afterStalePrsClose" | "linkedIssueFixed" | "bestReasonableCase";
  source: "current_data" | "user_supplied" | "github_observed" | "gittensory_projection";
  assumptions: string[];
  scoreEstimate: ScorePreviewResult["scoreEstimate"];
  gates: ScorePreviewResult["gates"];
  effectiveEstimatedScore: number;
  underlyingPotentialScore: number;
  blockedBy: ScoreGateBlocker[];
  linkedIssueMultiplier: LinkedIssueMultiplierDecision;
  deltaExplanation: string;
};

export type ScorePreviewResult = {
  repoFullName: string;
  generatedAt: string;
  scoringModelSnapshotId: string;
  activeModel: ScoringModelSnapshotRecord["activeModel"];
  privateOnly: true;
  laneMath: {
    repoEmissionShare: number;
    ossEmissionShare: number;
    repoSlice: number;
    directPrSlice: number;
    issueDiscoverySlice: number;
    issueDiscoveryShare: number;
  };
  scoreEstimate: {
    baseScore: number;
    densityMultiplier: number;
    contributionBonus: number;
    labelMultiplier: number;
    issueMultiplier: number;
    credibilityMultiplier: number;
    reviewPenaltyMultiplier: number;
    openPrMultiplier: number;
    openIssueMultiplier: number;
    /** Upstream merged-PR history floor (#808). 0 when below MIN_VALID_MERGED_PRS; 1 when unknown or eligible. */
    mergedHistoryMultiplier: number;
    /** Upstream issue-discovery validity floor (#808). 0 when below MIN_VALID_SOLVED_ISSUES or MIN_ISSUE_CREDIBILITY. */
    issueDiscoveryHistoryMultiplier: number;
    /** Upstream sigmoid time-decay multiplier (#703). 1 = no decay (fresh PR, or feature off). */
    timeDecayMultiplier: number;
    estimatedMergedScore: number;
    pendingSaturationScore: number;
  };
  linkedIssueMultiplier: LinkedIssueMultiplierDecision;
  gates: {
    baseTokenGatePassed: boolean;
    openPrThreshold: number;
    openPrCount: number;
    /** Effective open-PR collateral fraction (OPEN_PR_COLLATERAL_PERCENT × reviewCollateralMultiplier). */
    collateralFraction: number;
    /** Upstream open-PR review-collateral multiplier from CHANGES_REQUESTED reviews (≥ 1, capped). */
    reviewCollateralMultiplier: number;
    credibilityFloor: number;
    credibilityObserved: number;
    openIssueThreshold: number;
    openIssueCount: number;
    mergedPrFloor: number;
    /** Observed merged PR count when supplied or inferred from contributor evidence; absent when unknown. */
    mergedPullRequests?: number | undefined;
    validSolvedIssuesFloor: number;
    /** Observed valid solved-issue count when supplied; absent when unknown. */
    validSolvedIssues?: number | undefined;
    issueCredibilityFloor: number;
    /** Observed issue-discovery credibility when supplied; absent when unknown. */
    issueCredibility?: number | undefined;
    /** Upstream non-code line scoring cap (MAX_LINES_SCORED_FOR_NON_CODE_EXT); non-code token score beyond this
     *  many changed non-code lines is not scored. */
    nonCodeLineCap: number;
    /** Observed raw non-code line count before the cap; absent when no non-code line count was supplied. */
    nonCodeLinesObserved?: number | undefined;
  };
  branchEligibility: BranchEligibilityResult;
  effectiveEstimatedScore: number;
  underlyingPotentialScore: number;
  blockedBy: ScoreGateBlocker[];
  gateDeltas: ScoreGateDelta[];
  scenarioPreviews: ScoreScenarioPreview[];
  scoreabilityStatus: "blocked" | "conditionally_scoreable" | "scoreable" | "hold";
  warnings: string[];
  assumptions: string[];
  recommendation: {
    level: "strong_fit" | "reasonable_fit" | "needs_work" | "hold";
    actions: string[];
  };
};

export function buildScorePreview(args: {
  input: ScorePreviewInput;
  repo: RepositoryRecord | null;
  snapshot: ScoringModelSnapshotRecord;
  contributorEvidence?: ContributorEvidenceRecord | null | undefined;
}): ScorePreviewResult {
  const branchEligibility = normalizeBranchEligibility(args.input);
  const current = computeScoreCore(args.input, args.repo, args.snapshot, args.contributorEvidence);
  const scenarioPreviews = buildScenarioPreviews(args.input, args.repo, args.snapshot, args.contributorEvidence, current);
  const blockedBy = blockedByFor(args.input, args.repo, current, branchEligibility);
  const gateDeltas = buildGateDeltas(current, scenarioPreviews);
  const effectiveEstimatedScore = current.scoreEstimate.estimatedMergedScore;
  const underlyingPotentialScore = current.scoreEstimate.pendingSaturationScore;
  const scoreabilityStatus = statusFor(args.repo, blockedBy, effectiveEstimatedScore, scenarioPreviews);
  const warnings = [...args.snapshot.warnings, ...warningsFor(args.input, args.repo, current, branchEligibility)];
  const actions = [
    ...(!current.gates.baseTokenGatePassed ? ["Increase meaningful source change size or scope clarity before relying on this preview."] : []),
    ...(current.scoreEstimate.openPrMultiplier === 0 ? ["Land or close existing open PRs before opening more concurrent work."] : []),
    ...(current.scoreEstimate.openIssueMultiplier === 0 ? ["Close excess open issues to stay within the open-issue spam threshold."] : []),
    ...(current.scoreEstimate.mergedHistoryMultiplier === 0 ? ["Build merged PR history on this repo before relying on this preview; upstream requires a minimum merged count."] : []),
    ...(current.scoreEstimate.issueDiscoveryHistoryMultiplier === 0
      ? ["Build valid solved-issue history and issue credibility before relying on issue-discovery scoring on this repo."]
      : []),
    ...(current.scoreEstimate.credibilityMultiplier < 1 ? ["Build or wait for contributor credibility evidence before relying on this preview."] : []),
    ...(current.scoreEstimate.reviewPenaltyMultiplier < 1 ? ["Reduce review churn with tighter tests and clearer evidence."] : []),
    ...(current.scoreEstimate.labelMultiplier <= 1 && Object.keys(args.repo?.registryConfig?.labelMultipliers ?? {}).length > 0
      ? ["Check whether the change legitimately matches one of the repo's configured trusted labels."]
      : []),
    ...(branchEligibility.required && branchEligibility.status === "ineligible" ? ["Use an eligible branch or remove linked-issue assumptions before relying on this preview."] : []),
    ...(branchEligibility.required && (branchEligibility.evidence === "missing" || branchEligibility.stale)
      ? ["Refresh branch/base eligibility metadata before relying on linked-issue assumptions."]
      : []),
    ...(current.linkedIssueMultiplier.mode === "standard" && !current.linkedIssueMultiplier.eligible
      ? ["Validate linked issue context with solved-by-PR evidence before relying on the standard issue multiplier."]
      : []),
  ];

  return {
    repoFullName: args.input.repoFullName,
    generatedAt: nowIso(),
    scoringModelSnapshotId: args.snapshot.id,
    activeModel: args.snapshot.activeModel,
    privateOnly: true,
    laneMath: current.laneMath,
    scoreEstimate: current.scoreEstimate,
    linkedIssueMultiplier: current.linkedIssueMultiplier,
    gates: current.gates,
    branchEligibility,
    effectiveEstimatedScore,
    underlyingPotentialScore,
    blockedBy,
    gateDeltas,
    scenarioPreviews,
    scoreabilityStatus,
    warnings,
    assumptions: [
      "Advisory preview only; tied to the recorded scoring model snapshot and cached Gittensory data.",
      "No future outcome or exact payout is guaranteed.",
      "Private API/MCP output only; public comments intentionally omit these details.",
      `Linked issue multiplier status: ${current.linkedIssueMultiplier.status}; ${current.linkedIssueMultiplier.reason}`,
      ...branchEligibility.warnings,
      ...(args.input.scenarioNotes ?? []).map((note) => `User scenario note: ${note}`),
    ],
    recommendation: {
      level: scoreabilityStatus === "hold" || warnings.some((warning) => /not registered|no active|exceeds/i.test(warning))
        ? "hold"
        : effectiveEstimatedScore >= 30 && warnings.length === 0
          ? "strong_fit"
          : effectiveEstimatedScore >= 15
            ? "reasonable_fit"
            : "needs_work",
      actions: actions.length > 0 ? actions : ["Keep the PR focused, linked, tested, and easy for maintainers to review."],
    },
  };
}

export function makeScorePreviewRecord(input: ScorePreviewInput, snapshot: ScoringModelSnapshotRecord, result: ScorePreviewResult): ScorePreviewRecord {
  return {
    id: crypto.randomUUID(),
    scoringModelSnapshotId: snapshot.id,
    repoFullName: input.repoFullName,
    targetType: input.targetType ?? "planned_pr",
    targetKey: input.targetKey ?? `${input.repoFullName}:${input.targetType ?? "planned_pr"}:${Date.now()}`,
    contributorLogin: input.contributorLogin,
    input: input as unknown as Record<string, JsonValue>,
    result: result as unknown as Record<string, JsonValue>,
    generatedAt: result.generatedAt,
  };
}

type ScoreCore = Pick<ScorePreviewResult, "laneMath" | "scoreEstimate" | "gates" | "linkedIssueMultiplier">;

function computeScoreCore(
  input: ScorePreviewInput,
  repo: RepositoryRecord | null,
  snapshot: ScoringModelSnapshotRecord,
  contributorEvidence?: ContributorEvidenceRecord | null | undefined,
): ScoreCore {
  const constants = { ...snapshot.constants };
  const config = repo?.registryConfig;
  const emissionShare = clamp(config?.emissionShare ?? 0, 0, 1);
  const issueDiscoveryShare = clamp(config?.issueDiscoveryShare ?? 0, 0, 1);
  const ossEmissionShare = constant(constants, "OSS_EMISSION_SHARE");
  const repoSlice = emissionShare * ossEmissionShare;
  const directPrSlice = repoSlice * (1 - issueDiscoveryShare);
  const issueDiscoverySlice = repoSlice * issueDiscoveryShare;
  const sourceTokenScore = nonNegative(input.sourceTokenScore);
  // TEST_FILE_CONTRIBUTION_WEIGHT (#808): upstream weights test-file tokens at 0.05× relative to source tokens.
  // Applied only when totalTokenScore is not explicitly provided — an explicit caller total is honoured as-is.
  const testFileWeight = constant(constants, "TEST_FILE_CONTRIBUTION_WEIGHT");
  const cappedNonCodeTokenScore = applyNonCodeLineCap(input, constants);
  const derivedTotalTokenScore = sourceTokenScore + testFileWeight * nonNegative(input.testTokenScore) + cappedNonCodeTokenScore;
  const totalTokenScore =
    input.totalTokenScore === undefined ? nonNegative(derivedTotalTokenScore) : applyNonCodeCapToTotal(input.totalTokenScore, input, cappedNonCodeTokenScore);
  const sourceLines = Math.max(1, nonNegative(input.sourceLines ?? sourceTokenScore));
  const fixedBaseScore = clampFixedBaseScore(input.fixedBaseScore ?? config?.fixedBaseScore);
  const rawDensity = sourceTokenScore / sourceLines;
  // Density branch (#812): upstream is on the saturation model, but `current_density_model` is still a
  // supported `activeModel` (types.ts union, the public OpenAPI schema, the DB parser, ~20 test fixtures, and
  // src/services/score-breakdown.ts which keys off densityMultiplier). The issue's "if density is dead,
  // remove the branch" condition is therefore FALSE — the branch is retained as the supported alternate /
  // fetch-failure-`unknown` fallback model. Its fallback constants are now single-sourced from
  // DEFAULT_SCORING_CONSTANTS (model.ts) instead of silent duplicated literals, closing the drift surface.
  const densityMultiplier = clamp(rawDensity || 0, 0, constant(constants, "MAX_CODE_DENSITY_MULTIPLIER"));
  const densityTokenGatePassed = sourceTokenScore >= constant(constants, "MIN_TOKEN_SCORE_FOR_BASE_SCORE");
  const baseTokenGatePassed = snapshot.activeModel === "pending_saturation_model" ? sourceTokenScore > 0 : densityTokenGatePassed;
  const densityContributionBonus = contributionBonusRamp(totalTokenScore, constants);
  const saturationContributionBonusValue = saturationContributionBonus(totalTokenScore, constants);
  const saturationBaseScore = saturationScore(sourceTokenScore, totalTokenScore, constants);
  const densityBaseScore =
    (densityTokenGatePassed ? constant(constants, "MERGED_PR_BASE_SCORE") * densityMultiplier : 0) + densityContributionBonus;
  const baseScore =
    fixedBaseScore !== undefined
      ? fixedBaseScore
      : snapshot.activeModel === "pending_saturation_model"
        ? saturationBaseScore
        : densityBaseScore;
  const activeContributionBonus = snapshot.activeModel === "pending_saturation_model" ? saturationContributionBonusValue : densityContributionBonus;
  const labelMultiplier = selectLabelMultiplier(input.labels ?? [], config?.labelMultipliers ?? {}, config?.defaultLabelMultiplier ?? 1);
  const branchEligibility = normalizeBranchEligibility(input);
  const linkedIssueMultiplier = decideLinkedIssueMultiplier(input.linkedIssueMode ?? "none", input.linkedIssueContext, constants, branchEligibility);
  const issueMultiplier = linkedIssueMultiplier.appliedMultiplier;
  const credibilityObserved = clamp(input.credibility ?? inferCredibility(contributorEvidence), 0, 1);
  const credibilityFloor = constant(constants, "MIN_CREDIBILITY");
  const credibilityMultiplier = credibilityObserved >= credibilityFloor ? 1 : credibilityObserved / credibilityFloor;
  const changesRequestedCount = nonNegative(input.changesRequestedCount);
  const reviewPenaltyRate = constant(constants, "REVIEW_PENALTY_RATE");
  const reviewPenaltyMultiplier = clamp(1 - changesRequestedCount * reviewPenaltyRate, 0, 1);
  const reviewCollateralMultiplier = Math.min(
    constant(constants, "MAX_OPEN_PR_REVIEW_COLLATERAL_MULTIPLIER"),
    1 + changesRequestedCount * reviewPenaltyRate,
  );
  const openPrCollateralPercent = constant(constants, "OPEN_PR_COLLATERAL_PERCENT");
  const openPrCount = nonNegative(input.openPrCount);
  // The concurrency allowance is earned from the contributor's established merged-history token
  // score; the planned PR's own tokens (totalTokenScore) must not inflate its own open-PR threshold.
  const openPrThreshold = Math.min(
    constant(constants, "MAX_OPEN_PR_THRESHOLD"),
    constant(constants, "EXCESSIVE_PR_PENALTY_BASE_THRESHOLD") +
      Math.floor(nonNegative(input.existingContributorTokenScore) / constant(constants, "OPEN_PR_THRESHOLD_TOKEN_SCORE")),
  );
  const openPrMultiplier = openPrCount <= openPrThreshold ? 1 : 0;
  // Open-issue spam gate (#808): mirrors the open-PR gate for the issue-discovery channel.
  // A contributor earns extra open-issue slots from their existing merged-history token score.
  const openIssueCount = nonNegative(input.openIssueCount);
  const openIssueThreshold = Math.min(
    constant(constants, "MAX_OPEN_ISSUE_THRESHOLD"),
    constant(constants, "OPEN_ISSUE_SPAM_BASE_THRESHOLD") +
      Math.floor(nonNegative(input.existingContributorTokenScore) / constant(constants, "OPEN_ISSUE_SPAM_TOKEN_SCORE_PER_SLOT")),
  );
  const openIssueMultiplier = openIssueCount <= openIssueThreshold ? 1 : 0;
  const mergedPrFloor = constant(constants, "MIN_VALID_MERGED_PRS");
  const mergedPullRequestsObserved = resolveMergedPullRequests(input, contributorEvidence);
  const mergedHistoryMultiplier =
    mergedPullRequestsObserved === undefined ? 1 : mergedPullRequestsObserved >= mergedPrFloor ? 1 : 0;
  const validSolvedIssuesFloor = constant(constants, "MIN_VALID_SOLVED_ISSUES");
  const issueCredibilityFloor = constant(constants, "MIN_ISSUE_CREDIBILITY");
  const validSolvedIssuesObserved = input.validSolvedIssues !== undefined ? nonNegative(input.validSolvedIssues) : undefined;
  const issueCredibilityObserved = input.issueCredibility !== undefined ? clamp(input.issueCredibility, 0, 1) : undefined;
  // Issue-discovery validity mirrors upstream's separate issue lane — only gate previews that
  // actually claim linked-issue / issue-discovery scoring, not every repo with a non-zero share.
  const issueDiscoveryRelevant = (input.linkedIssueMode ?? "none") !== "none";
  const issueDiscoveryHistoryKnown = validSolvedIssuesObserved !== undefined && issueCredibilityObserved !== undefined;
  const issueDiscoveryHistoryMultiplier =
    !issueDiscoveryRelevant || !issueDiscoveryHistoryKnown
      ? 1
      : validSolvedIssuesObserved >= validSolvedIssuesFloor && issueCredibilityObserved >= issueCredibilityFloor
        ? 1
        : 0;
  // Upstream time-decay (#703): mirrors upstream's `scored.time_decay_multiplier` applied to a PR's score.
  // Opt-in + env-gated (default off). A fresh PR (prAgeHours below the grace period) yields 1.0, so a normal
  // new-PR preview is unchanged even when enabled — only an aged-PR projection decays.
  // Per-repo curve (#703): the repo's registry `scoring.time_decay` overrides overlay the snapshot defaults.
  const timeDecayMultiplier = input.applyTimeDecay ? calculateTimeDecay(nonNegative(input.prAgeHours), constants, config?.timeDecay) : 1;
  const estimatedMergedScore = roundScore(
    baseScore *
      labelMultiplier *
      issueMultiplier *
      credibilityMultiplier *
      reviewPenaltyMultiplier *
      openPrMultiplier *
      openIssueMultiplier *
      mergedHistoryMultiplier *
      issueDiscoveryHistoryMultiplier *
      timeDecayMultiplier,
  );
  const pendingSaturationScore = roundScore(saturationBaseScore);
  return {
    laneMath: {
      repoEmissionShare: emissionShare,
      ossEmissionShare,
      repoSlice: roundScore(repoSlice),
      directPrSlice: roundScore(directPrSlice),
      issueDiscoverySlice: roundScore(issueDiscoverySlice),
      issueDiscoveryShare,
    },
    scoreEstimate: {
      baseScore: roundScore(baseScore),
      densityMultiplier: roundScore(densityMultiplier),
      contributionBonus: roundScore(activeContributionBonus),
      labelMultiplier,
      issueMultiplier,
      credibilityMultiplier: roundScore(credibilityMultiplier),
      reviewPenaltyMultiplier: roundScore(reviewPenaltyMultiplier),
      openPrMultiplier,
      openIssueMultiplier,
      mergedHistoryMultiplier,
      issueDiscoveryHistoryMultiplier,
      timeDecayMultiplier: roundScore(timeDecayMultiplier),
      estimatedMergedScore,
      pendingSaturationScore,
    },
    linkedIssueMultiplier,
    gates: {
      baseTokenGatePassed,
      openPrThreshold,
      openPrCount,
      reviewCollateralMultiplier: roundScore(reviewCollateralMultiplier),
      collateralFraction: roundScore(openPrCollateralPercent * reviewCollateralMultiplier),
      credibilityFloor,
      credibilityObserved,
      openIssueThreshold,
      openIssueCount,
      mergedPrFloor,
      ...(mergedPullRequestsObserved !== undefined ? { mergedPullRequests: mergedPullRequestsObserved } : {}),
      validSolvedIssuesFloor,
      ...(validSolvedIssuesObserved !== undefined ? { validSolvedIssues: validSolvedIssuesObserved } : {}),
      issueCredibilityFloor,
      ...(issueCredibilityObserved !== undefined ? { issueCredibility: issueCredibilityObserved } : {}),
      nonCodeLineCap: constant(constants, "MAX_LINES_SCORED_FOR_NON_CODE_EXT"),
      ...(input.nonCodeLines !== undefined ? { nonCodeLinesObserved: nonNegative(input.nonCodeLines) } : {}),
    },
  };
}

function buildScenarioPreviews(
  input: ScorePreviewInput,
  repo: RepositoryRecord | null,
  snapshot: ScoringModelSnapshotRecord,
  contributorEvidence: ContributorEvidenceRecord | null | undefined,
  current: ScoreCore,
): ScoreScenarioPreview[] {
  // Count each pending open PR at most once. `approvedPrCount` and
  // `pendingMergedPrCount` are the same merge-ready set — detectPendingPrScenario
  // sets both to `mergeReady.length` — so they must be folded with `max`, not
  // added, or the merge-ready PRs get double-subtracted from the open-PR
  // projection. Closed/likely-close PRs are a disjoint set and add on top. This
  // mirrors the canonical reduction in pending-pr-scenarios.ts
  // (currentOpen - pendingMergedPrCount - pendingClosedPrCount).
  const mergeReadyPending = Math.max(nonNegative(input.pendingMergedPrCount), nonNegative(input.approvedPrCount));
  const userPendingCount = mergeReadyPending + nonNegative(input.pendingClosedPrCount);
  const observedApprovedCount = nonNegative(input.observedApprovedPrCount);
  const observedStaleCloseCount = nonNegative(input.observedStalePrCount);
  const observedClosedCount = nonNegative(input.observedClosedPrCount);
  const combinedPendingCount = userPendingCount + observedApprovedCount + observedStaleCloseCount;
  const expectedOpenPrCountAfterMerge =
    input.expectedOpenPrCountAfterMerge !== undefined ? nonNegative(input.expectedOpenPrCountAfterMerge) : Math.max(0, current.gates.openPrCount - userPendingCount);
  const projectedCredibility =
    input.projectedCredibility !== undefined
      ? clamp(input.projectedCredibility, 0, 1)
      : userPendingCount > 0
        ? Math.max(current.gates.credibilityObserved, current.gates.credibilityFloor)
        : current.gates.credibilityObserved;
  const observedApprovalCredibility = observedApprovedCount > 0 ? Math.max(current.gates.credibilityObserved, current.gates.credibilityFloor) : current.gates.credibilityObserved;
  const afterApprovedInput = {
    ...input,
    openPrCount: Math.max(0, current.gates.openPrCount - observedApprovedCount),
    credibility: observedApprovalCredibility,
  };
  const afterStaleInput = {
    ...input,
    openPrCount: Math.max(0, current.gates.openPrCount - observedStaleCloseCount),
    credibility: current.gates.credibilityObserved,
  };
  const cleanGatesInput = {
    ...input,
    openPrCount: Math.min(current.gates.openPrCount, current.gates.openPrThreshold),
    openIssueCount: Math.min(current.gates.openIssueCount, current.gates.openIssueThreshold),
    credibility: Math.max(current.gates.credibilityObserved, current.gates.credibilityFloor),
    ...(current.gates.mergedPullRequests !== undefined
      ? { mergedPullRequests: Math.max(current.gates.mergedPullRequests, current.gates.mergedPrFloor) }
      : {}),
    ...(current.gates.validSolvedIssues !== undefined
      ? { validSolvedIssues: Math.max(current.gates.validSolvedIssues, current.gates.validSolvedIssuesFloor) }
      : {}),
    ...(current.gates.issueCredibility !== undefined
      ? { issueCredibility: Math.max(current.gates.issueCredibility, current.gates.issueCredibilityFloor) }
      : {}),
  };
  const afterPendingInput = {
    ...input,
    openPrCount: expectedOpenPrCountAfterMerge,
    credibility: projectedCredibility,
    ...(current.gates.mergedPullRequests !== undefined
      ? { mergedPullRequests: nonNegative(current.gates.mergedPullRequests) + mergeReadyPending }
      : {}),
  };
  const linkedIssueInput = withValidatedLinkedIssueScenario(input);
  const bestReasonableInput = {
    ...linkedIssueInput,
    openPrCount: Math.min(
      input.expectedOpenPrCountAfterMerge !== undefined ? expectedOpenPrCountAfterMerge : Math.max(0, current.gates.openPrCount - combinedPendingCount),
      current.gates.openPrThreshold,
    ),
    // Project open-issue spam cleanup (#808): mirror the open-PR projection so the
    // "best reasonable case" can clear the open-issue gate just like it clears open-PR pressure.
    openIssueCount: Math.min(current.gates.openIssueCount, current.gates.openIssueThreshold),
    credibility: Math.max(projectedCredibility, observedApprovalCredibility, current.gates.credibilityFloor),
    ...(current.gates.mergedPullRequests !== undefined
      ? {
          mergedPullRequests: Math.max(
            nonNegative(current.gates.mergedPullRequests) + mergeReadyPending,
            current.gates.mergedPrFloor,
          ),
        }
      : {}),
    ...(current.gates.validSolvedIssues !== undefined
      ? { validSolvedIssues: Math.max(current.gates.validSolvedIssues, current.gates.validSolvedIssuesFloor) }
      : {}),
    ...(current.gates.issueCredibility !== undefined
      ? { issueCredibility: Math.max(current.gates.issueCredibility, current.gates.issueCredibilityFloor) }
      : {}),
  };
  return [
    scenario("current", "current_data", input, current, ["Current cached/account state and supplied local diff metadata."], repo),
    scenario("cleanGates", "gittensory_projection", cleanGatesInput, computeScoreCore(cleanGatesInput, repo, snapshot, contributorEvidence), [
      "Open PR, open-issue, credibility, and contributor-history gates are projected as cleared; branch metadata is otherwise unchanged.",
    ], repo),
    scenario(
      "afterPendingMerges",
      input.pendingScenarioObserved
        ? "github_observed"
        : userPendingCount > 0 || input.expectedOpenPrCountAfterMerge !== undefined || input.projectedCredibility !== undefined
          ? "user_supplied"
          : "gittensory_projection",
      afterPendingInput,
      computeScoreCore(afterPendingInput, repo, snapshot, contributorEvidence),
      [
        userPendingCount > 0
          ? `${userPendingCount} pending merged/closed PR(s) are treated as no longer open for this scenario${input.pendingScenarioObserved ? "" : " (caller-supplied)"}.`
          : "No pending merge/close count was supplied; this scenario preserves current open PR pressure.",
        ...(input.projectedCredibility !== undefined
          ? [`Projected credibility is user-supplied as ${roundScore(projectedCredibility)}.`]
          : userPendingCount > 0
            ? [`Projected credibility is raised to the current floor ${current.gates.credibilityFloor} because pending merges are expected to land.`]
            : []),
        ...(input.scenarioNotes ?? []),
      ],
      repo,
    ),
    scenario(
      "afterApprovedPrsMerge",
      "github_observed",
      afterApprovedInput,
      computeScoreCore(afterApprovedInput, repo, snapshot, contributorEvidence),
      [
        observedApprovedCount > 0
          ? `${observedApprovedCount} GitHub-observed approved or mergeable open PR(s) are treated as no longer open if they merge.`
          : "No GitHub-observed approved or mergeable open PRs were available for this scenario.",
        ...(observedApprovedCount > 0 ? [`Projected credibility is raised to the current floor ${current.gates.credibilityFloor} after observed mergeable work lands.`] : []),
        ...observedScenarioNotes(input),
      ],
      repo,
    ),
    scenario(
      "afterStalePrsClose",
      "github_observed",
      afterStaleInput,
      computeScoreCore(afterStaleInput, repo, snapshot, contributorEvidence),
      [
        observedStaleCloseCount > 0
          ? `${observedStaleCloseCount} GitHub-observed stale open PR(s) are treated as no longer open if they close or withdraw.`
          : "No GitHub-observed stale open PRs were available for this scenario.",
        ...(observedClosedCount > 0 ? [`${observedClosedCount} GitHub-observed already-closed PR(s) are excluded because they no longer contribute to open PR pressure.`] : []),
        "Credibility is not increased in this scenario because stale cleanup is not the same as merged work.",
        ...observedScenarioNotes(input),
      ],
      repo,
    ),
    scenario("linkedIssueFixed", "gittensory_projection", linkedIssueInput, computeScoreCore(linkedIssueInput, repo, snapshot, contributorEvidence), [
      input.linkedIssueMode === "none" || !input.linkedIssueMode
        ? "A standard linked-issue/no-issue rationale multiplier is projected as solved-by-PR validated."
        : "Linked issue mode was already supplied; this scenario projects solved-by-PR validation where needed.",
    ], repo),
    scenario("bestReasonableCase", "gittensory_projection", bestReasonableInput, computeScoreCore(bestReasonableInput, repo, snapshot, contributorEvidence), [
      "Combines plausible near-term gate cleanup: open PR pressure at threshold or below, open-issue spam pressure at threshold or below, credibility at floor or above, contributor merged-history and issue-discovery validity at floor or above, and linked-issue context where applicable.",
      ...(input.scenarioNotes ?? []),
      ...observedScenarioNotes(input),
    ], repo),
  ];
}

function observedScenarioNotes(input: ScorePreviewInput): string[] {
  return [
    ...(nonNegative(input.observedDraftPrCount) > 0 ? [`${nonNegative(input.observedDraftPrCount)} draft PR(s) were excluded from likely-to-land projections.`] : []),
    ...(nonNegative(input.observedBlockedPrCount) > 0 ? [`${nonNegative(input.observedBlockedPrCount)} blocked PR(s) were excluded from likely-to-land projections.`] : []),
    ...(nonNegative(input.observedMaintainerPrCount) > 0 ? [`${nonNegative(input.observedMaintainerPrCount)} maintainer-lane PR(s) were kept out of outside-contributor projections.`] : []),
    ...(input.observedScenarioNotes ?? []),
  ];
}

function scenario(
  name: ScoreScenarioPreview["name"],
  source: ScoreScenarioPreview["source"],
  input: ScorePreviewInput,
  core: ScoreCore,
  assumptions: string[],
  repo: RepositoryRecord | null,
): ScoreScenarioPreview {
  const blockedBy = blockedByFor(input, repo, core);
  return {
    name,
    source,
    assumptions,
    scoreEstimate: core.scoreEstimate,
    linkedIssueMultiplier: core.linkedIssueMultiplier,
    gates: core.gates,
    effectiveEstimatedScore: core.scoreEstimate.estimatedMergedScore,
    underlyingPotentialScore: core.scoreEstimate.pendingSaturationScore,
    blockedBy,
    deltaExplanation: deltaExplanationFor(core, blockedBy),
  };
}

function blockedByFor(input: ScorePreviewInput, repo: RepositoryRecord | null, core: ScoreCore, branchEligibility = normalizeBranchEligibility(input)): ScoreGateBlocker[] {
  return [
    ...(!repo?.isRegistered
      ? [{ code: "repo_not_registered" as const, severity: "blocker" as const, detail: "Repository is not registered in the local Gittensory cache." }]
      : []),
    ...(core.laneMath.repoEmissionShare <= 0
      ? [{ code: "inactive_allocation" as const, severity: "blocker" as const, detail: "Repository has no active allocation in the current registry snapshot." }]
      : []),
    ...(input.metadataOnly
      ? [{ code: "metadata_only" as const, severity: "context" as const, detail: "Preview used metadata-only inputs, so token and density estimates are rough." }]
      : []),
    ...(branchEligibility.required && branchEligibility.status === "ineligible"
      ? [
          {
            code: "branch_ineligible" as const,
            severity: "reducer" as const,
            detail: "Branch eligibility is confirmed ineligible; linked-issue multiplier assumptions are disabled.",
          },
        ]
      : []),
    ...(branchEligibility.required && branchEligibility.status === "unknown"
      ? [
          {
            code: "branch_eligibility_missing" as const,
            severity: "context" as const,
            detail:
              branchEligibility.evidence === "missing"
                ? "Branch eligibility evidence is missing; refresh branch/base metadata before relying on linked-issue assumptions."
                : "Branch eligibility is unknown; refresh branch/base metadata before relying on linked-issue assumptions.",
          },
        ]
      : []),
    ...(!core.gates.baseTokenGatePassed
      ? [{ code: "base_token_gate" as const, severity: "blocker" as const, detail: "Source token score does not pass the current base-score token gate." }]
      : []),
    ...(core.scoreEstimate.openPrMultiplier === 0
      ? [
          {
            code: "open_pr_threshold" as const,
            severity: "blocker" as const,
            detail: `Open PR count ${core.gates.openPrCount} exceeds threshold ${core.gates.openPrThreshold}.`,
          },
        ]
      : []),
    ...(core.scoreEstimate.openIssueMultiplier === 0
      ? [
          {
            code: "open_issue_threshold" as const,
            severity: "blocker" as const,
            detail: `Open issue count ${core.gates.openIssueCount} exceeds spam threshold ${core.gates.openIssueThreshold}.`,
          },
        ]
      : []),
    ...(core.scoreEstimate.mergedHistoryMultiplier === 0
      ? [
          {
            code: "merged_pr_history_floor" as const,
            severity: "blocker" as const,
            detail: `Merged PR count ${core.gates.mergedPullRequests} is below upstream floor ${core.gates.mergedPrFloor}.`,
          },
        ]
      : []),
    ...(core.scoreEstimate.issueDiscoveryHistoryMultiplier === 0
      ? [
          {
            code: "issue_discovery_validity_floor" as const,
            severity: "blocker" as const,
            detail: `Issue-discovery history (${core.gates.validSolvedIssues} valid solved, credibility ${roundScore(core.gates.issueCredibility!)}) is below upstream floors (${core.gates.validSolvedIssuesFloor} valid solved, ${core.gates.issueCredibilityFloor} credibility).`,
          },
        ]
      : []),
    ...(core.gates.credibilityObserved < core.gates.credibilityFloor
      ? [
          {
            code: "credibility_floor" as const,
            severity: "reducer" as const,
            detail: `Credibility ${roundScore(core.gates.credibilityObserved)} is below floor ${core.gates.credibilityFloor}.`,
          },
        ]
      : []),
    ...(core.scoreEstimate.reviewPenaltyMultiplier < 1
      ? [{ code: "review_penalty" as const, severity: "reducer" as const, detail: "Change-request history reduces the estimate." }]
      : []),
    ...(core.linkedIssueMultiplier.mode === "standard" && core.linkedIssueMultiplier.status === "invalid"
      ? [
          {
            code: "linked_issue_invalid" as const,
            severity: "reducer" as const,
            detail: core.linkedIssueMultiplier.reason,
          },
        ]
      : []),
    ...(core.linkedIssueMultiplier.mode === "standard" && ["raw", "plausible", "unavailable"].includes(core.linkedIssueMultiplier.status)
      ? [
          {
            code: "linked_issue_unvalidated" as const,
            severity: "context" as const,
            detail: core.linkedIssueMultiplier.reason,
          },
        ]
      : []),
    ...(nonNegative(input.observedStalePrCount) > 0
      ? [
          {
            code: "stale_work" as const,
            severity: "reducer" as const,
            detail: `${nonNegative(input.observedStalePrCount)} stale open PR(s) detected; consider closing stale work before opening new contributions.`,
          },
        ]
      : []),
    ...(nonNegative(input.duplicateRiskCount) > 0
      ? [
          {
            code: "duplicate_risk" as const,
            severity: "reducer" as const,
            detail: `${nonNegative(input.duplicateRiskCount)} duplicate-risk issue(s) or PR(s) detected; verify there is no conflicting work before proceeding.`,
          },
        ]
      : []),
  ];
}

function buildGateDeltas(current: ScoreCore, scenarios: ScoreScenarioPreview[]): ScoreGateDelta[] {
  const currentScenario = scenarios[0];
  /* v8 ignore next -- buildScenarioPreviews always emits a current scenario; this protects malformed adapters. */
  if (!currentScenario) return [];
  const bestMatch = scenarios.find((scenarioPreview) => scenarioPreview.name === "bestReasonableCase");
  /* v8 ignore next -- buildScenarioPreviews always emits bestReasonableCase; current is the defensive fallback. */
  const best = bestMatch ?? currentScenario;
  const linkedMatch = scenarios.find((scenarioPreview) => scenarioPreview.name === "linkedIssueFixed");
  /* v8 ignore next -- buildScenarioPreviews always emits linkedIssueFixed; best is the defensive fallback. */
  const linked = linkedMatch ?? best;
  return [
    ...(current.scoreEstimate.openPrMultiplier !== best.scoreEstimate.openPrMultiplier || current.gates.openPrCount !== best.gates.openPrCount
      ? [
          {
            gate: "open_pr_threshold" as const,
            current: `${current.gates.openPrCount}/${current.gates.openPrThreshold} open PRs, multiplier ${current.scoreEstimate.openPrMultiplier}`,
            projected: `${best.gates.openPrCount}/${best.gates.openPrThreshold} open PRs, multiplier ${best.scoreEstimate.openPrMultiplier}`,
            explanation: `Open PR pressure changes estimated score ${current.scoreEstimate.estimatedMergedScore} -> ${best.scoreEstimate.estimatedMergedScore}.`,
          },
        ]
      : []),
    ...(current.scoreEstimate.openIssueMultiplier !== best.scoreEstimate.openIssueMultiplier || current.gates.openIssueCount !== best.gates.openIssueCount
      ? [
          {
            gate: "open_issue_threshold" as const,
            current: `${current.gates.openIssueCount}/${current.gates.openIssueThreshold} open issues, multiplier ${current.scoreEstimate.openIssueMultiplier}`,
            projected: `${best.gates.openIssueCount}/${best.gates.openIssueThreshold} open issues, multiplier ${best.scoreEstimate.openIssueMultiplier}`,
            explanation: `Open issue spam pressure changes estimated score ${current.scoreEstimate.estimatedMergedScore} -> ${best.scoreEstimate.estimatedMergedScore}.`,
          },
        ]
      : []),
    ...(current.scoreEstimate.mergedHistoryMultiplier !== best.scoreEstimate.mergedHistoryMultiplier
      ? [
          {
            gate: "merged_pr_history_floor" as const,
            current: `${current.gates.mergedPullRequests}/${current.gates.mergedPrFloor} merged PRs, multiplier ${current.scoreEstimate.mergedHistoryMultiplier}`,
            projected: `${best.gates.mergedPullRequests}/${best.gates.mergedPrFloor} merged PRs, multiplier ${best.scoreEstimate.mergedHistoryMultiplier}`,
            explanation: `Merged PR history changes estimated score ${current.scoreEstimate.estimatedMergedScore} -> ${best.scoreEstimate.estimatedMergedScore}.`,
          },
        ]
      : []),
    ...(current.scoreEstimate.issueDiscoveryHistoryMultiplier !== best.scoreEstimate.issueDiscoveryHistoryMultiplier
      ? [
          {
            gate: "issue_discovery_validity_floor" as const,
            current: `${current.gates.validSolvedIssues} valid solved / ${roundScore(current.gates.issueCredibility!)} credibility, multiplier ${current.scoreEstimate.issueDiscoveryHistoryMultiplier}`,
            projected: `${best.gates.validSolvedIssues} valid solved / ${roundScore(best.gates.issueCredibility!)} credibility, multiplier ${best.scoreEstimate.issueDiscoveryHistoryMultiplier}`,
            explanation: `Issue-discovery validity changes estimated score ${current.scoreEstimate.estimatedMergedScore} -> ${best.scoreEstimate.estimatedMergedScore}.`,
          },
        ]
      : []),
    ...(current.gates.credibilityObserved !== best.gates.credibilityObserved || current.scoreEstimate.credibilityMultiplier !== best.scoreEstimate.credibilityMultiplier
      ? [
          {
            gate: "credibility_floor" as const,
            current: `${roundScore(current.gates.credibilityObserved)} observed, multiplier ${current.scoreEstimate.credibilityMultiplier}`,
            projected: `${roundScore(best.gates.credibilityObserved)} projected, multiplier ${best.scoreEstimate.credibilityMultiplier}`,
            explanation: `Credibility changes estimated score ${current.scoreEstimate.estimatedMergedScore} -> ${best.scoreEstimate.estimatedMergedScore}.`,
          },
        ]
      : []),
    ...(current.scoreEstimate.issueMultiplier !== linked.scoreEstimate.issueMultiplier
      ? [
          {
            gate: "linked_issue_multiplier" as const,
            current: `${current.scoreEstimate.issueMultiplier}`,
            projected: `${linked.scoreEstimate.issueMultiplier}`,
            explanation: `Linked issue/no-issue context changes estimated score ${current.scoreEstimate.estimatedMergedScore} -> ${linked.scoreEstimate.estimatedMergedScore}.`,
          },
        ]
      : []),
  ];
}

function warningsFor(input: ScorePreviewInput, repo: RepositoryRecord | null, core: ScoreCore, branchEligibility = normalizeBranchEligibility(input)): string[] {
  return [...new Set([...blockedByFor(input, repo, core, branchEligibility).map((blocker) => blocker.detail), ...core.linkedIssueMultiplier.warnings])];
}

function statusFor(
  repo: RepositoryRecord | null,
  blockedBy: ScoreGateBlocker[],
  effectiveEstimatedScore: number,
  scenarios: ScoreScenarioPreview[],
): ScorePreviewResult["scoreabilityStatus"] {
  if (!repo?.isRegistered || blockedBy.some((blocker) => blocker.code === "inactive_allocation")) return "hold";
  if (effectiveEstimatedScore > 0 && !blockedBy.some((blocker) => blocker.severity === "blocker")) return "scoreable";
  if (scenarios.some((scenarioPreview) => scenarioPreview.name !== "current" && scenarioPreview.effectiveEstimatedScore > effectiveEstimatedScore)) {
    return "conditionally_scoreable";
  }
  return "blocked";
}

function deltaExplanationFor(core: ScoreCore, blockedBy: ScoreGateBlocker[]): string {
  if (blockedBy.length === 0) return `Currently scoreable at ${core.scoreEstimate.estimatedMergedScore}; underlying potential ${core.scoreEstimate.pendingSaturationScore}.`;
  return `Effective score ${core.scoreEstimate.estimatedMergedScore}; underlying potential ${core.scoreEstimate.pendingSaturationScore}; blocked or reduced by ${blockedBy.map((blocker) => blocker.code).join(", ")}.`;
}

function selectLabelMultiplier(labels: string[], multipliers: Record<string, number>, fallback: number): number {
  const normalized = labels.map((label) => label.toLowerCase());
  const matched = Object.entries(multipliers).flatMap(([pattern, multiplier]) => {
    const matcher = labelPatternToRegExp(pattern.toLowerCase());
    return normalized.some((label) => matcher.test(label)) ? [multiplier] : [];
  });
  return matched.length > 0 ? Math.max(...matched) : fallback || 1;
}

/** True when `label` matches the configured multiplier `pattern` under the SAME case-insensitive fnmatch glob
 *  semantics scoring uses to resolve label multipliers (see {@link labelPatternToRegExp}). Exported so the
 *  signals surfaces that audit configured label keys (config-quality, label-audit) match them as the GLOBS they
 *  are: a `type:*` key must count `type:bug-fix` as observed/configured, not silently report it missing because
 *  the literal pattern never appears verbatim on a real issue/PR. A literal key (no glob metacharacter) still
 *  matches only its exact label, so existing configs behave identically. */
export function labelMatchesPattern(label: string, pattern: string): boolean {
  return labelPatternToRegExp(pattern.toLowerCase()).test(label.toLowerCase());
}

// Compiled fnmatch→RegExp matchers are memoized by pattern. The same small,
// config-derived set of label keys is matched on every scored PR/issue, so the
// per-call recompile inside the nested label loops in engine.ts is pure waste.
// Keys are configured label patterns (bounded, not attacker-supplied), so the
// cache needs no eviction bound. The compiled RegExp carries only the "i" flag
// (no global/sticky `lastIndex` state), so sharing one instance across calls is
// safe and byte-identical to recompiling on every call.
const labelPatternRegExpCache = new Map<string, RegExp>();

// Upstream resolves label multipliers by matching each configured key as a Python `fnmatch` GLOB, not a
// literal string: `fnmatch(label.lower(), pattern.lower())` in
// gittensor/validator/oss_contributions/label_resolution.py, so a repo can configure `type:*`, `kind/*`, or
// `priority:?` and have it match `type:bug-fix`, `kind/bug`, `priority:1` (#1244-class scoring parity). The
// preview previously did exact equality, so it silently scored every wildcard-configured trusted label at the
// neutral default — under-/over-estimating the score for any repo using glob keys. Translate one fnmatch
// pattern to an anchored, case-insensitive RegExp. fnmatch semantics differ from the path-glob in
// change-guardrail.ts (there `*` stops at `/` and `?` is literal): labels are flat strings, so `*` matches any
// run, `?` any single character, and `[seq]`/`[!seq]` a character class. Literal keys are unaffected — for a
// pattern with no glob metacharacter the RegExp is an exact match, so existing configs score identically.
function labelPatternToRegExp(pattern: string): RegExp {
  const cached = labelPatternRegExpCache.get(pattern);
  if (cached !== undefined) return cached;
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern.charAt(i);
    i += 1;
    if (char === "*") {
      regex += ".*";
    } else if (char === "?") {
      regex += ".";
    } else if (char === "[") {
      const close = pattern.indexOf("]", i);
      if (close === -1) {
        // No closing bracket: fnmatch treats the `[` as a literal character.
        regex += "\\[";
      } else {
        const rawBody = pattern.slice(i, close);
        if (rawBody === "" || rawBody === "!") {
          // Empty classes and bare `[!]` stay literal in Python fnmatch instead of compiling as classes.
          regex += `\\[${escapeRegExpLiteral(rawBody)}\\]`;
        } else if (hasDescendingCharacterRange(rawBody)) {
          // Python fnmatch treats invalid ranges like `[z-a]` as a never-match pattern; RegExp throws.
          regex += "(?!)";
        } else {
          let body = rawBody.replace(/\\/g, "\\\\");
          // `[!seq]` is fnmatch's negated class; RegExp spells negation as `[^seq]`.
          if (body.startsWith("!")) body = `^${body.slice(1)}`;
          else if (body.startsWith("^")) body = `\\${body}`;
          regex += `[${body}]`;
        }
        i = close + 1;
      }
    } else if (/[.+^${}()|\]\\]/.test(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  const compiled = new RegExp(`^${regex}$`, "i");
  labelPatternRegExpCache.set(pattern, compiled);
  return compiled;
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDescendingCharacterRange(body: string): boolean {
  const start = body.startsWith("!") ? 1 : 0;
  for (let i = start + 1; i < body.length - 1; i += 1) {
    if (body.charAt(i) === "-" && body.charCodeAt(i - 1) > body.charCodeAt(i + 1)) return true;
  }
  return false;
}

function decideLinkedIssueMultiplier(
  mode: "none" | "standard" | "maintainer",
  context: LinkedIssueMultiplierContext | undefined,
  constants: Record<string, number>,
  branchEligibility: BranchEligibilityResult,
): LinkedIssueMultiplierDecision {
  const baseMultiplier = selectIssueMultiplier(mode, constants);
  const issueNumbers = uniquePositiveInts(context?.issueNumbers ?? []);
  const solvedByPullRequests = uniquePositiveInts(context?.solvedByPullRequests ?? []);
  if (mode === "none") {
    return {
      mode,
      status: "not_required",
      source: "none",
      eligible: false,
      issueNumbers,
      solvedByPullRequests,
      baseMultiplier,
      appliedMultiplier: 1,
      reason: "No linked-issue multiplier mode was requested.",
      warnings: [],
    };
  }
  if (mode === "maintainer") {
    return {
      mode,
      status: "not_required",
      source: context?.source ?? "none",
      eligible: true,
      issueNumbers,
      solvedByPullRequests,
      baseMultiplier,
      appliedMultiplier: baseMultiplier,
      reason: "Maintainer-lane multiplier does not require solved-by-PR issue linkage.",
      warnings: context?.warnings ?? [],
    };
  }

  const projectedSolvedByPullRequestValidation = (context as ProjectedLinkedIssueMultiplierContext | undefined)?.[PROJECTED_SOLVED_BY_PULL_REQUEST_VALIDATION] === true;
  const requestedStatus = context?.status ?? (solvedByPullRequests.length > 0 ? "validated" : issueNumbers.length > 0 ? "raw" : "unavailable");
  const hasSolvedByPullRequestEvidence = solvedByPullRequests.length > 0 || projectedSolvedByPullRequestValidation;
  const status = requestedStatus === "validated" && !hasSolvedByPullRequestEvidence ? (issueNumbers.length > 0 ? "raw" : "unavailable") : requestedStatus;
  const source = context?.source ?? (status === "unavailable" ? "missing" : "user_supplied");
  const branchEligible = isConfirmedBranchEligible(branchEligibility);
  const eligible = status === "validated" && hasSolvedByPullRequestEvidence && branchEligible;
  const reason =
    branchEligible || status !== "validated"
      ? status === requestedStatus
        ? context?.reason ?? linkedIssueReason(status, source, issueNumbers, solvedByPullRequests)
        : linkedIssueReason(status, source, issueNumbers, solvedByPullRequests)
      : branchEligibilityFailureReason(branchEligibility);
  return {
    mode,
    status,
    source,
    eligible,
    issueNumbers,
    solvedByPullRequests,
    baseMultiplier,
    appliedMultiplier: eligible ? baseMultiplier : 1,
    reason,
    warnings: [...new Set([...linkedIssueWarnings(status), ...branchEligibility.warnings, ...(context?.warnings ?? [])])],
  };
}

function isConfirmedBranchEligible(branchEligibility: BranchEligibilityResult): boolean {
  return !branchEligibility.required || (branchEligibility.status === "eligible" && branchEligibility.evidence === "provided" && !branchEligibility.stale);
}

function branchEligibilityFailureReason(branchEligibility: BranchEligibilityResult): string {
  if (branchEligibility.status === "ineligible") return "Branch eligibility is confirmed ineligible; standard issue multiplier is not applied.";
  if (branchEligibility.evidence === "missing") return "Branch eligibility evidence is missing; standard issue multiplier is not applied.";
  if (branchEligibility.status === "unknown") return "Branch eligibility is unknown; standard issue multiplier is not applied.";
  if (branchEligibility.stale) return "Branch eligibility evidence is stale; standard issue multiplier is not applied.";
  if (branchEligibility.source === "user_supplied") return "Branch eligibility evidence is user-supplied; standard issue multiplier is not applied until verified metadata is available.";
  return "Branch eligibility is not confirmed; standard issue multiplier is not applied.";
}

function withValidatedLinkedIssueScenario(input: ScorePreviewInput): ScorePreviewInput {
  const mode = input.linkedIssueMode ?? "none";
  if (mode === "maintainer") return input;
  const issueNumbers = uniquePositiveInts(input.linkedIssueContext?.issueNumbers ?? []);
  const solvedByPullRequests = uniquePositiveInts(input.linkedIssueContext?.solvedByPullRequests ?? []);
  const linkedIssueContext: ProjectedLinkedIssueMultiplierContext = {
    ...input.linkedIssueContext,
    status: "validated",
    source: input.linkedIssueContext?.source ?? "user_supplied",
    issueNumbers,
    solvedByPullRequests,
    warnings: [],
    [PROJECTED_SOLVED_BY_PULL_REQUEST_VALIDATION]: true,
  };
  return {
    ...input,
    linkedIssueMode: "standard",
    linkedIssueContext,
  };
}

/**
 * Project the standard linked-issue multiplier decision under the assumption that a planned PR
 * becomes the merged solver of the given issue(s). Reuses {@link decideLinkedIssueMultiplier} — the
 * same eligibility rule used by buildScorePreview — so standalone validators stay consistent with
 * the scoring engine. The numeric multiplier on the returned decision is private; callers that are
 * public-safe should surface only `eligible`/`status`/`reason`.
 */
export function projectLinkedIssueMultiplierForPlannedSolve(issueNumbers: number[]): LinkedIssueMultiplierDecision {
  const branchEligibility: BranchEligibilityResult = {
    required: true,
    status: "eligible",
    evidence: "provided",
    source: "user_supplied",
    stale: false,
    warnings: [],
  };
  const context: ProjectedLinkedIssueMultiplierContext = {
    status: "validated",
    source: "user_supplied",
    issueNumbers: uniquePositiveInts(issueNumbers),
    solvedByPullRequests: [],
    warnings: [],
    [PROJECTED_SOLVED_BY_PULL_REQUEST_VALIDATION]: true,
  };
  return decideLinkedIssueMultiplier("standard", context, {}, branchEligibility);
}

function linkedIssueReason(
  status: Exclude<LinkedIssueMultiplierStatus, "not_required">,
  source: LinkedIssueMultiplierSource,
  issueNumbers: number[],
  solvedByPullRequests: number[],
): string {
  const issues = issueNumbers.length > 0 ? ` for issue(s) ${issueNumbers.map((number) => `#${number}`).join(", ")}` : "";
  if (status === "validated") {
    const solvers = solvedByPullRequests.length > 0 ? ` via solved-by-PR ${solvedByPullRequests.map((number) => `#${number}`).join(", ")}` : "";
    return `Linked issue context is solved-by-PR validated${issues}${solvers}.`;
  }
  if (status === "invalid") return `Linked issue context is invalid${issues}; standard issue multiplier is not applied.`;
  if (status === "plausible") return `Linked issue context is plausible${issues}, but solved-by-PR validation is not available yet.`;
  if (status === "unavailable") return `Linked issue mirror/cache data is unavailable${issues}; standard issue multiplier is not applied until validation is available.`;
  return `Raw linked issue reference${issues} has no solved-by-PR validation from ${source}.`;
}

function linkedIssueWarnings(status: Exclude<LinkedIssueMultiplierStatus, "not_required">): string[] {
  if (status === "validated") return [];
  if (status === "invalid") return ["Linked issue context is invalid; standard issue multiplier is not applied."];
  if (status === "unavailable") return ["Linked issue mirror/cache data is unavailable; standard issue multiplier is not applied until validation is available."];
  if (status === "plausible") return ["Linked issue context is plausible but not solved-by-PR validated; standard issue multiplier is not applied."];
  return ["Raw linked issue reference has no solved-by-PR evidence; standard issue multiplier is not applied."];
}

function uniquePositiveInts(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort((left, right) => left - right);
}

function selectIssueMultiplier(mode: "none" | "standard" | "maintainer", constants: Record<string, number>): number {
  if (mode === "maintainer") return constant(constants, "MAINTAINER_ISSUE_MULTIPLIER");
  if (mode === "standard") return constant(constants, "STANDARD_ISSUE_MULTIPLIER");
  return 1;
}

function normalizeBranchEligibility(input: ScorePreviewInput): BranchEligibilityResult {
  const required = input.linkedIssueMode === "standard";
  const supplied = input.branchEligibility;
  if (!required) {
    return {
      required: false,
      status: "not_required",
      evidence: supplied ? "provided" : "missing",
      source: supplied ? supplied.source ?? "user_supplied" : "missing",
      reason: supplied?.reason,
      checkedAt: supplied?.checkedAt,
      stale: Boolean(supplied?.stale),
      warnings: [],
    };
  }
  if (!supplied) {
    return {
      required: true,
      status: "unknown",
      evidence: "missing",
      source: "missing",
      stale: false,
      warnings: ["Branch eligibility evidence is missing; refresh branch/base metadata before relying on linked-issue assumptions."],
    };
  }
  const status = supplied.status ?? "unknown";
  const stale = Boolean(supplied.stale);
  const warnings = [
    ...(status === "ineligible" ? ["Branch eligibility is confirmed ineligible; linked-issue multiplier assumptions are disabled."] : []),
    ...(status === "unknown" ? ["Branch eligibility is unknown; refresh branch/base metadata before relying on linked-issue assumptions."] : []),
    ...(stale ? ["Branch eligibility evidence is stale; refresh branch/base metadata before relying on linked-issue assumptions."] : []),
  ];
  return {
    required: true,
    status,
    evidence: "provided",
    source: supplied.source ?? "user_supplied",
    reason: supplied.reason,
    checkedAt: supplied.checkedAt,
    stale,
    warnings,
  };
}

function resolveMergedPullRequests(
  input: Pick<ScorePreviewInput, "mergedPullRequests">,
  contributorEvidence?: ContributorEvidenceRecord | null,
): number | undefined {
  if (input.mergedPullRequests !== undefined) return nonNegative(input.mergedPullRequests);
  const fromEvidence = Number(contributorEvidence?.payload?.mergedPullRequests);
  return Number.isFinite(fromEvidence) ? nonNegative(fromEvidence) : undefined;
}

function inferCredibility(evidence?: ContributorEvidenceRecord | null): number {
  const payload = evidence?.payload;
  const merged = Number(payload?.mergedPullRequests ?? 0);
  const stale = Number(payload?.stalePullRequests ?? 0);
  const unlinked = Number(payload?.unlinkedPullRequests ?? 0);
  // The payload is a loosely-typed cache (`Record<string, JsonValue>`), so any count can arrive as a
  // non-numeric value. A non-finite `stale`/`unlinked` propagates NaN through the arithmetic below —
  // and `clamp` cannot rescue NaN — poisoning the whole credibility multiplier and score, so guard all
  // three counts, not just `merged`, falling back to the neutral credibility.
  if (!Number.isFinite(merged) || !Number.isFinite(stale) || !Number.isFinite(unlinked)) return 0.8;
  return clamp(0.75 + merged * 0.04 - stale * 0.03 - unlinked * 0.02, 0.25, 1);
}

function applyNonCodeLineCap(input: Pick<ScorePreviewInput, "nonCodeTokenScore" | "nonCodeLines">, constants: Record<string, number>): number {
  const score = nonNegative(input.nonCodeTokenScore);
  const lines = nonNegative(input.nonCodeLines);
  if (score <= 0 || lines <= 0) return score;
  const maxLines = constant(constants, "MAX_LINES_SCORED_FOR_NON_CODE_EXT");
  return lines <= maxLines ? score : score * (maxLines / lines);
}

function applyNonCodeCapToTotal(
  totalTokenScore: number,
  input: Pick<ScorePreviewInput, "nonCodeTokenScore" | "nonCodeLines">,
  cappedNonCodeTokenScore: number,
): number {
  const total = nonNegative(totalTokenScore);
  const nonCodeTokenScore = nonNegative(input.nonCodeTokenScore);
  if (nonCodeTokenScore <= 0 || cappedNonCodeTokenScore >= nonCodeTokenScore) return total;
  return Math.max(0, total - (nonCodeTokenScore - cappedNonCodeTokenScore));
}

// Single source of truth (#812): the fallback for any constant is ALWAYS DEFAULT_SCORING_CONSTANTS — never
// a duplicated literal at the call site. The live `constants` (snapshot.constants, which already merges
// DEFAULT_SCORING_CONSTANTS with parsed upstream values) wins when present; otherwise the declared default
// is used. This removes the duplicate-source-of-truth drift surface without changing any value (every
// former call-site literal already matched its DEFAULT_SCORING_CONSTANTS entry).
function constant(constants: Record<string, number>, key: string): number {
  const value = constants[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const fallback = DEFAULT_SCORING_CONSTANTS[key];
  /* v8 ignore next -- defensive: every recognized key is in DEFAULT_SCORING_CONSTANTS; this guards typos/forward-compat. */
  return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0;
}

/**
 * Resolve a repo's time-decay curve: each parameter is the repo's per-repo override (from the registry's
 * `scoring.time_decay`) when present, else the global default constant from the live scoring snapshot.
 * Mirrors upstream's `resolve_time_decay` (RepoTimeDecayConfig overlaid on the module constants).
 *
 * Parity note (#1320): upstream coerces ONLY `grace_period_hours` to an integer
 * (`grace_period_hours=int(pick(...))`) while the three curve params stay floats. A maintainer may legally
 * configure a fractional grace (upstream validates `0 <= grace_period_hours <= 168`), so the resolved grace
 * must be truncated toward zero to match the validator — otherwise a PR aged between `trunc(grace)` and
 * `grace` is treated as fresh in the preview but already decaying upstream.
 */
export function resolveTimeDecay(
  constants: Record<string, number>,
  overrides?: RepoTimeDecayOverrides | null,
): { gracePeriodHours: number; sigmoidMidpointDays: number; sigmoidSteepness: number; minMultiplier: number } {
  return {
    gracePeriodHours: Math.trunc(pickOverride(overrides?.gracePeriodHours, constant(constants, "TIME_DECAY_GRACE_PERIOD_HOURS"))),
    sigmoidMidpointDays: pickOverride(overrides?.sigmoidMidpointDays, constant(constants, "TIME_DECAY_SIGMOID_MIDPOINT")),
    sigmoidSteepness: pickOverride(overrides?.sigmoidSteepness, constant(constants, "TIME_DECAY_SIGMOID_STEEPNESS_SCALAR")),
    minMultiplier: pickOverride(overrides?.minMultiplier, constant(constants, "TIME_DECAY_MIN_MULTIPLIER")),
  };
}

function pickOverride(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Upstream gittensor's sigmoid time-decay multiplier (#703), ported verbatim from the validator's
 * `calculate_time_decay` (gittensor/validator/utils/datetime_utils.py): for the first grace-period hours the
 * multiplier is exactly 1.0 (hard cutoff); after that it follows a logistic on days-since-merge centred at
 * the sigmoid midpoint (50% at that point), floored at the minimum multiplier. The curve params are
 * resolved PER-REPO (overrides ?? snapshot defaults), so each maintainer's registry hyperparameters apply.
 * Pure + deterministic.
 */
export function calculateTimeDecay(prAgeHours: number, constants: Record<string, number>, overrides?: RepoTimeDecayOverrides | null): number {
  const { gracePeriodHours, sigmoidMidpointDays, sigmoidSteepness, minMultiplier } = resolveTimeDecay(constants, overrides);
  if (!Number.isFinite(prAgeHours) || prAgeHours < gracePeriodHours) return 1;
  const days = prAgeHours / 24;
  const sigmoid = 1 / (1 + Math.exp(sigmoidSteepness * (days - sigmoidMidpointDays)));
  return Math.max(sigmoid, minMultiplier);
}

function saturationScore(sourceTokenScore: number, totalTokenScore: number, constants: Record<string, number>): number {
  // SRC_TOK_SATURATION_SCALE is per-repo overridable only within [10, 500] upstream; a snapshot value outside
  // that band (a bad override, a parse glitch) would otherwise distort the saturation curve — at scale 1 the
  // component saturates almost immediately, well above the documented floor. Clamp to the documented range so
  // the curve stays within upstream bounds (the prior Math.max(...,1) only guarded the divide-by-zero edge).
  const scale = clampSaturationScale(constant(constants, "SRC_TOK_SATURATION_SCALE"));
  return (
    constant(constants, "MERGED_PR_BASE_SCORE") * (1 - Math.exp(-sourceTokenScore / scale)) +
    saturationContributionBonus(totalTokenScore, constants)
  );
}

function saturationContributionBonus(totalTokenScore: number, constants: Record<string, number>): number {
  return contributionBonusRamp(totalTokenScore, constants);
}

// Shared contribution-bonus ramp used by both scoring models so the saturation
// and density bonuses cannot drift: clamp(totalTokenScore / FULL_BONUS, 0, 1)
// scaled by MAX_CONTRIBUTION_BONUS (upstream default 5; single-sourced in model.ts, see #807/#812).
function contributionBonusRamp(totalTokenScore: number, constants: Record<string, number>): number {
  return (
    clamp(totalTokenScore / constant(constants, "CONTRIBUTION_SCORE_FOR_FULL_BONUS"), 0, 1) *
    constant(constants, "MAX_CONTRIBUTION_BONUS")
  );
}

function nonNegative(value: number | undefined): number {
  /* v8 ignore next -- API schemas and local scorers normalize numeric preview inputs before this defensive fallback. */
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Bounds documented by upstream for the two repo-configurable scoring inputs the preview consumes directly.
const FIXED_BASE_SCORE_MIN = 0;
const FIXED_BASE_SCORE_MAX = 100;
const SRC_TOK_SATURATION_SCALE_MIN = 10;
const SRC_TOK_SATURATION_SCALE_MAX = 500;

// A repo's fixed_base_score override forces base_score to a constant within [0, 100]. The value reaches the
// preview unbounded above — the API schema only enforces `.min(0)` and registry normalization accepts any
// finite number — so a misconfigured 150 would otherwise mint a base score above the model ceiling. Clamp to
// the documented range; a non-finite/absent value falls through to the token-derived base score.
function clampFixedBaseScore(value: number | null | undefined): number | undefined {
  return Number.isFinite(value) ? clamp(value as number, FIXED_BASE_SCORE_MIN, FIXED_BASE_SCORE_MAX) : undefined;
}

function clampSaturationScale(value: number): number {
  return clamp(value, SRC_TOK_SATURATION_SCALE_MIN, SRC_TOK_SATURATION_SCALE_MAX);
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}
