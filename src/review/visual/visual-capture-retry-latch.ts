// Is the visual-capture retry latch still live for this head? (#9876)
//
// THE LATCH. `visualCaptureRetryPendingSha` defers the screenshot-table gate's one-shot CLOSE while a bounded
// recapture retry is genuinely still in flight for that exact head (#9030/#9464), so a browserless outage or a
// preview deploy that has not finished building is never mistaken for "this contributor supplied no visual
// evidence". While it is live the gate can neither close the PR nor pass it.
//
// WHY IT NEEDS A CLOCK. A latch released only by code is only as reliable as the reachability of the code that
// releases it, and that reachability has now been wrong in production twice:
//
//   #9462 -- `scheduleVisualCaptureRetry` early-returned at the budget, which only skipped re-writing the
//            latch. The write from the previous attempt stood forever.
//   #9876 -- the fix for that put the clear INSIDE `scheduleVisualCaptureRetry`, but the durable per-head poll
//            budget (preview-poll-budget.ts) ends the chain by suppressing `previewPending`, so on the attempt
//            that ends it the call site's `previewPending || renderFailed` condition is false and the
//            scheduler -- clear and all -- is never called. Three contributor PRs sat frozen for an hour.
//
// Both times the code carried a comment asserting the latch "can never hold a PR forever". Both times that was
// false, because it was a claim about control flow rather than a property of the state. An age bound makes it a
// property of the state: past the deadline the latch is stale by arithmetic, whatever did or did not run. The
// sibling R2 marker in preview-poll-budget.ts already carries exactly this safeguard (BUDGET_MARKER_MAX_AGE_MS)
// for exactly this reason.
//
// This module does NOT replace the explicit releases -- those are still what makes the common case prompt. It
// is the backstop that makes "temporary" true by construction rather than by enumeration.

import { MAX_PREVIEW_POLL_ATTEMPTS, PREVIEW_POLL_SECONDS } from "./preview-poll-budget";

/** How much longer than the theoretical maximum retry chain a latch may live before it is treated as stale.
 *
 *  The chain is at most MAX_PREVIEW_POLL_ATTEMPTS hops PREVIEW_POLL_SECONDS apart, but wall-clock time is not
 *  the same as job time: a delayed job can sit behind a queue backlog, a re-review of a busy repo, or a restart.
 *  The multiplier buys that slack generously, because expiring EARLY re-arms the very false-positive close the
 *  latch exists to prevent, while expiring late only delays a decision that is already overdue. Asymmetric
 *  risk, so this errs long. */
const LATCH_DEADLINE_SLACK = 8;

/** Longest a retry latch can legitimately remain set for one head — derived from the retry budget itself, so a
 *  change to either budget dimension moves this deadline with it instead of silently invalidating it. At the
 *  current 5 attempts x 90s that is 60 minutes. */
export const VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS = MAX_PREVIEW_POLL_ATTEMPTS * PREVIEW_POLL_SECONDS * 1000 * LATCH_DEADLINE_SLACK;

/** Why the latch is not deferring the gate — surfaced so an expiry is auditable rather than silent. */
export type VisualCaptureLatchState =
  /** No latch recorded for this PR, or it was recorded against an older head that has since been superseded. */
  | { live: false; reason: "absent" }
  /** A latch for THIS head, older than any retry chain could be. The retry that justified it is never coming,
   *  so the gate must evaluate on the evidence it actually has rather than defer again. */
  | { live: false; reason: "expired"; ageMs: number }
  /** A retry for this exact head is still plausibly in flight. The gate defers. */
  | { live: true };

/**
 * PURE: decide whether the latch still defers the screenshot-table gate.
 *
 * `latchAtIso` absent (or unparseable) while `latchSha` matches reads as EXPIRED, not as live. Two reasons: a
 * row written before this column existed carries a latch at least as old as the deploy that added it, so
 * "expired" is the honest reading; and any state this function cannot date is a state it cannot bound, which is
 * precisely the failure mode the column exists to end. Defaulting the undatable case to "live" would preserve
 * the freeze for exactly the rows already stuck in it.
 */
export function visualCaptureRetryLatchState(args: {
  latchSha: string | null | undefined;
  latchAtIso: string | null | undefined;
  headSha: string | null | undefined;
  nowMs: number;
}): VisualCaptureLatchState {
  if (!args.headSha || !args.latchSha || args.latchSha !== args.headSha) return { live: false, reason: "absent" };

  const latchedAtMs = args.latchAtIso ? Date.parse(args.latchAtIso) : Number.NaN;
  // Number.isNaN covers both a missing timestamp and an unparseable one; an age computed from either is
  // meaningless, and the doc comment above explains why that resolves to expired rather than live.
  if (Number.isNaN(latchedAtMs)) return { live: false, reason: "expired", ageMs: VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS };

  // Clamped at 0 so a latch timestamped slightly in the future (clock skew between an ORB and its database)
  // reports an honest age of zero rather than a negative one, and stays live.
  const ageMs = Math.max(0, args.nowMs - latchedAtMs);
  return ageMs >= VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS ? { live: false, reason: "expired", ageMs } : { live: true };
}
