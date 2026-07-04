// Barrel export for @jsonbored/gittensory-engine.
//
// This package houses the deterministic, side-effect-free logic shared by the Gittensory review-stack
// backend and the gittensory-miner (scoring preview/model, predicted-gate types, reward-risk, slop signals,
// focus-manifest parse/compile core, duplicate-winner adjudication, and their engine-parity fixtures).
// More modules land in follow-up issues.
export {
  rankOpportunityScore,
  rankOpportunities,
  type OpportunityRankInput,
} from "./opportunity-ranker.js";
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
  resolveAiPolicyVerdict,
  scanAiPolicyText,
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
