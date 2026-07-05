// Barrel export for @jsonbored/gittensory-engine.
//
// This package houses the deterministic, side-effect-free logic shared by the Gittensory review-stack
// backend and the gittensory-miner (scoring preview/model, predicted-gate types, reward-risk, slop signals,
// focus-manifest parse/compile core, duplicate-winner adjudication, and their engine-parity fixtures).
// More modules land in follow-up issues.
export {
  pickTopRankedOpportunities,
  rankOpportunityScore,
  rankOpportunities,
  type OpportunityRankInput,
} from "./opportunity-ranker.js";
export { rankOpportunitiesAtOrAboveScore } from "./ranked-opportunity-min-score.js";
export { pickTopRankedOpportunitiesAtOrAboveScore } from "./ranked-opportunity-top-min-score.js";
export { bestRankedOpportunity } from "./ranked-opportunity-best-pick.js";
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
