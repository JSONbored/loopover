// Iterate-loop stop/abandon/handoff policy (#2335): the explicit POLICY the orchestration loop's control flow
// (#2333, sibling issue) consults each iteration to decide among exactly three outcomes. Deliberately split
// from the loop MECHANICS (#2333) so the actual thresholds/rules are one small, individually-reviewable, pure
// artifact -- `decideNextAction` needs no driver, no worktree, no IO to test.
//
// STRATEGIC CONSTRAINTS this policy encodes (gittensory-miner-autonomy-roadmap):
//   - "never auto-submit (P4) before governor+caps (P5)" -- a mandatory clean predicted-gate PASS is the ONLY
//     path to `"handoff"`; an ambiguous or errored self-review downgrades to abandon, never optimistically
//     hands off.
//   - "disengage SILENTLY on rejection" (the Matplotlib "MJ Rathbun" cautionary tale) -- a rejection signal
//     wins over EVERYTHING else, including a self-review that would otherwise pass. Continuing to submit to a
//     repo that has already shown it does not want automated contributions is the exact anti-pattern this
//     guards against, regardless of how good any individual attempt looks.
//   - "reward MERGED net-positive (never submission volume)" -- the no-progress detector and iteration ceiling
//     exist so a stuck loop stops wasting turns chasing a submission that was never going to land, rather than
//     grinding toward *a* submission for its own sake.
//
// AUTONOMY DIAL (not yet wired): `src/settings/autonomy.ts`'s `resolveAutonomy`/`isActingAutonomyLevel` is the
// existing reusable deny-by-default pattern this policy's eventual live autonomy-level check should consult
// once `.gittensory-miner.yml` defines autonomy fields -- that wiring is explicitly left to a later phase; this
// module's `decideNextAction` is autonomy-level-agnostic today.

import type { SelfReviewVerdict } from "./self-review-adapter.js";

/** The three outcomes `decideNextAction` may reach. */
export type IterateLoopAction = "continue" | "handoff" | "abandon";

/** Every distinct reason `decideNextAction` can abandon for -- kept as a closed literal union so a caller
 *  recording the decision (the attempt-log primitive, per #2333) has a stable, exhaustive vocabulary. */
export type AbandonReason = "rejection_signaled" | "self_review_ambiguous" | "max_iterations_reached" | "no_progress";

/**
 * The self-review outcome as the policy needs it -- narrower than the full {@link SelfReviewVerdict} (self-
 * review-adapter.ts, #2334) so `IterationState` stays a minimal, cheap-to-construct synthetic fixture in
 * tests. `"ambiguous"` is NOT something {@link deriveSelfReviewOutcome} ever produces from a successfully
 * returned verdict (a real verdict object always has a definite conclusion) -- it is constructed directly by
 * the caller's own error handling when the self-review call itself throws (e.g. a calculator inside it errors),
 * per #2333's own "self-review itself errors" abandon trigger.
 */
export type SelfReviewOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "fail"; readonly blockerCodes: readonly string[] }
  | { readonly kind: "ambiguous"; readonly reason?: string | undefined };

/** Derive the policy-relevant {@link SelfReviewOutcome} from a real, successfully computed
 *  {@link SelfReviewVerdict}. Only ever returns `"pass"` or `"fail"` -- see that variant's own doc comment for
 *  why `"ambiguous"` is constructed elsewhere. */
export function deriveSelfReviewOutcome(verdict: SelfReviewVerdict): SelfReviewOutcome {
  if (verdict.passesPredictedGate) return { kind: "pass" };
  return { kind: "fail", blockerCodes: verdict.predictedGateVerdict.blockers.map((blocker) => blocker.code) };
}

/**
 * Everything `decideNextAction` needs for one iteration's decision. Deliberately minimal and synthetic-
 * fixture-friendly -- no driver, no worktree, no IO.
 */
export type IterationState = {
  /** 1-indexed count of iterations attempted so far, INCLUDING this one. */
  iterationNumber: number;
  /** Hard ceiling enforced INSIDE this policy (#2333's own deliverable: not left to an external caller to
   *  remember to enforce). `iterationNumber >= maxIterations` abandons regardless of self-review outcome. */
  maxIterations: number;
  selfReview: SelfReviewOutcome;
  /** The prior iteration's `fail` blocker codes, for the no-progress detector -- `null` when there is no prior
   *  iteration to compare (the first iteration, or the prior iteration did not reach a `fail` outcome). */
  previousBlockerCodes: readonly string[] | null;
  /** True when the target repo (or this contributor's history with it) has signaled it does not want
   *  automated/AI-authored contributions -- an explicit AI-usage-policy ban, or a prior submission from this
   *  same miner was closed/rejected on this exact repo. The caller resolves this (e.g. via the AI-policy-map
   *  signals or the rejection-state-machine primitive already shipped in `packages/gittensory-miner/lib/`) and
   *  passes it in; this policy does not compute it itself. */
  rejectionSignaled: boolean;
};

/** Forward-looking INTERFACE for Phase 4 (submission), not an implementation of it -- Phase 4 lands as a later,
 *  separate issue. Gives it a stable target instead of reverse-engineering the shape from the loop's internals. */
export type HandoffPacket = {
  /** Absolute path to (or a branch ref identifying) the worktree holding the passing attempt's changes. */
  worktreePath: string;
  branchRef?: string | undefined;
  /** Human-readable summary of the final diff, for the submission's own PR description. */
  diffSummary: string;
  /** The PASSING self-review verdict that authorized this handoff -- always has `passesPredictedGate: true`
   *  (constructing a packet from anything else is a caller bug, not something this type can prevent statically,
   *  since `decideNextAction` is the actual enforcement point). */
  selfReviewVerdict: SelfReviewVerdict;
  /** Reference into the attempt-log primitive (`packages/gittensory-engine/src/miner/attempt-log.ts`) for this
   *  attempt's full decision trail. */
  attemptLogReference: string;
};

export type IterateLoopDecision = {
  action: IterateLoopAction;
  /** Machine-stable, human-readable reason -- always populated, including for `"continue"` and `"handoff"`, so
   *  every decision (not just abandons) has an auditable reason string for the attempt-log. */
  reason: string;
  /** Populated only when `action === "abandon"`. */
  abandonReason?: AbandonReason | undefined;
};

function blockerSetsEqual(current: readonly string[], previous: readonly string[]): boolean {
  if (current.length !== previous.length) return false;
  const currentSet = new Set(current);
  const previousSet = new Set(previous);
  if (currentSet.size !== previousSet.size) return false;
  for (const code of currentSet) if (!previousSet.has(code)) return false;
  return true;
}

/**
 * Decide the next action for one iteration. Pure; identical inputs always yield the identical decision.
 *
 * Precedence (each check short-circuits the ones below it):
 * 1. `rejectionSignaled` -- ALWAYS abandons, even over an otherwise-passing self-review (disengage silently).
 * 2. `selfReview.kind === "ambiguous"` -- abandons; never optimistically continues or hands off on ambiguity.
 * 3. `selfReview.kind === "pass"` -- the ONLY path to `"handoff"`.
 * 4. `iterationNumber >= maxIterations` -- abandons at the hard ceiling regardless of whether the blocker set
 *    was still changing (genuine incremental progress does not buy unlimited iterations).
 * 5. The current `fail` blocker set is identical to `previousBlockerCodes` -- abandons (no progress, stop
 *    wasting turns).
 * 6. Otherwise -- continue.
 */
export function decideNextActionWithReason(state: IterationState): IterateLoopDecision {
  if (state.rejectionSignaled) {
    return { action: "abandon", abandonReason: "rejection_signaled", reason: "Repo or contributor has signaled it does not want automated contributions; disengaging silently rather than retry-hammering." };
  }
  if (state.selfReview.kind === "ambiguous") {
    return {
      action: "abandon",
      abandonReason: "self_review_ambiguous",
      reason: `Self-review could not conclusively determine pass/fail${state.selfReview.reason ? `: ${state.selfReview.reason}` : "."} Downgrading to abandon rather than optimistically handing off.`,
    };
  }
  if (state.selfReview.kind === "pass") {
    return { action: "handoff", reason: "Self-review reached a clean predicted-gate pass." };
  }
  if (state.iterationNumber >= state.maxIterations) {
    return {
      action: "abandon",
      abandonReason: "max_iterations_reached",
      reason: `Reached the iteration ceiling (${state.maxIterations}) without a clean predicted-gate pass.`,
    };
  }
  if (state.previousBlockerCodes !== null && blockerSetsEqual(state.selfReview.blockerCodes, state.previousBlockerCodes)) {
    return {
      action: "abandon",
      abandonReason: "no_progress",
      reason: `Blocker set unchanged from the prior iteration (${state.selfReview.blockerCodes.join(", ") || "no blockers listed"}); stopping rather than repeating an attempt that is not converging.`,
    };
  }
  return { action: "continue", reason: "Self-review still failing but the blocker set changed since the prior iteration; continuing." };
}

/** The bare `decideNextAction(state) -> "continue" | "handoff" | "abandon"` signature this issue's deliverable
 *  calls for. For the WHY behind a decision (the attempt-log needs a reason string, not just the action), use
 *  {@link decideNextActionWithReason} -- this is a thin projection over the same logic. */
export function decideNextAction(state: IterationState): IterateLoopAction {
  return decideNextActionWithReason(state).action;
}
