// Harness submission-gate wiring (#2337): connects the gated-submission decision function (`shouldSubmit`,
// submission-gate.ts, #2336) to the ACTUAL driving loop's own handoff signal -- iterate-loop.ts's (#2333)
// `HandoffPacket`, the exact object produced the moment a real run's self-review reaches a clean predicted-gate
// pass. This is the live actuation wiring itself: the trigger surface the safety-tier system reserves for
// maintainer review, since a bug here means an autonomous write happens when it should not have.
//
// WHAT THIS DOES NOT DO: build or invoke the actual `open_pr` local-write spec (`buildOpenPrSpec`,
// `src/mcp/local-write-tools.ts`) -- that lives in the private root `src/` tree, unreachable from this
// portable package for the same cross-package-boundary reason self-review-adapter.ts's slop injection exists
// (#2334's own module doc comment). This function's OUTPUT (`allow: true`) is the gate a real call site
// (root-side server/CLI integration, wired in a later issue) consults before it builds that spec itself --
// mirrors #2336's own "gated exclusively through this function" scoping.
//
// THE SESSION-LEVEL CIRCUIT BREAKER: distinct from `shouldSubmit`'s own per-candidate signal checks
// (predicted-gate pass, slop-under-threshold), this issue's own deliverable calls for "N consecutive
// submission-gate allow:false decisions in one session pauses the run entirely pending human review, never
// silently loops trying to force a pass." Checked FIRST, before ever consulting `shouldSubmit` -- once tripped,
// no candidate can un-trip it (that requires a human clearing the session's own consecutive-block tally),
// unlike a per-candidate block which a later, different candidate can clear on its own merits.

import type { HandoffPacket } from "./iterate-policy.js";
import type { SelfReviewSlopBand } from "./self-review-adapter.js";
import { shouldSubmit, type SubmissionGateMode } from "./submission-gate.js";

export const DEFAULT_MAX_CONSECUTIVE_GATE_BLOCKS = 3;

export type HarnessSubmissionTriggerCandidate = {
  handoffPacket: HandoffPacket;
  slopThreshold: SelfReviewSlopBand;
  mode: SubmissionGateMode;
  /** Caller-computed count of CONSECUTIVE `allow: false` submission-gate decisions so far this session,
   *  ending with (and NOT including) this candidate's own about-to-be-computed decision. The caller owns this
   *  tally (mirrors #2338's caller-supplied `consecutiveDisengagements`); a `true` decision anywhere resets it
   *  to 0 for the caller's NEXT candidate. */
  consecutiveGateBlocks: number;
  maxConsecutiveGateBlocks?: number | undefined;
};

export type HarnessSubmissionTriggerDecision = {
  allow: boolean;
  reasons: string[];
  /** True only when the SESSION-LEVEL circuit breaker (not a normal per-candidate block) is what stopped this
   *  decision -- the caller's own driving loop should treat this as "pause the run entirely pending human
   *  review," distinct from an ordinary `allow: false` a later, different candidate might still clear. */
  circuitBreakerTripped: boolean;
};

/**
 * THE final gate before a real call site may build the `open_pr` local-write spec from a passing
 * `HandoffPacket`. Pure; identical inputs always yield the identical decision. Checks the session-level
 * circuit breaker FIRST (never consults `shouldSubmit` once tripped), then re-checks `shouldSubmit`'s own
 * predicted-gate-pass + slop-under-threshold signals against the handoff's own verdict -- defense in depth,
 * not a blind trust of the fact that a handoff happened at all.
 */
export function evaluateHarnessSubmissionTrigger(candidate: HarnessSubmissionTriggerCandidate): HarnessSubmissionTriggerDecision {
  const maxConsecutiveGateBlocks = candidate.maxConsecutiveGateBlocks ?? DEFAULT_MAX_CONSECUTIVE_GATE_BLOCKS;

  if (candidate.consecutiveGateBlocks >= maxConsecutiveGateBlocks) {
    return {
      allow: false,
      circuitBreakerTripped: true,
      reasons: [`circuit_breaker_tripped_after_consecutive_blocks:${candidate.consecutiveGateBlocks}>=${maxConsecutiveGateBlocks}`],
    };
  }

  const gateDecision = shouldSubmit({
    predictedGateVerdict: candidate.handoffPacket.selfReviewVerdict.predictedGateVerdict,
    slopAssessment: candidate.handoffPacket.selfReviewVerdict.slopAssessment,
    slopThreshold: candidate.slopThreshold,
    mode: candidate.mode,
  });

  return { allow: gateDecision.allow, reasons: gateDecision.reasons, circuitBreakerTripped: false };
}
