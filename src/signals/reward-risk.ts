// Reward/risk reasoning signals, extracted to `@jsonbored/gittensory-engine` (#2281) so the gittensory-miner
// can rank candidate work locally with the same logic the maintainer-side gate computes. The implementation
// lives at `packages/gittensory-engine/src/reward-risk.ts`, imported via its RELATIVE SOURCE PATH (matching
// the merged #2276/#2278/#2282 shims) — not the published `@jsonbored/gittensory-engine` specifier, so no
// tsconfig path / vitest alias / root dependency is introduced.
//
// This is a WRAPPING shim rather than the usual pure `export *` re-export. reward-risk depends on the
// maintainer signal stack in `src/signals/engine.ts` (`buildRoleContext`, `buildLaneAdvice`,
// `buildCollisionReport`, `buildQueueHealth`, `buildRepoFitRecommendation`, `buildContributorIntakeHealth`,
// `buildPullRequestReviewIntelligence`) — none of which are extracted yet (and are far too large to port
// under the size cap). `isFailingCheckSummary` now lives in `@jsonbored/gittensory-engine` (#4256). The
// engine module takes the remaining builders as an
// injected `RewardRiskEngineDeps`; this shim binds the real `src` builders and threads them in, so every
// existing importer keeps calling the four builders with their original signatures. Once those builders gain
// engine homes, a follow-up can drop the injection and collapse this back to a plain re-export.
import {
  buildContributorRewardRiskStrategy as engineBuildContributorRewardRiskStrategy,
  buildMaintainerNoiseReport as engineBuildMaintainerNoiseReport,
  buildPullRequestReviewability as engineBuildPullRequestReviewability,
  buildRepoRewardRisk as engineBuildRepoRewardRisk,
  type RewardRiskEngineDeps,
} from "../../packages/gittensory-engine/src/reward-risk.js";
import {
  buildCollisionReport,
  buildContributorIntakeHealth,
  buildLaneAdvice,
  buildPullRequestReviewIntelligence,
  buildQueueHealth,
  buildRepoFitRecommendation,
  buildRoleContext,
} from "./engine";
export type {
  ContributorRewardRiskStrategy,
  EligibilityGapEntry,
  MaintainerNoiseReport,
  PullRequestReviewability,
  RepoRewardRisk,
  RewardRiskAction,
  RewardRiskActionKind,
  RewardRiskActionSeverity,
} from "../../packages/gittensory-engine/src/reward-risk.js";
export { rewardRiskFreshnessInternals } from "../../packages/gittensory-engine/src/reward-risk.js";

// The real `src`-side builders, bound once and injected into the engine implementations. Their argument
// records are wider than (assignable to) the engine's subset mirrors and their return types are covariantly
// assignable to the engine's narrowed views, so the whole object type-checks with no casts. The runtime
// objects the builders receive are the caller's originals, so behavior is identical to the pre-extraction file.
const deps: RewardRiskEngineDeps = {
  buildRoleContext,
  buildLaneAdvice,
  buildCollisionReport,
  buildQueueHealth,
  buildRepoFitRecommendation,
  buildContributorIntakeHealth,
  buildPullRequestReviewIntelligence,
};

export function buildRepoRewardRisk(
  args: Parameters<typeof engineBuildRepoRewardRisk>[0],
): ReturnType<typeof engineBuildRepoRewardRisk> {
  return engineBuildRepoRewardRisk(args, deps);
}

export function buildContributorRewardRiskStrategy(
  args: Parameters<typeof engineBuildContributorRewardRiskStrategy>[0],
): ReturnType<typeof engineBuildContributorRewardRiskStrategy> {
  return engineBuildContributorRewardRiskStrategy(args, deps);
}

export function buildMaintainerNoiseReport(
  repo: Parameters<typeof engineBuildMaintainerNoiseReport>[0],
  issues: Parameters<typeof engineBuildMaintainerNoiseReport>[1],
  pullRequests: Parameters<typeof engineBuildMaintainerNoiseReport>[2],
  recentMergedPullRequests: Parameters<typeof engineBuildMaintainerNoiseReport>[3],
  fullName: Parameters<typeof engineBuildMaintainerNoiseReport>[4],
): ReturnType<typeof engineBuildMaintainerNoiseReport> {
  return engineBuildMaintainerNoiseReport(repo, issues, pullRequests, recentMergedPullRequests, fullName, deps);
}

export function buildPullRequestReviewability(
  args: Parameters<typeof engineBuildPullRequestReviewability>[0],
): ReturnType<typeof engineBuildPullRequestReviewability> {
  return engineBuildPullRequestReviewability(args, deps);
}
