import type { ContributorEvidenceRecord, JsonValue, RepositoryRecord, ScoringModelSnapshotRecord, ScorePreviewRecord } from "../types";
import { nowIso } from "../utils/json";

export type ScorePreviewInput = {
  repoFullName: string;
  targetType?: ScorePreviewRecord["targetType"];
  targetKey?: string | undefined;
  contributorLogin?: string | undefined;
  labels?: string[] | undefined;
  linkedIssueMode?: "none" | "standard" | "maintainer" | undefined;
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
  expectedOpenPrCountAfterMerge?: number | undefined;
  projectedCredibility?: number | undefined;
  scenarioNotes?: string[] | undefined;
  observedScenarioNotes?: string[] | undefined;
};

export type ScoreGateBlocker = {
  code:
    | "repo_not_registered"
    | "inactive_allocation"
    | "base_token_gate"
    | "open_pr_threshold"
    | "credibility_floor"
    | "review_penalty"
    | "metadata_only";
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
    estimatedMergedScore: number;
    pendingSaturationScore: number;
  };
  gates: {
    baseTokenGatePassed: boolean;
    openPrThreshold: number;
    openPrCount: number;
    collateralFraction: number;
    credibilityFloor: number;
    credibilityObserved: number;
  };
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
  const current = computeScoreCore(args.input, args.repo, args.snapshot, args.contributorEvidence);
  const scenarioPreviews = buildScenarioPreviews(args.input, args.repo, args.snapshot, args.contributorEvidence, current);
  const blockedBy = blockedByFor(args.input, args.repo, current);
  const gateDeltas = buildGateDeltas(current, scenarioPreviews);
  const effectiveEstimatedScore = current.scoreEstimate.estimatedMergedScore;
  const underlyingPotentialScore = current.scoreEstimate.pendingSaturationScore;
  const scoreabilityStatus = statusFor(args.repo, blockedBy, effectiveEstimatedScore, scenarioPreviews);
  const warnings = warningsFor(args.input, args.repo, current);
  const actions = [
    ...(!current.gates.baseTokenGatePassed ? ["Increase meaningful source change size or scope clarity before relying on this preview."] : []),
    ...(current.scoreEstimate.openPrMultiplier === 0 ? ["Land or close existing open PRs before opening more concurrent work."] : []),
    ...(current.scoreEstimate.credibilityMultiplier < 1 ? ["Build or wait for contributor credibility evidence before relying on this preview."] : []),
    ...(current.scoreEstimate.reviewPenaltyMultiplier < 1 ? ["Reduce review churn with tighter tests and clearer evidence."] : []),
    ...(current.scoreEstimate.labelMultiplier <= 1 && Object.keys(args.repo?.registryConfig?.labelMultipliers ?? {}).length > 0
      ? ["Check whether the change legitimately matches one of the repo's configured trusted labels."]
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
    gates: current.gates,
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

type ScoreCore = Pick<ScorePreviewResult, "laneMath" | "scoreEstimate" | "gates">;

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
  const baseTokenGatePassed = sourceTokenScore >= constant(constants, "MIN_TOKEN_SCORE_FOR_BASE_SCORE", 5);
  const contributionBonus =
    clamp(totalTokenScore / constant(constants, "CONTRIBUTION_SCORE_FOR_FULL_BONUS", 1500), 0, 1) *
    constant(constants, "MAX_CONTRIBUTION_BONUS", 25);
  const baseScore =
    fixedBaseScore !== undefined
      ? fixedBaseScore
      : (baseTokenGatePassed ? constant(constants, "MERGED_PR_BASE_SCORE", 25) * densityMultiplier : 0) + contributionBonus;
  const labelMultiplier = selectLabelMultiplier(input.labels ?? [], config?.labelMultipliers ?? {}, config?.defaultLabelMultiplier ?? 1);
  const issueMultiplier = selectIssueMultiplier(input.linkedIssueMode ?? "none", constants);
  const credibilityObserved = clamp(input.credibility ?? inferCredibility(contributorEvidence), 0, 1);
  const credibilityFloor = constant(constants, "MIN_CREDIBILITY", 0.8);
  const credibilityMultiplier = credibilityObserved >= credibilityFloor ? 1 : credibilityObserved / credibilityFloor;
  const changesRequestedCount = nonNegative(input.changesRequestedCount);
  const reviewPenaltyMultiplier = clamp(1 - changesRequestedCount * constant(constants, "REVIEW_PENALTY_RATE", 0.15), 0, 1);
  const openPrCount = nonNegative(input.openPrCount);
  const openPrThreshold = Math.min(
    constant(constants, "MAX_OPEN_PR_THRESHOLD", 30),
    constant(constants, "EXCESSIVE_PR_PENALTY_BASE_THRESHOLD", 2) +
      Math.floor((nonNegative(input.existingContributorTokenScore) + totalTokenScore) / constant(constants, "OPEN_PR_THRESHOLD_TOKEN_SCORE", 300)),
  );
  const openPrMultiplier = openPrCount <= openPrThreshold ? 1 : 0;
  const estimatedMergedScore = roundScore(baseScore * labelMultiplier * issueMultiplier * credibilityMultiplier * reviewPenaltyMultiplier * openPrMultiplier);
  const pendingSaturationScore = roundScore(
    constant(constants, "MERGED_PR_BASE_SCORE", 25) * (1 - Math.exp(-sourceTokenScore / constant(constants, "SRC_TOK_SATURATION_SCALE", 58))) +
      clamp(totalTokenScore / constant(constants, "CONTRIBUTION_SCORE_FOR_FULL_BONUS", 1500), 0, 1) * 5,
  );
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
      contributionBonus: roundScore(contributionBonus),
      labelMultiplier,
      issueMultiplier,
      credibilityMultiplier: roundScore(credibilityMultiplier),
      reviewPenaltyMultiplier: roundScore(reviewPenaltyMultiplier),
      openPrMultiplier,
      estimatedMergedScore,
      pendingSaturationScore,
    },
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
  const userPendingCount = nonNegative(input.pendingMergedPrCount) + nonNegative(input.pendingClosedPrCount) + nonNegative(input.approvedPrCount);
  const observedApprovedCount = nonNegative(input.observedApprovedPrCount);
  const observedCloseCount = nonNegative(input.observedStalePrCount) + nonNegative(input.observedClosedPrCount);
  const combinedPendingCount = userPendingCount + observedApprovedCount + observedCloseCount;
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
    openPrCount: Math.max(0, current.gates.openPrCount - observedCloseCount),
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
  const linkedIssueInput = {
    ...input,
    linkedIssueMode: input.linkedIssueMode === "none" || !input.linkedIssueMode ? ("standard" as const) : input.linkedIssueMode,
  };
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
      userPendingCount > 0 || input.expectedOpenPrCountAfterMerge !== undefined || input.projectedCredibility !== undefined ? "user_supplied" : "gittensory_projection",
      afterPendingInput,
      computeScoreCore(afterPendingInput, repo, snapshot, contributorEvidence),
      [
        userPendingCount > 0
          ? `${userPendingCount} user-supplied pending approved/merged/closed PR(s) are treated as no longer open for this scenario.`
          : "No pending merge/close count was supplied; this scenario preserves current open PR pressure.",
        ...(input.projectedCredibility !== undefined
          ? [`Projected credibility is user-supplied as ${roundScore(projectedCredibility)}.`]
          : userPendingCount > 0
            ? [`Projected credibility is raised to the current floor ${current.gates.credibilityFloor} because pending merges were supplied by the caller.`]
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
        observedCloseCount > 0
          ? `${observedCloseCount} GitHub-observed stale or closed PR(s) are treated as no longer open if they close or withdraw.`
          : "No GitHub-observed stale or closed PRs were available for this scenario.",
        "Credibility is not increased in this scenario because stale or closed PR cleanup is not the same as merged work.",
        ...observedScenarioNotes(input),
      ],
      repo,
    ),
    scenario("linkedIssueFixed", "gittensory_projection", linkedIssueInput, computeScoreCore(linkedIssueInput, repo, snapshot, contributorEvidence), [
      input.linkedIssueMode === "none" || !input.linkedIssueMode
        ? "A standard linked-issue/no-issue rationale multiplier is projected as present."
        : "Linked issue mode was already supplied; this scenario is unchanged.",
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
    gates: core.gates,
    effectiveEstimatedScore: core.scoreEstimate.estimatedMergedScore,
    underlyingPotentialScore: core.scoreEstimate.pendingSaturationScore,
    blockedBy,
    deltaExplanation: deltaExplanationFor(core, blockedBy),
  };
}

function blockedByFor(input: ScorePreviewInput, repo: RepositoryRecord | null, core: ScoreCore): ScoreGateBlocker[] {
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
  ];
}

function buildGateDeltas(current: ScoreCore, scenarios: ScoreScenarioPreview[]): ScoreGateDelta[] {
  const currentScenario = scenarios[0];
  if (!currentScenario) return [];
  const best = scenarios.find((scenarioPreview) => scenarioPreview.name === "bestReasonableCase") ?? currentScenario;
  const linked = scenarios.find((scenarioPreview) => scenarioPreview.name === "linkedIssueFixed") ?? best;
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

function warningsFor(input: ScorePreviewInput, repo: RepositoryRecord | null, core: ScoreCore): string[] {
  return blockedByFor(input, repo, core).map((blocker) => blocker.detail);
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

function selectIssueMultiplier(mode: "none" | "standard" | "maintainer", constants: Record<string, number>): number {
  if (mode === "maintainer") return constant(constants, "MAINTAINER_ISSUE_MULTIPLIER", 1.66);
  if (mode === "standard") return constant(constants, "STANDARD_ISSUE_MULTIPLIER", 1.33);
  return 1;
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

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}
