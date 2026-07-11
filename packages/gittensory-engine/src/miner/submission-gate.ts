// Gated-submission trigger (#2336): THE safety-critical chokepoint of Phase 4 -- the actual decision point
// that decides "call gittensory_open_pr NOW" for an autonomous run. Conservatively requires BOTH a predicted-
// gate PASS AND a slop score under a configurable threshold before a local-write open_pr action spec is ever
// built. Any ambiguity (a missing/errored signal) resolves to NOT submitting -- this function never defaults
// to allow.
//
// SEQUENCING: runs BEFORE `buildOpenPrSpec` (src/mcp/local-write-tools.ts) is ever called -- i.e. before the
// Governor chokepoint (#2340) ever sees an open_pr action spec to evaluate. The two are complementary, not
// redundant: this gates on CONTENT-QUALITY signals (predicted-gate conclusion, slop risk) specific to the
// candidate diff; the chokepoint gates on RESOURCE/GOVERNANCE signals (rate-limit, budget, reputation, self-
// plagiarism, dry-run mode) that apply to every write action class, not just open_pr. "The actual call site
// invoking buildOpenPrSpec / gittensory_open_pr is gated exclusively through this function" (this issue's own
// deliverable) is a POLICY this and every future call site must honor -- wiring a real call site is a later,
// separate issue (mirrors #2333/#2335's own split between loop mechanics and policy).
//
// INPUT SHAPE: `predictedGateVerdict`/`slopAssessment` are typed exactly as the fields `SelfReviewVerdict`
// (self-review-adapter.ts, #2334) already carries, so a caller can pass the SAME verdict the iterate-loop's
// own self-review (#2333) already computed at handoff time -- this is a defense-in-depth RE-CHECK of that
// verdict immediately before submission, not a redundant re-computation from scratch.
//
// DRY-RUN: mirrors `src/settings/autonomy.ts`'s deny-by-default dial (`AUTONOMY_LEVELS`, `"observe"` as the
// floor) for safe rollout of THIS function's own thresholds -- distinct from, and evaluated separately from,
// the Governor chokepoint's own dry-run/live action-mode dial (#2342), which gates autonomous WRITING at all
// for a repo. `"observe"` here is specifically for safely calibrating the predicted-gate/slop thresholds
// against live traffic before ever trusting them to gate a real submission.
//
// KILL-SWITCH (#2339): checked FIRST, before any other logic -- flipping the kill-switch must halt this
// chokepoint immediately, the same way it halts the Governor chokepoint (#2340). Reuses
// `isMinerKillSwitchActive` (kill-switch.ts, #2341) directly rather than a bespoke wrapper -- the exact "single
// shared helper, not duplicated per call site" #2339's own deliverable calls for; `loop-reentry-policy.ts`'s
// `shouldReenter` consults the identical function. `killSwitchScope` is REQUIRED (not optional-with-a-
// permissive-default) so a caller cannot forget to resolve and pass it -- the same fail-closed-by-construction
// discipline as every other required field here.

import { isMinerKillSwitchActive, type MinerKillSwitchScope } from "../governor/kill-switch.js";
import type { PredictedGateVerdict } from "../predicted-gate.js";
import type { SelfReviewSlopAssessment, SelfReviewSlopBand } from "./self-review-adapter.js";

/** The one literal conclusion value that counts as a clear predicted-gate pass -- same literal self-review-
 *  adapter.ts's `SELF_REVIEW_PASSING_CONCLUSION` uses, kept as an independent constant here so this module has
 *  no runtime dependency beyond types on self-review-adapter.ts. */
export const SUBMISSION_GATE_PASSING_CONCLUSION = "success" as const;

const SLOP_BAND_SEVERITY: Readonly<Record<SelfReviewSlopBand, number>> = Object.freeze({
  clean: 0,
  low: 1,
  elevated: 2,
  high: 3,
});

/** True when `band` is at or under `threshold`'s severity (inclusive) -- e.g. a `"low"` band is within a
 *  `"elevated"` threshold, and a band exactly equal to the threshold still passes. */
export function isSlopBandWithinThreshold(band: SelfReviewSlopBand, threshold: SelfReviewSlopBand): boolean {
  return SLOP_BAND_SEVERITY[band] <= SLOP_BAND_SEVERITY[threshold];
}

/** `"observe"` mirrors `AUTONOMY_LEVELS`' deny-by-default floor: {@link shouldSubmit} still computes and
 *  returns the real signal-based decision (for logging), but structurally forces `allow: false` regardless --
 *  not left to an external caller to remember to also check the mode before acting on `allow: true`. */
export type SubmissionGateMode = "observe" | "enforce";

export type SubmissionGateCandidate = {
  /** Checked FIRST, before any other field below -- see the module doc comment's KILL-SWITCH section. */
  killSwitchScope: MinerKillSwitchScope;
  /** `null` means the predictor was unreachable or errored -- fails closed, exactly like a genuine non-passing
   *  verdict, never treated as "no opinion, so allow". */
  predictedGateVerdict: PredictedGateVerdict | null;
  /** `null` means the slop check errored -- fails closed, exactly like a genuine over-threshold assessment. */
  slopAssessment: SelfReviewSlopAssessment | null;
  /** The maximum slop band that still permits submission (inclusive of this exact band). */
  slopThreshold: SelfReviewSlopBand;
  mode: SubmissionGateMode;
};

export type SubmissionGateDecision = {
  allow: boolean;
  /** Always populated when `allow` is `false` (including in `"observe"` mode, prefixed to distinguish a
   *  would-have-allowed dry-run from a real block) -- every decision is auditable, not just denials. */
  reasons: string[];
};

/** The pure signal check, independent of `mode` -- {@link shouldSubmit} layers the observe/enforce dial on
 *  top of this. Returns an empty array only when BOTH signals genuinely pass. */
function evaluateSubmissionSignals(candidate: SubmissionGateCandidate): string[] {
  const reasons: string[] = [];

  if (candidate.predictedGateVerdict === null) {
    reasons.push("predicted_gate_unavailable");
  } else if (candidate.predictedGateVerdict.conclusion !== SUBMISSION_GATE_PASSING_CONCLUSION) {
    const blockerCodes = candidate.predictedGateVerdict.blockers.map((blocker) => blocker.code).join(",");
    reasons.push(`predicted_gate_not_passing:${candidate.predictedGateVerdict.conclusion}${blockerCodes ? `:${blockerCodes}` : ""}`);
  }

  if (candidate.slopAssessment === null) {
    reasons.push("slop_assessment_unavailable");
  } else if (!isSlopBandWithinThreshold(candidate.slopAssessment.band, candidate.slopThreshold)) {
    reasons.push(`slop_band_exceeds_threshold:${candidate.slopAssessment.band}>${candidate.slopThreshold}`);
  }

  return reasons;
}

/**
 * THE gate: build (or invoke) `gittensory_open_pr`'s action spec ONLY when this returns `allow: true`. Requires
 * BOTH a clean predicted-gate pass AND a slop band at or under the configured threshold; any missing signal, or
 * `mode: "observe"`, forces `allow: false`. The kill-switch is checked FIRST, before any other logic -- an
 * active kill-switch blocks unconditionally, regardless of otherwise-passing signals. Pure; identical inputs
 * always yield the identical decision.
 */
export function shouldSubmit(candidate: SubmissionGateCandidate): SubmissionGateDecision {
  if (isMinerKillSwitchActive(candidate.killSwitchScope)) {
    return { allow: false, reasons: [`${candidate.killSwitchScope}_kill_switch_active`] };
  }

  const reasons = evaluateSubmissionSignals(candidate);
  const signalsPass = reasons.length === 0;

  if (candidate.mode === "observe") {
    return {
      allow: false,
      reasons: signalsPass ? ["observe_mode_active:would_have_allowed"] : ["observe_mode_active:would_have_blocked", ...reasons],
    };
  }
  return { allow: signalsPass, reasons };
}
