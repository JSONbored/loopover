// Bounded loosenable-knob registry (#8159, sub-issue of epic #8121). The #8121 narrow start hardcoded ONE
// loosenable value (the satisfaction floor); this registry generalizes the shape the same way
// KNOWN_THRESHOLDS (threshold-backtest.ts) and KNOWN_LOGIC_RULES (backtest-logic-check-core.ts) declare
// their surfaces: each knob is a declarative entry — rule id, candidate steps, hard bounds, split
// discipline — evaluated by ONE generic function, never per-knob bespoke loops.
//
// Every knob keeps the narrow start's invariants verbatim: smallest-step-first, strictly `improved` on the
// visible split AND non-`regressed` on the deterministic held-out split, a hard safety minimum no evidence
// can cross, and never-on-noise sample floors. A knob additionally declares whether its apply path is LIVE
// (an override consumer exists) or REPORT-ONLY (proposals surface with full evidence, but nothing may be
// written until the consumption plumbing ships — adding a consumer is a deliberate, per-knob decision, not
// a registry edit side effect).
import {
  buildConfidenceThresholdClassifier,
  compareBacktestScores,
  scoreBacktest,
  splitBacktestCorpus,
  type BacktestCase,
  type BacktestComparison,
} from "@loopover/engine";
import { LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR } from "./linked-issue-satisfaction";
import { DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE } from "../rules/advisory";

export type LoosenableKnob = {
  /** Stable id — used in override flag keys, audit events, and advisor labels. Never rename. */
  knobId: string;
  ruleId: string;
  shippedValue: number;
  /** Candidate loosened values, nearest-to-shipped first — the smallest evidence-cleared step wins. */
  candidates: readonly number[];
  /** No backtest result, however good, may loosen below this. */
  hardMinimum: number;
  minVisibleCases: number;
  minHeldOutCases: number;
  heldOutFraction: number;
  /** Fixed per-knob split seed — held-out membership must never reshuffle between evaluations. */
  splitSeed: string;
  /** `live`: an override consumer exists and the apply path may write. `report_only`: proposals surface
   *  (advisor/status) but the apply path REFUSES — flipping a knob to live requires shipping its
   *  consumption plumbing first, reviewed on its own. */
  applyMode: "live" | "report_only";
  /** system_flags key holding this knob's live override (migration 0054's operational-flag table). */
  overrideFlagKey: string;
  /** Audit event type an apply writes — a knob's evidence trail keeps ONE stable type forever. */
  looseningEventType: string;
  /** Truthy-string wrangler var double-gating this knob's autotune loop AND its override read. */
  autotuneEnvVar: string;
};

export const LOOSENABLE_KNOBS: Readonly<Record<string, LoosenableKnob>> = Object.freeze({
  // #8121's approved narrow start — fully live (override consumed by runLoopOverLinkedIssueSatisfaction).
  // Values and seed are IDENTICAL to the pre-registry constants: behavior and held-out membership are
  // byte-stable across this refactor.
  satisfaction_floor: {
    knobId: "satisfaction_floor",
    ruleId: "linked_issue_scope_mismatch",
    shippedValue: LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR,
    candidates: [0.45, 0.4, 0.35, 0.3],
    hardMinimum: 0.3,
    minVisibleCases: 20,
    minHeldOutCases: 5,
    heldOutFraction: 0.25,
    splitSeed: "satisfaction-floor-loosening-v1",
    applyMode: "live",
    // Literals (not imports) to keep this registry dependency-light; the invariant test pins them to the
    // run module's exported constants so they can never drift.
    overrideFlagKey: "satisfaction_floor_override",
    looseningEventType: "calibration.satisfaction_floor_loosened",
    autotuneEnvVar: "SATISFACTION_FLOOR_AUTOTUNE_ENABLED",
  },
  // The AI close-confidence floor (#8159's second knob), LIVE since #8176: the override is consumed as the
  // gate policy's DEFAULT (gate-checks.ts threads it under `settings.aiReviewCloseConfidence ?? override`),
  // so an explicit per-repo `gate.aiReview.closeConfidence` ALWAYS wins — the knob only moves the default.
  // Loosening it means MORE auto-closes (a direct gate-authority change), hence the double gating: the
  // AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED var must be ON for both the loop and the override read,
  // and its corpus floors are the registry's strictest. Tight bounds by design: two steps, hard floor 0.85.
  ai_review_close_confidence: {
    knobId: "ai_review_close_confidence",
    ruleId: "ai_consensus_defect",
    shippedValue: DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE,
    candidates: [0.9, 0.85],
    hardMinimum: 0.85,
    minVisibleCases: 50,
    minHeldOutCases: 12,
    heldOutFraction: 0.25,
    splitSeed: "ai-close-confidence-loosening-v1",
    applyMode: "live",
    overrideFlagKey: "ai_review_close_confidence_override",
    looseningEventType: "calibration.ai_review_close_confidence_loosened",
    autotuneEnvVar: "AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED",
  },
});

export type KnobLooseningProposal = {
  knobId: string;
  ruleId: string;
  currentValue: number;
  proposedValue: number;
  visibleCases: number;
  heldOutCases: number;
  visible: BacktestComparison;
  heldOut: BacktestComparison;
};

/**
 * Evaluate whether `knob` can be safely loosened from `currentValue` — the generic form of the #8121
 * narrow start's gate, parameterized by the registry entry and nothing else: the smallest candidate step
 * below `currentValue` (never below the knob's hard minimum) whose backtest verdict is strictly
 * `"improved"` on the visible split AND non-`"regressed"` on the held-out split. Null when the corpus is
 * too small, no candidate qualifies, or the current value already sits at/below the hard minimum. Pure and
 * deterministic — same knob + corpus + value ⇒ same proposal.
 */
export function evaluateKnobLoosening(
  knob: LoosenableKnob,
  cases: readonly BacktestCase[],
  currentValue: number = knob.shippedValue,
): KnobLooseningProposal | null {
  const { visible, heldOut } = splitBacktestCorpus(cases, knob.heldOutFraction, knob.splitSeed);
  if (visible.length < knob.minVisibleCases || heldOut.length < knob.minHeldOutCases) return null;

  for (const candidate of knob.candidates) {
    if (candidate >= currentValue || candidate < knob.hardMinimum) continue;
    const visibleComparison = compareOnSlice(knob.ruleId, visible, currentValue, candidate);
    if (visibleComparison.verdict !== "improved") continue;
    const heldOutComparison = compareOnSlice(knob.ruleId, heldOut, currentValue, candidate);
    if (heldOutComparison.verdict === "regressed") continue;
    return {
      knobId: knob.knobId,
      ruleId: knob.ruleId,
      currentValue,
      proposedValue: candidate,
      visibleCases: visible.length,
      heldOutCases: heldOut.length,
      visible: visibleComparison,
      heldOut: heldOutComparison,
    };
  }
  return null;
}

function compareOnSlice(ruleId: string, slice: readonly BacktestCase[], currentValue: number, candidate: number): BacktestComparison {
  const baseline = scoreBacktest(ruleId, slice, buildConfidenceThresholdClassifier(currentValue));
  const proposed = scoreBacktest(ruleId, slice, buildConfidenceThresholdClassifier(candidate));
  return compareBacktestScores(baseline, proposed);
}
