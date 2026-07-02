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
export * from "./portfolio/queue.js";
export {
  resolveAiPolicyVerdict,
  scanAiPolicyText,
  type AiPolicySource,
  type AiPolicyVerdict,
} from "./ai-policy-map.js";
export {
  DEFAULT_MINER_GOAL_SPEC,
  type MinerGoalSpec,
  type MinerIssueDiscoveryPolicy,
} from "./miner-goal-spec.js";
