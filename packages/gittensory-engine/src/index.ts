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
export {
  GOVERNOR_LEDGER_EVENT_TYPES,
  normalizeGovernorLedgerEvent,
  type GovernorLedgerEvent,
  type GovernorLedgerEventType,
  type NormalizedGovernorLedgerEvent,
} from "./governor-ledger.js";
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
export { resolvePlanOverallStatus, type PlanOverallStatus } from "./plan-overall-status.js";
export { hasPlanReadySteps } from "./plan-ready.js";
export { isPlanTerminated } from "./plan-terminated.js";
export * from "./plan-templates.js";
export * from "./portfolio/queue.js";
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
  type MinerGoalSpec,
  type MinerIssueDiscoveryPolicy,
  type ParsedMinerGoalSpec,
} from "./miner-goal-spec.js";
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
export {
  computeLaneFit,
  type GoalModelInput,
} from "./goal-model.js";
export {
  classifyContributorFit,
  type ContributorFit,
  type ContributorFitCheck,
  type ContributorFitProfile,
} from "./contributor-fit.js";
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
// Predicted-gate type surface + pure helpers (#2276): a miner models its own gate verdict with the same
// shapes the maintainer gate uses; buildPredictedGateVerdict itself follows in #2283.
export {
  predictedGateNote,
  publicSafeFinding,
  type GateCheckConclusion,
  type GatePolicyPack,
  type PredictedGateInput,
  type PredictedGateVerdict,
} from "./predicted-gate.js";
