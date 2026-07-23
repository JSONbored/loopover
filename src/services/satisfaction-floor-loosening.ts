// Backtest-gated loosening of the linked-issue satisfaction confidence floor (#8121's approved narrow
// start, epic #8082). auto-tune.ts's OverridePayload doc states the historical rule plainly: "a loosening
// recommendation never carries a payload (autonomous loosening is the regression risk the loop exists to
// avoid)". The #8082 backtest primitives are exactly the missing risk measurement that comment names: this
// module proposes a LOWER value for LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR when — and only when — the
// proposal clears the Pareto floor (#8086) against real human-adjudicated history on the VISIBLE split AND
// does not regress on the deterministic HELD-OUT split (#8087), so a loosening can never be hand-tuned to
// just the incidents already known about.
//
// PURE: no IO, no env, no clock — the corpus is the caller's (satisfaction-floor-loosening-run.ts reads it
// via the SignalStore). Scoped to exactly this one scalar; generalizing to other loosenable knobs is the
// rest of epic #8121, decomposed separately, and requires its own explicit approval per that epic's
// Boundaries.
import {
  buildConfidenceThresholdClassifier,
  compareBacktestScores,
  scoreBacktest,
  splitBacktestCorpus,
  type BacktestCase,
  type BacktestComparison,
} from "@loopover/engine";
import { LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR } from "./linked-issue-satisfaction";

export const SATISFACTION_FLOOR_RULE_ID = "linked_issue_scope_mismatch";

/** Candidate loosened floors, nearest-to-current first — the FIRST candidate that clears both splits wins,
 *  so the loop always takes the SMALLEST loosening step the evidence supports, never the biggest. */
export const SATISFACTION_FLOOR_LOOSENING_CANDIDATES: readonly number[] = [0.45, 0.4, 0.35, 0.3];

/** Hard safety minimum — no backtest result, however good, may loosen the floor below this. A floor of ~0
 *  would republish every hallucinated low-confidence "unaddressed" call, the exact failure mode the floor
 *  exists to suppress (see LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR's own doc). */
export const SATISFACTION_FLOOR_HARD_MINIMUM = 0.3;

/** Below these decided-sample sizes the corpus cannot honestly justify ANY loosening — mirrors
 *  AUTOTUNE_MIN_DECIDED's "never on noise" discipline (auto-tune.ts). */
export const SATISFACTION_FLOOR_MIN_VISIBLE_CASES = 20;
export const SATISFACTION_FLOOR_MIN_HELD_OUT_CASES = 5;

export const SATISFACTION_FLOOR_HELD_OUT_FRACTION = 0.25;
/** Fixed split seed: the held-out membership must never reshuffle between evaluations, or a repeatedly-run
 *  loop could fish for a lucky split (see splitBacktestCorpus's own determinism contract). */
export const SATISFACTION_FLOOR_SPLIT_SEED = "satisfaction-floor-loosening-v1";

export type SatisfactionFloorLooseningProposal = {
  ruleId: typeof SATISFACTION_FLOOR_RULE_ID;
  currentFloor: number;
  proposedFloor: number;
  visibleCases: number;
  heldOutCases: number;
  visible: BacktestComparison;
  heldOut: BacktestComparison;
};

/**
 * Evaluate whether the satisfaction confidence floor can be safely loosened, per #8121's approved gate:
 * the smallest candidate step below `currentFloor` (never below {@link SATISFACTION_FLOOR_HARD_MINIMUM})
 * whose backtest verdict is strictly `"improved"` on the visible split AND non-`"regressed"` on the
 * held-out split. Returns null when the corpus is too small, no candidate qualifies, or `currentFloor` is
 * already at/below the hard minimum (a previously-applied loosening never compounds past it). Pure and
 * deterministic — same corpus + floor ⇒ same proposal.
 */
export function evaluateSatisfactionFloorLoosening(
  cases: readonly BacktestCase[],
  currentFloor: number = LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR,
): SatisfactionFloorLooseningProposal | null {
  const { visible, heldOut } = splitBacktestCorpus(cases, SATISFACTION_FLOOR_HELD_OUT_FRACTION, SATISFACTION_FLOOR_SPLIT_SEED);
  if (visible.length < SATISFACTION_FLOOR_MIN_VISIBLE_CASES || heldOut.length < SATISFACTION_FLOOR_MIN_HELD_OUT_CASES) return null;

  for (const candidate of SATISFACTION_FLOOR_LOOSENING_CANDIDATES) {
    if (candidate >= currentFloor || candidate < SATISFACTION_FLOOR_HARD_MINIMUM) continue;
    const visibleComparison = compareOnSlice(visible, currentFloor, candidate);
    if (visibleComparison.verdict !== "improved") continue;
    const heldOutComparison = compareOnSlice(heldOut, currentFloor, candidate);
    if (heldOutComparison.verdict === "regressed") continue;
    return {
      ruleId: SATISFACTION_FLOOR_RULE_ID,
      currentFloor,
      proposedFloor: candidate,
      visibleCases: visible.length,
      heldOutCases: heldOut.length,
      visible: visibleComparison,
      heldOut: heldOutComparison,
    };
  }
  return null;
}

function compareOnSlice(slice: readonly BacktestCase[], currentFloor: number, candidate: number): BacktestComparison {
  const baseline = scoreBacktest(SATISFACTION_FLOOR_RULE_ID, slice, buildConfidenceThresholdClassifier(currentFloor));
  const proposed = scoreBacktest(SATISFACTION_FLOOR_RULE_ID, slice, buildConfidenceThresholdClassifier(candidate));
  return compareBacktestScores(baseline, proposed);
}
