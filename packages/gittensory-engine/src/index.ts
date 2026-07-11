// Barrel export for @jsonbored/gittensory-engine.
//
// This package houses the deterministic, side-effect-free logic shared by the Gittensory review-stack
// backend and the gittensory-miner (scoring preview/model, predicted-gate types, reward-risk, slop signals,
// focus-manifest parse/compile core, duplicate-winner adjudication, and their engine-parity fixtures).
// More modules land in follow-up issues.
export { ENGINE_VERSION } from "./version.js";
export {
  pickTopRankedOpportunities,
  rankOpportunityScore,
  rankOpportunities,
  type OpportunityRankInput,
} from "./opportunity-ranker.js";
export { rankOpportunitiesAtOrAboveScore } from "./ranked-opportunity-min-score.js";
export { pickTopRankedOpportunitiesAtOrAboveScore } from "./ranked-opportunity-top-min-score.js";
export { bestRankedOpportunity } from "./ranked-opportunity-best-pick.js";
export { bestRankedOpportunityAtOrAboveScore } from "./ranked-opportunity-best-min-score.js";
export {
  extractObjectiveAnchorHistory,
  extractObjectiveAnchorFeatures,
  scoreObjectiveAnchor,
  scoreObjectiveAnchorHistory,
  renderObjectiveAnchorAuditMarkdown,
  type ObjectiveAnchorAudit,
  type ObjectiveAnchorChangeKind,
  type ObjectiveAnchorDimensionScores,
  type ObjectiveAnchorFeatures,
  type ObjectiveAnchorHistoryExtraction,
  type ObjectiveAnchorHistoryItem,
  type ObjectiveAnchorHistoryItemAudit,
  type ObjectiveAnchorHistoryScore,
  type ObjectiveAnchorInput,
  type ObjectiveAnchorScore,
  type ObjectiveAnchorWeights,
} from "./objective-anchor.js";
export {
  computePairwiseCalibrationScore,
  resolvePairwiseCalibrationSample,
  type PairwiseCalibrationAttempt,
  type PairwiseCalibrationResolvedSample,
  type PairwiseCalibrationScore,
  type PairwiseCalibrationVerdict,
  type PairwiseCalibrationWeights,
} from "./pairwise-calibration.js";
export {
  computeGateVerdictCompositeCalibrationScore,
  ingestGateVerdictCalibrationSignals,
  renderGateVerdictCalibrationAuditMarkdown,
  resolveGateVerdictCalibrationConfig,
  type GateVerdictCalibrationConfig,
  type GateVerdictCalibrationDimension,
  type GateVerdictCalibrationDimensionInput,
  type GateVerdictCalibrationDimensionSignal,
  type GateVerdictCalibrationIngestion,
  type GateVerdictCalibrationManifest,
  type GateVerdictCalibrationOutcome,
  type GateVerdictCalibrationSignal,
  type GateVerdictCalibrationSignalInput,
  type GateVerdictCalibrationWeights,
  type GateVerdictCompositeCalibrationScore,
} from "./gate-verdict-calibration.js";
export {
  computePhase7CalibrationLoop,
  computePrOutcomeCalibrationAccuracy,
  DOCUMENTED_CALIBRATION_BASELINE,
  evaluateAutonomyIncreaseEligibility,
  isHistoricalReplayRunFresh,
  renderPhase7CalibrationAuditMarkdown,
  resolvePhase7CalibrationConfig,
  shouldScheduleHistoricalReplayRun,
  type CalibrationSignalSource,
  type CalibrationSourceMetric,
  type HistoricalReplayCalibrationInput,
  type Phase7CalibrationConfig,
  type Phase7CalibrationLoopResult,
  type Phase7CalibrationManifest,
  type PrOutcomeCalibrationInput,
  type ReplayHarnessStatus,
} from "./phase7-calibration-loop.js";
export {
  buildCalibrationDashboardView,
  resolveCalibrationDashboardStatus,
  type CalibrationDashboardRow,
  type CalibrationDashboardStatus,
  type CalibrationDashboardView,
} from "./calibration-dashboard.js";
export {
  buildCalibrationTrendView,
  calibrationSnapshotFromResult,
  type CalibrationTrendDirection,
  type CalibrationTrendPoint,
  type CalibrationTrendSnapshot,
  type CalibrationTrendView,
} from "./calibration-trend.js";
export {
  computeFindingSeverityCompositeCalibrationScore,
  ingestFindingSeverityCalibrationSignals,
  renderFindingSeverityCalibrationAuditMarkdown,
  resolveFindingSeverityCalibrationConfig,
  type FindingSeverityCalibrationConfig,
  type FindingSeverityCalibrationIngestion,
  type FindingSeverityCalibrationManifest,
  type FindingSeverityCalibrationSignal,
  type FindingSeverityCalibrationSignalInput,
  type FindingSeverityCalibrationWeights,
  type FindingSeverityCompositeCalibrationScore,
  type FindingSeverityTier,
  type FindingSeverityTierInput,
  type FindingSeverityTierSignal,
} from "./finding-severity-calibration.js";
export {
  computeReviewerConsensusCompositeCalibrationScore,
  ingestReviewerConsensusCalibrationSignals,
  renderReviewerConsensusCalibrationAuditMarkdown,
  resolveReviewerConsensusCalibrationConfig,
  type ReviewerConsensusCalibrationConfig,
  type ReviewerConsensusCalibrationIngestion,
  type ReviewerConsensusCalibrationManifest,
  type ReviewerConsensusCalibrationSignal,
  type ReviewerConsensusCalibrationSignalInput,
  type ReviewerConsensusCalibrationWeights,
  type ReviewerConsensusCompositeCalibrationScore,
  type ReviewerConsensusDimension,
  type ReviewerConsensusDimensionInput,
  type ReviewerConsensusDimensionSignal,
  type ReviewerConsensusVote,
} from "./reviewer-consensus-calibration.js";
export {
  computeTrackRecordSummary,
  renderTrackRecordSummaryMarkdown,
  resolveTrackRecordSummaryConfig,
  shouldIncludeTrackRecordSummary,
  type TrackRecordIncidentKind,
  type TrackRecordIncidentRecord,
  type TrackRecordIncidentStatus,
  type TrackRecordMergeRate,
  type TrackRecordPullRequestOutcome,
  type TrackRecordPullRequestState,
  type TrackRecordSummary,
  type TrackRecordSummaryAudit,
  type TrackRecordSummaryConfig,
  type TrackRecordSummaryManifest,
  type TrackRecordSummaryOutcomeCounts,
  type TrackRecordTenure,
} from "./track-record-summary.js";
export * from "./governor/rate-limit.js";
export * from "./governor/budget-cap.js";
export * from "./governor/self-plagiarism.js";
export * from "./governor/reputation-throttle.js";
export * from "./governor/write-rate-limit.js";
export * from "./governor/run-halt.js";
export {
  GOVERNOR_LEDGER_EVENT_TYPES,
  normalizeGovernorLedgerEvent,
  type GovernorLedgerEvent,
  type GovernorLedgerEventType,
  type NormalizedGovernorLedgerEvent,
} from "./governor-ledger.js";
export {
  MINER_TELEMETRY_EVENT_TYPES,
  MINER_TELEMETRY_OUTCOME_BUCKETS,
  normalizeMinerTelemetryEvent,
  type MinerTelemetryEvent,
  type MinerTelemetryEventType,
  type MinerTelemetryOutcomeBucket,
  type NormalizedMinerTelemetryEvent,
} from "./miner-telemetry.js";
export {
  MINER_PREDICTIONS_TOTAL,
  MINER_PREDICTION_CORRECT_TOTAL,
  MINER_PREDICTION_INCORRECT_TOTAL,
  renderMinerPredictionMetrics,
  type MinerPredictionMetricRow,
} from "./miner-prediction-metrics.js";
export {
  ATTEMPT_LOG_EVENT_TYPES,
  createAttemptLogBuffer,
  formatAttemptLogJsonl,
  normalizeAttemptLogEvent,
  type AttemptLogEvent,
  type AttemptLogEventType,
  type NormalizedAttemptLogEvent,
} from "./miner/attempt-log.js";
export {
  ACCEPTANCE_CRITERIA_FILENAME,
  ACCEPTANCE_CRITERIA_VERSION,
  buildAcceptanceCriteria,
  serializeAcceptanceCriteria,
  shouldWriteAcceptanceCriteria,
  type AcceptanceCriteria,
  type AcceptanceCriteriaInput,
} from "./miner/acceptance-criteria.js";
export {
  codingAgentModeExecutes,
  isGlobalMinerCodingAgentPause,
  resolveCodingAgentExecutionMode,
  resolveCodingAgentModeFromConfig,
  type CodingAgentExecutionMode,
} from "./miner/coding-agent-mode.js";
export {
  createFakeCodingAgentDriver,
  createNoopCodingAgentDriver,
  type CodingAgentDriver,
  type CodingAgentDriverResult,
  type CodingAgentDriverTask,
} from "./miner/coding-agent-driver.js";
export {
  createCliSubprocessCodingAgentDriver,
  defaultCliSubprocessArgs,
  type CliSubprocessDriverOptions,
  type CliSubprocessSpawnFn,
} from "./miner/cli-subprocess-driver.js";
export {
  addWorktree,
  planWorktree,
  removeWorktree,
  shouldRetainWorktree,
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_SUBDIR,
  type WorktreeAddResult,
  type WorktreeExecFn,
  type WorktreeExecResult,
  type WorktreePlan,
  type WorktreeRemoveResult,
} from "./miner/worktree-allocator.js";
export * from "./miner/worktree-pool.js";
export {
  invokeCodingAgentDriver,
  type AttemptLogSink,
} from "./miner/coding-agent-invoke.js";
export {
  classifyLintGuardPackage,
  guardChangedFiles,
  guardCodingAgentDriverResult,
  type LintGuardCheckResult,
  type LintGuardedDriverResult,
  type LintGuardOptions,
  type LintGuardPackage,
  type LintGuardResult,
  type LintGuardSpawnFn,
} from "./miner/lint-guard.js";
export {
  CODING_AGENT_DRIVER_CONFIG_ENV,
  CODING_AGENT_DRIVER_NAMES,
  createCodingAgentDriver,
  createFakeCodingAgentDriverForFactory,
  isConfiguredCodingAgentDriver,
  resolveConfiguredCodingAgentDriverNames,
  resolveFirstConfiguredCodingAgentDriverName,
  runCodingAgentAttempt,
  type CodingAgentDriverName,
  type CreateCodingAgentDriverOptions,
  type RunCodingAgentAttemptOptions,
} from "./miner/driver-factory.js";
export * from "./miner/attempt-metering.js";
export {
  buildRepoMap,
  extractRepoMapSymbols,
  renderRepoMap,
  resolveRepoMapLanguage,
  type BuildRepoMapOptions,
  type ExtractRepoMapSymbolsOptions,
  type LoadRepoMapLanguageFn,
  type RepoMapFileEntry,
  type RepoMapSkipReason,
  type RepoMapSourceFile,
  type RepoMapSymbol,
  type RepoMapSymbolKind,
} from "./miner/repo-map.js";
export {
  createAgentSdkCodingAgentDriver,
  type AgentSdkHooks,
  type AgentSdkQueryFn,
  type AgentSdkQueryOptions,
  type CreateAgentSdkDriverOptions,
} from "./miner/agent-sdk-driver.js";
export * from "./plan-export.js";
export { countPlanStepsByStatus } from "./plan-step-stats.js";
export { countPlanSteps } from "./plan-step-count.js";
export { isPlanEmpty } from "./plan-empty.js";
export { isPlanFullyCompleted } from "./plan-completion.js";
export { hasPlanFailedSteps } from "./plan-failure.js";
export { hasPlanPendingSteps } from "./plan-pending.js";
export { hasPlanRunningSteps } from "./plan-running.js";
export { hasPlanSkippedSteps } from "./plan-skipped.js";
export { hasPlanCompletedSteps } from "./plan-completed.js";
export { isPlanBlocked } from "./plan-blocked.js";
export { isPlanProgressComplete } from "./plan-progress-complete.js";
export {
  resolvePlanOverallStatus,
  type PlanOverallStatus,
} from "./plan-overall-status.js";
export { hasPlanReadySteps } from "./plan-ready.js";
export { isPlanTerminated } from "./plan-terminated.js";
export * from "./plan-templates.js";
export * from "./issue-plan-decomposition.js";
export {
  PROMPT_PACKET_REDACTED_PATH,
  PROMPT_PACKET_REDACTED_TERM,
  PROMPT_PACKET_TEXT_FIELDS,
  buildPromptPacket,
  sanitizePromptPacketField,
  type PromptPacket,
  type PromptPacketInput,
  type PromptPacketTextField,
} from "./prompt-packet.js";
export * from "./portfolio/queue.js";
export * from "./portfolio/non-convergence.js";
export {
  applyAiPolicyFatigueToRankInput,
  createAiPolicyFatigueCacheEntry,
  describeAiPolicyFatigueCache,
  renderAiPolicyFatigueMarkdown,
  resolveAiPolicyFatigueVerdict,
  resolveAiPolicyVerdict,
  scanAiPolicyText,
  type AiFatigueDocLanguageChange,
  type AiFatiguePullRequestMetadata,
  type AiPolicyFatigueRankAdjustment,
  type AiPolicyFatigueRankInput,
  type AiPolicyFatigueCacheEntry,
  type AiPolicyFatigueCacheState,
  type AiPolicyFatigueEvidence,
  type AiPolicyFatigueEvidenceKind,
  type AiPolicyFatigueInput,
  type AiPolicyFatigueLevel,
  type AiPolicyFatigueVerdict,
  type AiPolicyPriorityAdjustment,
  type AiPolicySource,
  type AiPolicyVerdict,
} from "./ai-policy-map.js";
export {
  DEFAULT_MINER_GOAL_SPEC,
  parseMinerGoalSpec,
  parseMinerGoalSpecContent,
  discoverMinerGoalSpecPath,
  MINER_GOAL_SPEC_FILENAMES,
  type FeasibilityGatePolicy,
  type MinerGoalSpec,
  type MinerIssueDiscoveryPolicy,
  type ParsedMinerGoalSpec,
} from "./miner-goal-spec.js";
export {
  DEFAULT_FLEET_RUN_MANIFEST,
  parseFleetRunManifest,
  parseFleetRunManifestContent,
  type FleetRunManifest,
  type FleetRunManifestRepo,
  type ParsedFleetRunManifest,
} from "./fleet-run-manifest.js";
export {
  DISCOVERY_INDEX_CONTRACT_VERSION,
  DISCOVERY_INDEX_FORBIDDEN_FIELDS,
  discoveryIndexBoundaryViolations,
  normalizeDiscoveryIndexCandidate,
  normalizeDiscoveryIndexRequest,
  normalizeDiscoveryIndexResponse,
  type DiscoveryIndexAiPolicySource,
  type DiscoveryIndexCandidate,
  type DiscoveryIndexQuery,
  type DiscoveryIndexRequest,
  type DiscoveryIndexResponse,
  type ParsedDiscoveryIndexRequest,
  type ParsedDiscoveryIndexResponse,
} from "./discovery-index-contract.js";
export {
  buildSoftClaimRequest,
  softClaimActionForStatus,
  type SoftClaimAction,
  type SoftClaimRecord,
  type SoftClaimRequest,
  type SoftClaimRequestContext,
  type SoftClaimStatus,
} from "./discovery-soft-claim.js";
export {
  computeMetadataLaneFit,
  computeMinerGoalLaneFit,
  isMinerRepoTargetable,
} from "./miner-goal-lane-fit.js";
export {
  computeOpportunityFreshness,
  type FreshnessIssue,
} from "./opportunity-freshness.js";
export { computeOpportunityCompetition } from "./opportunity-competition.js";
export { computeLaneFit, type GoalModelInput } from "./goal-model.js";
export {
  classifyContributorFit,
  type ContributorFit,
  type ContributorFitCheck,
  type ContributorFitProfile,
} from "./contributor-fit.js";
export {
  buildFeasibilityVerdict,
  feasibilityInputFromPreStartCheck,
  type FeasibilityClaimStatus,
  type FeasibilityDuplicateClusterRisk,
  type FeasibilityGateInput,
  type FeasibilityGateResult,
  type FeasibilityIssueStatus,
  type FeasibilityVerdict,
} from "./feasibility.js";
export {
  F1_COMPLEX_IDEA_EXAMPLE,
  F1_SIMPLE_IDEA_EXAMPLE,
  IDEA_INTAKE_BRIDGE_VERSION,
  IDEA_INTAKE_MAX_IDEA_CHARS,
  expectedF1ComplexTaskGraph,
  expectedF1SimpleTaskGraph,
  translateIdeaToTaskGraph,
  translateIdeaToTaskGraphOrThrow,
  validateIdeaSubmission,
  validateIdeaTaskGraph,
  type IdeaIntakeError,
  type IdeaIntakeFailure,
  type IdeaIntakeResult,
  type IdeaIntakeSuccess,
  type IdeaSubmissionInput,
  type IdeaTaskClaimableUnit,
  type IdeaTaskGraph,
  type IdeaTaskGraphNode,
  type IdeaTaskScoringDimension,
  type IdeaTaskScoringRubric,
} from "./idea-intake-bridge.js";
export {
  buildMetadataRankInput,
  computeMetadataDupRisk,
  computeMetadataFeasibility,
  computeMetadataPotential,
  rankMetadataOpportunities,
  type MetadataCandidateIssue,
  type MetadataRankContext,
} from "./opportunity-metadata.js";
export { pickTopMetadataOpportunities } from "./metadata-top-pick.js";
export { rankMetadataOpportunitiesAtOrAboveScore } from "./metadata-min-score.js";
export { pickTopMetadataOpportunitiesAtOrAboveScore } from "./metadata-top-min-score.js";
export { bestMetadataOpportunity } from "./metadata-best-pick.js";
export { bestMetadataOpportunityAtOrAboveScore } from "./metadata-best-min-score.js";
// Score-preview machinery (#2282): namespaced (rather than flattened) so the three ported files keep their
// own identity and cannot collide with each other or the ~50 other top-level exports above.
export * as scoringModel from "./scoring/model.js";
export * as scoringPreview from "./scoring/preview.js";
export * as scoringPendingPrScenarios from "./scoring/pending-pr-scenarios.js";
export {
  isDuplicateClusterWinner,
  isDuplicateClusterWinnerByClaim,
  resolveDuplicateClusterWinnerNumber,
  type DuplicateClaimMember,
} from "./duplicate-winner.js";
// Issue-centric RAG query composition (#2320, extracted in #4254): the pure query builder + the shared
// minimum-query floor; the Vectorize/D1 retrieval backend intentionally stays in the backend.
export {
  MIN_QUERY_CHARS,
  buildIssueRagQuery,
  type IssueRagQueryInput,
} from "./issue-rag-query.js";
// #782 deterministic local scorer (extracted in #4253): pure token-scoring from changed-file metadata,
// shared by the published CLIs and the hosted Worker. The Node-coupled local-branch.ts stays in the backend.
export {
  computeLocalScorerTokens,
  type LocalScorerChangedFile,
  type LocalScorerValidation,
  type LocalScorerResult,
} from "./local-scorer.js";
export {
  buildPredictedGateVerdict,
  predictedGateNote,
  publicSafeFinding,
  type GateCheckConclusion,
  type GatePolicyPack,
  type PredictedGateInput,
  type PredictedGateVerdict,
} from "./predicted-gate.js";
// Focus-manifest parse/compile core (#2280): shared by the maintainer review stack and the miner's
// `.gittensory-miner.yml` goal-spec parser (see miner-goal-spec.ts for the parallel surface).
export {
  compileFocusManifestPolicy,
  contentLaneConfigToJson,
  featuresConfigToJson,
  formatManifestValidationNotice,
  gateConfigToJson,
  isFocusManifestPublicSafe,
  matchesManifestPath,
  normalizeReadinessGateMode,
  parseFocusManifest,
  parseFocusManifestContent,
  repoDocGenerationConfigToJson,
  reviewConfigToJson,
  reviewRecapConfigToJson,
  maintainerRecapConfigToJson,
  settingsOverrideToJson,
  MAX_FOCUS_MANIFEST_BYTES,
  CONVERGED_FEATURE_KEYS,
  COMMENT_VERBOSITY_LEVELS,
  EMPTY_AUTO_REVIEW_CONFIG,
  EMPTY_MAX_FINDINGS_CONFIG,
  EMPTY_SELF_HOST_AI_MODEL_CONFIG,
  EMPTY_VISUAL_CONFIG,
  LINKED_ISSUE_SATISFACTION_MODES,
  REVIEW_FIELD_KEYS,
  REVIEW_FINDING_SEVERITY_LADDER,
  REVIEW_PROFILES,
  type AutoReviewConfig,
  type CommentVerbosity,
  type ConvergedFeatureKey,
  type FocusManifest,
  type FocusManifestContentLaneConfig,
  type FocusManifestFeaturesConfig,
  type FocusManifestGateConfig,
  type FocusManifestIssueDiscoveryPolicy,
  type FocusManifestLanePreference,
  type FocusManifestLinkedIssuePolicy,
  type FocusManifestPolicy,
  type FocusManifestPolicyContributionLane,
  type FocusManifestPolicyLabelPolicy,
  type FocusManifestPolicyValidation,
  type FocusManifestRepoDocGenerationConfig,
  type FocusManifestRepoDocGenerationScope,
  type FocusManifestReviewConfig,
  type FocusManifestReviewRecapConfig,
  type FocusManifestMaintainerRecapConfig,
  type FocusManifestSettings,
  type FocusManifestSource,
  type LinkedIssueSatisfactionMode,
  type MaxFindingsConfig,
  type PreMergeCheck,
  type ReviewFieldKey,
  type ReviewFindingSeverity,
  type ReviewPathInstruction,
  type ReviewProfile,
  type SelfHostAiModelConfig,
  type VisualConfig,
  type VisualPreviewConfig,
  type VisualRoutesConfig,
  type VisualTheme,
} from "./focus-manifest.js";
// Reward/risk reasoning signals (#2281). The four builders depend on the still-in-`src` maintainer signal
// stack, so they take an injected `RewardRiskEngineDeps` (the `src/signals/reward-risk.ts` shim binds it).
export {
  buildRepoRewardRisk,
  buildContributorRewardRiskStrategy,
  buildMaintainerNoiseReport,
  buildPullRequestReviewability,
  rewardRiskFreshnessInternals,
  type RewardRiskEngineDeps,
  type PullRequestReviewabilityInput,
  type PullRequestReviewIntelligenceView,
  type RewardRiskAction,
  type RewardRiskActionKind,
  type RewardRiskActionSeverity,
  type RepoRewardRisk,
  type EligibilityGapEntry,
  type ContributorRewardRiskStrategy,
  type MaintainerNoiseReport,
  type PullRequestReviewability,
} from "./reward-risk.js";

// Shared subprocess env-allowlist + secret-redaction helpers (#4284) — one source of truth for every driver that
// spawns a locally-authenticated CLI subprocess (src/selfhost/ai.ts and the coming gittensory-miner drivers).
export {
  SUBPROCESS_CLI_ENV_ALLOWLIST,
  buildAllowlistedEnv,
  SECRET_PATTERNS,
  redactSecrets,
} from "./subprocess-env.js";
