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
export * from "./governor/rate-limit.js";
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
export { computeOpportunityCompetition } from "./opportunity-competition.js";
export {
  computeLaneFit,
  type GoalModelInput,
} from "./goal-model.js";
  classifyContributorFit,
  type ContributorFit,
  type ContributorFitCheck,
  type ContributorFitProfile,
} from "./contributor-fit.js";
export {
  computeOpportunityFreshness,
  type FreshnessIssue,
} from "./opportunity-freshness.js";
export {
  buildMetadataRankInput,
  computeMetadataDupRisk,
  computeMetadataFeasibility,
  computeMetadataPotential,
  rankMetadataOpportunities,
  type MetadataCandidateIssue,
  type MetadataRankContext,
} from "./opportunity-metadata.js";
