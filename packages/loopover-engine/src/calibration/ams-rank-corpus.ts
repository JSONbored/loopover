// AMS min-rank corpus + advisory backtest (#8184, epic #8172 phase 2) -- the miner-side twin of the ORB
// threshold backtest (#8138), over the miner's OWN taken-opportunity history instead of ORB signal events.
// The opportunity ranker's score is an equal-weight clamped product in [0, 1] (opportunity-ranker.ts -- no
// scalar weights), so the SKIP THRESHOLD is the tunable, and the counterfactual question is: "had the
// min-rank floor been X, which taken opportunities would have been skipped, and were those the ones that
// went badly?" Labels come from realized outcomes: a MERGED take was a good take (label "confirmed"); a
// CLOSED take was a bad one -- skipping it would have been right (label "reversed"). That polarity lines
// up exactly with buildConfidenceThresholdClassifier's positive class ("predicted reversed" when the score
// sits below the threshold), so the whole ORB replay stack -- splitBacktestCorpus, runThresholdBacktest's
// scoreBacktest + compareBacktestScores Pareto floor -- is reused untouched, zero new math.
//
// Same purity contract as the rest of this module family: no IO, no randomness, no wall-clock reads.

import type { BacktestCase } from "./backtest-corpus.js";
import type { BacktestComparison } from "./backtest-compare.js";
import { runThresholdBacktest } from "./backtest-threshold.js";
import { splitBacktestCorpus } from "./backtest-split.js";

/** The synthetic rule id AMS min-rank replay cases carry (namespaced away from every ORB rule id). */
export const AMS_MIN_RANK_RULE_ID = "ams_min_rank_skip";

// The #8121 split discipline transposed: a fixed seed so held-out membership never reshuffles between
// evaluations, and never-on-noise sample floors sized like the satisfaction floor's (the miner's local
// history is closer to that corpus's scale than to the AI knob's firehose).
export const AMS_MIN_RANK_SPLIT_SEED = "ams-min-rank-skip-v1";
export const AMS_MIN_RANK_HELD_OUT_FRACTION = 0.25;
export const AMS_MIN_RANK_MIN_VISIBLE_CASES = 20;
export const AMS_MIN_RANK_MIN_HELD_OUT_CASES = 5;

/** One taken opportunity with a realized terminal outcome -- the join of a `discovered_issue` rank record
 *  and the miner's own `pr_outcome` for the PR that issue produced. Assembled miner-side (the ledger join
 *  lives in @loopover/miner's ams-calibration module); this module only replays. */
export type AmsTakenOpportunity = {
  repoFullName: string;
  issueNumber: number;
  /** The ranker's clamped-product score at discovery time, in [0, 1]. */
  rankScore: number;
  realizedDecision: "merged" | "closed";
  /** When the opportunity was discovered/ranked (ISO). */
  discoveredAt: string;
  /** When the terminal outcome was recorded (ISO). */
  decidedAt: string;
};

/**
 * Shape taken opportunities into {@link BacktestCase}s for the min-rank replay: `metadata.confidence`
 * carries the rank score (the value the threshold classifier replays against), a CLOSED take labels
 * "reversed" (skipping would have been right), a MERGED take labels "confirmed". Records with a
 * non-finite or out-of-[0,1] rank score are dropped -- a case the classifier cannot honestly replay must
 * not default to confidence 1. Deterministic order (repo#issue, then discoveredAt), so downstream splits
 * see a stable corpus.
 */
export function buildAmsRankCorpus(takes: readonly AmsTakenOpportunity[]): BacktestCase[] {
  const cases: BacktestCase[] = [];
  for (const take of takes) {
    if (!Number.isFinite(take.rankScore) || take.rankScore < 0 || take.rankScore > 1) continue;
    cases.push({
      ruleId: AMS_MIN_RANK_RULE_ID,
      targetKey: `${take.repoFullName}#issue-${take.issueNumber}`,
      outcome: "take",
      label: take.realizedDecision === "closed" ? "reversed" : "confirmed",
      firedAt: take.discoveredAt,
      decidedAt: take.decidedAt,
      metadata: { confidence: take.rankScore },
    });
  }
  cases.sort((left, right) => {
    const key = left.targetKey.localeCompare(right.targetKey);
    return key !== 0 ? key : left.firedAt.localeCompare(right.firedAt);
  });
  return cases;
}

export type AmsMinRankBacktestResult = {
  ruleId: string;
  currentThreshold: number;
  candidateThreshold: number;
  visibleCases: number;
  heldOutCases: number;
  visible: BacktestComparison;
  heldOut: BacktestComparison;
};

/**
 * Advisory replay of a candidate min-rank skip threshold against the taken-opportunity corpus -- the
 * #8138 discipline verbatim: the fixed-seed split, then {@link runThresholdBacktest} (scoreBacktest +
 * the symmetric compareBacktestScores Pareto floor, per #8184's required pattern) on EACH slice. Null --
 * never a guess -- when either slice misses its sample floor. Report-only by construction: this function
 * returns comparisons; it never moves a knob.
 */
export function runAmsMinRankBacktest(
  cases: readonly BacktestCase[],
  currentThreshold: number,
  candidateThreshold: number,
): AmsMinRankBacktestResult | null {
  const { visible, heldOut } = splitBacktestCorpus(cases, AMS_MIN_RANK_HELD_OUT_FRACTION, AMS_MIN_RANK_SPLIT_SEED);
  if (visible.length < AMS_MIN_RANK_MIN_VISIBLE_CASES || heldOut.length < AMS_MIN_RANK_MIN_HELD_OUT_CASES) return null;
  return {
    ruleId: AMS_MIN_RANK_RULE_ID,
    currentThreshold,
    candidateThreshold,
    visibleCases: visible.length,
    heldOutCases: heldOut.length,
    visible: runThresholdBacktest(AMS_MIN_RANK_RULE_ID, visible, currentThreshold, candidateThreshold),
    heldOut: runThresholdBacktest(AMS_MIN_RANK_RULE_ID, heldOut, currentThreshold, candidateThreshold),
  };
}
