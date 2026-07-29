// #543 outcome-learning loop: calibrate loopover's predictions against real merge/close outcomes.
//
// MEASUREMENT only — it never auto-adjusts a score (that would move live rankings; like time-decay it would
// need owner review). It answers two questions a maintainer/operator can act on:
//   • Is the deterministic slop score PREDICTIVE? For resolved PRs that carry a persisted slop band, do
//     higher-slop bands actually merge less often? (`discriminates`).
//   • Are loopover's recommendations panning out? The positive vs negative outcome split from the agent
//     recommendation-outcome ledger.
// All inputs already exist: slop_band persists on the PR row (#726) + closed PRs are retained, and the
// agent_recommendation_outcomes ledger (#543's recommendation half) is populated by evaluateRecommendationOutcomes.
import { listAgentRecommendationOutcomes, listPullRequests } from "../db/repositories";
import type { SlopBand } from "../signals/slop";
import type { AgentRecommendationOutcomeRecord, AgentRecommendationOutcomeState, PullRequestRecord } from "../types";
import { nowIso } from "../utils/json";

// The single place the recommendation-outcome states are grouped into positive/negative/pending. Both
// aggregators over the agent_recommendation_outcomes ledger — this module and recommendation-quality-report.ts,
// which imports these — must classify identically, so a window of unactioned (stale/ignored) recommendations
// can't read as a 100% success rate here and a 50% failure rate there (#9701).
export const RECOMMENDATION_POSITIVE_STATES: readonly AgentRecommendationOutcomeState[] = ["accepted", "merged", "improved"];
export const RECOMMENDATION_NEGATIVE_STATES: readonly AgentRecommendationOutcomeState[] = ["rejected", "closed"];
export const RECOMMENDATION_PENDING_STATES: readonly AgentRecommendationOutcomeState[] = ["stale", "ignored"];

// Severity order — calibration checks that merge rate is non-increasing along it.
const SLOP_BAND_ORDER: readonly SlopBand[] = ["clean", "low", "elevated", "high"];
// Below this per-band sample the merge rate is too noisy to judge discrimination.
const MIN_BAND_SAMPLE = 5;

export type SlopBandCalibration = { band: SlopBand; sampleSize: number; merged: number; closed: number; mergeRate: number };

export type SlopOutcomeCalibration = {
  totalResolved: number;
  bands: SlopBandCalibration[];
  overallMergeRate: number | null;
  /** True iff the score discriminates (merge rate non-increasing as band severity rises) given enough
   *  per-band sample; false iff it inverts; null iff there isn't enough resolved data to judge. */
  discriminates: boolean | null;
};

export type RecommendationOutcomeCalibration = { total: number; positive: number; negative: number; pending: number; positiveRate: number | null };

export type RecommendationOutcomeCalibrationOptions = {
  /** Only maintainer-lane outcomes are authoritative enough for live self-tune policy changes. */
  maintainerOnly?: boolean | undefined;
  /** Exclude maintainer-authored PRs (author_association OWNER/MEMBER/COLLABORATOR) from the SLOP half of the
   *  report. Maintainer PRs merge by human judgment regardless of score (the same population
   *  settings-preview.ts's `includeMaintainerAuthors` already excludes from the public surface by default), so
   *  pooling them with contributor PRs can invert a merge-rate-by-band comparison in any repo the maintainer is
   *  heavily active in without the deterministic score itself being wrong. Off by default so every existing
   *  caller (dashboards, the MCP tool, the public API route) stays byte-identical; mirrors the miner/human
   *  `cohorts` split gate-precision.ts already applies to the sibling #554 false-positive measurement, for the
   *  same reason. */
  excludeMaintainerAuthors?: boolean | undefined;
};

export type OutcomeCalibration = {
  repoFullName: string;
  generatedAt: string;
  windowDays: number | null;
  slop: SlopOutcomeCalibration;
  recommendations: RecommendationOutcomeCalibration;
  signals: string[];
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// A PR's terminal outcome for calibration: merged if it has a merge timestamp; closed (unmerged) if its
// state is closed without one; otherwise still open (excluded — no outcome yet).
function terminalOutcome(pr: PullRequestRecord): "merged" | "closed" | null {
  if (pr.mergedAt) return "merged";
  if (pr.state === "closed") return "closed";
  return null;
}

// Same OWNER/MEMBER/COLLABORATOR classification settings-preview.ts's includeMaintainerAuthors check already
// uses to exclude this population from the public surface by default.
const MAINTAINER_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function isMaintainerAuthoredPr(pr: PullRequestRecord): boolean {
  return pr.authorAssociation != null && MAINTAINER_AUTHOR_ASSOCIATIONS.has(pr.authorAssociation);
}

/** Per-slop-band merge/close calibration over the resolved PRs that carry a slop assessment. Pure. */
export function buildSlopOutcomeCalibration(pullRequests: PullRequestRecord[], options: RecommendationOutcomeCalibrationOptions = {}): SlopOutcomeCalibration {
  const scoped = options.excludeMaintainerAuthors ? pullRequests.filter((pr) => !isMaintainerAuthoredPr(pr)) : pullRequests;
  const counts = new Map<SlopBand, { merged: number; closed: number }>();
  let totalMerged = 0;
  let totalResolved = 0;
  for (const pr of scoped) {
    if (typeof pr.slopRisk !== "number" || !pr.slopBand) continue; // never assessed
    const band = pr.slopBand as SlopBand;
    if (!SLOP_BAND_ORDER.includes(band)) continue;
    const outcome = terminalOutcome(pr);
    if (!outcome) continue; // still open
    const entry = counts.get(band) ?? { merged: 0, closed: 0 };
    if (outcome === "merged") {
      entry.merged += 1;
      totalMerged += 1;
    } else {
      entry.closed += 1;
    }
    counts.set(band, entry);
    totalResolved += 1;
  }
  const bands: SlopBandCalibration[] = SLOP_BAND_ORDER.map((band) => {
    const { merged, closed } = counts.get(band) ?? { merged: 0, closed: 0 };
    const sampleSize = merged + closed;
    return { band, sampleSize, merged, closed, mergeRate: sampleSize > 0 ? round(merged / sampleSize) : 0 };
  });
  return {
    totalResolved,
    bands,
    overallMergeRate: totalResolved > 0 ? round(totalMerged / totalResolved) : null,
    discriminates: computeDiscriminates(bands),
  };
}

function computeDiscriminates(bands: SlopBandCalibration[]): boolean | null {
  const sampled = bands.filter((band) => band.sampleSize >= MIN_BAND_SAMPLE); // already in severity order
  if (sampled.length < 2) return null; // not enough signal to judge
  for (let index = 1; index < sampled.length; index += 1) {
    // A later (higher-severity) band merging MORE than an earlier one means the score is not discriminating.
    if (sampled[index]!.mergeRate > sampled[index - 1]!.mergeRate + 0.001) return false;
  }
  return true;
}

/**
 * Positive (accepted/merged/improved) vs negative (rejected/closed) vs pending (stale/ignored) split. Pure.
 * When `repoFullName` is given, only outcomes targeting that repo are counted (by outcome/target repo).
 */
export function buildRecommendationOutcomeCalibration(
  outcomes: AgentRecommendationOutcomeRecord[],
  repoFullName?: string,
  options: RecommendationOutcomeCalibrationOptions = {},
): RecommendationOutcomeCalibration {
  const repoScoped = repoFullName ? outcomes.filter((o) => sameRepo(o.outcomeRepoFullName ?? o.targetRepoFullName, repoFullName)) : outcomes;
  const scoped = options.maintainerOnly ? repoScoped.filter((o) => o.maintainerLane) : repoScoped;
  const positive = scoped.filter((o) => RECOMMENDATION_POSITIVE_STATES.includes(o.outcomeState)).length;
  const negative = scoped.filter((o) => RECOMMENDATION_NEGATIVE_STATES.includes(o.outcomeState)).length;
  const pending = scoped.filter((o) => RECOMMENDATION_PENDING_STATES.includes(o.outcomeState)).length;
  const resolved = positive + negative;
  return { total: scoped.length, positive, negative, pending, positiveRate: resolved > 0 ? round(positive / resolved) : null };
}

export function buildOutcomeCalibrationSignals(slop: SlopOutcomeCalibration, recommendations: RecommendationOutcomeCalibration): string[] {
  const signals: string[] = [];
  if (slop.discriminates === true) {
    signals.push(`Slop score is predictive: merge rate falls as the band rises (${slop.totalResolved} resolved PRs).`);
  } else if (slop.discriminates === false) {
    signals.push(`Slop score is NOT discriminating on current data — a higher band merged more often than a lower one. Consider recalibration.`);
  } else {
    signals.push(`Not enough resolved PRs per band to judge slop calibration yet (${slop.totalResolved} resolved).`);
  }
  if (recommendations.positiveRate !== null) {
    signals.push(`Recommendations: ${Math.round(recommendations.positiveRate * 100)}% positive outcomes across ${recommendations.positive + recommendations.negative} resolved (${recommendations.pending} still pending).`);
  } else {
    signals.push(`No resolved recommendation outcomes yet to calibrate against.`);
  }
  return signals;
}

function sameRepo(a: string | null | undefined, b: string): boolean {
  return (a ?? "").toLowerCase() === b.toLowerCase();
}

/** One-line human summary of a repo's slop-band calibration verdict (mirrors the discriminates signal). Pure. */
export function outcomeCalibrationSummary(fullName: string, slop: SlopOutcomeCalibration): string {
  if (slop.discriminates === true) return `Outcome calibration for ${fullName}: slop bands are predictive across ${slop.totalResolved} resolved PRs.`;
  if (slop.discriminates === false) return `Outcome calibration for ${fullName}: slop bands are NOT discriminating on current data (${slop.totalResolved} resolved PRs).`;
  return `Outcome calibration for ${fullName}: not enough resolved PR data to judge slop calibration yet.`;
}

/** Load a repo's PRs + recommendation outcomes and assemble the calibration report. */
export async function buildRepoOutcomeCalibration(
  env: Env,
  repoFullName: string,
  windowDays?: number,
  options: RecommendationOutcomeCalibrationOptions = {},
): Promise<OutcomeCalibration> {
  const [pullRequests, outcomes] = await Promise.all([
    listPullRequests(env, repoFullName),
    listAgentRecommendationOutcomes(env, windowDays !== undefined ? { repoFullName, windowDays } : { repoFullName }),
  ]);
  const slop = buildSlopOutcomeCalibration(pullRequests, options);
  const recommendations = buildRecommendationOutcomeCalibration(outcomes, repoFullName, options);
  return { repoFullName, generatedAt: nowIso(), windowDays: windowDays ?? null, slop, recommendations, signals: buildOutcomeCalibrationSignals(slop, recommendations) };
}
