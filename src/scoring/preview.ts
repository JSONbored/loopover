import type { ContributorEvidenceRecord, JsonValue, RepositoryRecord, RepoTimeDecayOverrides, ScoringModelSnapshotRecord, ScorePreviewRecord } from "../types";
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
  existingContributorTokenScore?: number | undefined;
  openPrCount?: number | undefined;
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
  gate: "open_pr_threshold" | "credibility_floor" | "linked_issue_multiplier";
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
    collateralFraction: number;
    credibilityFloor: number;
    credibilityObserved: number;
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
  const warnings = warningsFor(args.input, args.repo, current, branchEligibility);
  const actions = [
    ...(!current.gates.baseTokenGatePassed ? ["Increase meaningful source change size or scope clarity before relying on this preview."] : []),
    ...(current.scoreEstimate.openPrMultiplier === 0 ? ["Land or close existing open PRs before opening more concurrent work."] : []),
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
  const ossEmissionShare = constant(constants, "OSS_EMISSION_SHARE", 0.9);
  const repoSlice = emissionShare * ossEmissionShare;
  const directPrSlice = repoSlice * (1 - issueDiscoveryShare);
  const issueDiscoverySlice = repoSlice * issueDiscoveryShare;
  const sourceTokenScore = nonNegative(input.sourceTokenScore);
  const totalTokenScore = nonNegative(input.totalTokenScore ?? sourceTokenScore + nonNegative(input.testTokenScore) + nonNegative(input.nonCodeTokenScore));
  const sourceLines = Math.max(1, nonNegative(input.sourceLines ?? sourceTokenScore));
  const fixedBaseScore = input.fixedBaseScore ?? config?.fixedBaseScore ?? undefined;
  const rawDensity = sourceTokenScore / sourceLines;
  const densityMultiplier = clamp(rawDensity || 0, 0, constant(constants, "MAX_CODE_DENSITY_MULTIPLIER", 1.15));
  const densityTokenGatePassed = sourceTokenScore >= constant(constants, "MIN_TOKEN_SCORE_FOR_BASE_SCORE", 5);
  const baseTokenGatePassed = snapshot.activeModel === "pending_saturation_model" ? sourceTokenScore > 0 : densityTokenGatePassed;
  const densityContributionBonus = contributionBonusRamp(totalTokenScore, constants);
  const saturationContributionBonusValue = saturationContributionBonus(totalTokenScore, constants);
  const saturationBaseScore = saturationScore(sourceTokenScore, totalTokenScore, constants);
  const densityBaseScore =
    (densityTokenGatePassed ? constant(constants, "MERGED_PR_BASE_SCORE", 25) * densityMultiplier : 0) + densityContributionBonus;
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
  const credibilityFloor = constant(constants, "MIN_CREDIBILITY", 0.8);
  const credibilityMultiplier = credibilityObserved >= credibilityFloor ? 1 : credibilityObserved / credibilityFloor;
  const changesRequestedCount = nonNegative(input.changesRequestedCount);
  const reviewPenaltyMultiplier = clamp(1 - changesRequestedCount * constant(constants, "REVIEW_PENALTY_RATE", 0.15), 0, 1);
  const openPrCount = nonNegative(input.openPrCount);
  // The concurrency allowance is earned from the contributor's established merged-history token
  // score; the planned PR's own tokens (totalTokenScore) must not inflate its own open-PR threshold.
  const openPrThreshold = Math.min(
    constant(constants, "MAX_OPEN_PR_THRESHOLD", 30),
    constant(constants, "EXCESSIVE_PR_PENALTY_BASE_THRESHOLD", 2) +
      Math.floor(nonNegative(input.existingContributorTokenScore) / constant(constants, "OPEN_PR_THRESHOLD_TOKEN_SCORE", 300)),
  );
  const openPrMultiplier = openPrCount <= openPrThreshold ? 1 : 0;
  // Upstream time-decay (#703): mirrors upstream's `scored.time_decay_multiplier` applied to a PR's score.
  // Opt-in + env-gated (default off). A fresh PR (prAgeHours below the grace period) yields 1.0, so a normal
  // new-PR preview is unchanged even when enabled — only an aged-PR projection decays.
  // Per-repo curve (#703): the repo's registry `scoring.time_decay` overrides overlay the snapshot defaults.
  const timeDecayMultiplier = input.applyTimeDecay ? calculateTimeDecay(nonNegative(input.prAgeHours), constants, config?.timeDecay) : 1;
  const estimatedMergedScore = roundScore(
    baseScore * labelMultiplier * issueMultiplier * credibilityMultiplier * reviewPenaltyMultiplier * openPrMultiplier * timeDecayMultiplier,
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
      timeDecayMultiplier: roundScore(timeDecayMultiplier),
      estimatedMergedScore,
      pendingSaturationScore,
    },
    linkedIssueMultiplier,
    gates: {
      baseTokenGatePassed,
      openPrThreshold,
      openPrCount,
      collateralFraction: constant(constants, "OPEN_PR_COLLATERAL_PERCENT", 0.2),
      credibilityFloor,
      credibilityObserved,
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
    credibility: Math.max(current.gates.credibilityObserved, current.gates.credibilityFloor),
  };
  const afterPendingInput = {
    ...input,
    openPrCount: expectedOpenPrCountAfterMerge,
    credibility: projectedCredibility,
  };
  const linkedIssueInput = withValidatedLinkedIssueScenario(input);
  const bestReasonableInput = {
    ...linkedIssueInput,
    openPrCount: Math.min(
      input.expectedOpenPrCountAfterMerge !== undefined ? expectedOpenPrCountAfterMerge : Math.max(0, current.gates.openPrCount - combinedPendingCount),
      current.gates.openPrThreshold,
    ),
    credibility: Math.max(projectedCredibility, observedApprovalCredibility, current.gates.credibilityFloor),
  };
  return [
    scenario("current", "current_data", input, current, ["Current cached/account state and supplied local diff metadata."], repo),
    scenario("cleanGates", "gittensory_projection", cleanGatesInput, computeScoreCore(cleanGatesInput, repo, snapshot, contributorEvidence), [
      "Open PR and credibility gates are projected as cleared; branch metadata is otherwise unchanged.",
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
      "Combines plausible near-term gate cleanup: open PR pressure at threshold or below, credibility at floor or above, and linked-issue context where applicable.",
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
  const normalized = new Set(labels.map((label) => label.toLowerCase()));
  return Math.max(
    fallback || 1,
    ...Object.entries(multipliers).flatMap(([label, multiplier]) => (normalized.has(label.toLowerCase()) ? [multiplier] : [])),
  );
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
  const branchEligible = !(branchEligibility.required && branchEligibility.status === "ineligible");
  const eligible = status === "validated" && hasSolvedByPullRequestEvidence && branchEligible;
  const reason =
    branchEligible || status !== "validated"
      ? status === requestedStatus
        ? context?.reason ?? linkedIssueReason(status, source, issueNumbers, solvedByPullRequests)
        : linkedIssueReason(status, source, issueNumbers, solvedByPullRequests)
      : "Branch eligibility is confirmed ineligible; standard issue multiplier is not applied.";
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
  if (mode === "maintainer") return constant(constants, "MAINTAINER_ISSUE_MULTIPLIER", 1.66);
  if (mode === "standard") return constant(constants, "STANDARD_ISSUE_MULTIPLIER", 1.33);
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

function inferCredibility(evidence?: ContributorEvidenceRecord | null): number {
  const payload = evidence?.payload;
  const merged = Number(payload?.mergedPullRequests ?? 0);
  const stale = Number(payload?.stalePullRequests ?? 0);
  const unlinked = Number(payload?.unlinkedPullRequests ?? 0);
  if (!Number.isFinite(merged)) return 0.8;
  return clamp(0.75 + merged * 0.04 - stale * 0.03 - unlinked * 0.02, 0.25, 1);
}

function constant(constants: Record<string, number>, key: string, fallback: number): number {
  const value = constants[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Resolve a repo's time-decay curve: each parameter is the repo's per-repo override (from the registry's
 * `scoring.time_decay`) when present, else the global default constant from the live scoring snapshot.
 * Mirrors upstream's `resolve_time_decay` (RepoTimeDecayConfig overlaid on the module constants).
 */
export function resolveTimeDecay(
  constants: Record<string, number>,
  overrides?: RepoTimeDecayOverrides | null,
): { gracePeriodHours: number; sigmoidMidpointDays: number; sigmoidSteepness: number; minMultiplier: number } {
  return {
    gracePeriodHours: pickOverride(overrides?.gracePeriodHours, constant(constants, "TIME_DECAY_GRACE_PERIOD_HOURS", 12)),
    sigmoidMidpointDays: pickOverride(overrides?.sigmoidMidpointDays, constant(constants, "TIME_DECAY_SIGMOID_MIDPOINT", 10)),
    sigmoidSteepness: pickOverride(overrides?.sigmoidSteepness, constant(constants, "TIME_DECAY_SIGMOID_STEEPNESS_SCALAR", 0.4)),
    minMultiplier: pickOverride(overrides?.minMultiplier, constant(constants, "TIME_DECAY_MIN_MULTIPLIER", 0.05)),
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
  const scale = Math.max(constant(constants, "SRC_TOK_SATURATION_SCALE", 58), 1);
  return (
    constant(constants, "MERGED_PR_BASE_SCORE", 25) * (1 - Math.exp(-sourceTokenScore / scale)) +
    saturationContributionBonus(totalTokenScore, constants)
  );
}

function saturationContributionBonus(totalTokenScore: number, constants: Record<string, number>): number {
  return contributionBonusRamp(totalTokenScore, constants);
}

// Shared contribution-bonus ramp used by both scoring models so the saturation
// and density bonuses cannot drift: clamp(totalTokenScore / FULL_BONUS, 0, 1)
// scaled by MAX_CONTRIBUTION_BONUS (upstream default 5; see model.ts #807).
function contributionBonusRamp(totalTokenScore: number, constants: Record<string, number>): number {
  return (
    clamp(totalTokenScore / constant(constants, "CONTRIBUTION_SCORE_FOR_FULL_BONUS", 1500), 0, 1) *
    constant(constants, "MAX_CONTRIBUTION_BONUS", 5)
  );
}

function nonNegative(value: number | undefined): number {
  /* v8 ignore next -- API schemas and local scorers normalize numeric preview inputs before this defensive fallback. */
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}
