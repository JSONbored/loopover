// Shared PR-disposition core (#8759, epic #8757). The #8711 incident's root CLASS was four surfaces —
// the disposition planner (agent-actions.ts), the executor's live rechecks (agent-action-executor.ts),
// the unified comment's status derivation (unified-comment.ts, via the bridge), and the review-state
// labels — each re-deriving its own meaning for GitHub's raw `mergeable_state` string, with four
// different subsets treated as "bad" (comment {dirty,behind,unstable}; merge !== "clean"; approve
// {dirty}; hold-label ∅ pre-#8758). #8758 unified the PREDICATES; this module removes the CLASS by
// giving every surface ONE place the raw string is interpreted and ONE shared held/approve/merge
// assessment derived from it.
//
// PURE AND DEPENDENCY-FREE by design: agent-actions.ts (the planner), processors.ts (the comment
// bridge's caller), and the executor all import from here; this file imports nothing of theirs, so it
// can never participate in a cycle. The self-contained unified-comment.ts still receives plain data
// (the bridge passes the RESOLVED assessment, never an import), preserving its zero-import contract.
//
// INVARIANT CONTRACT (pinned by test/unit/pr-disposition-invariants.test.ts): for any input state,
//   • approve is never allowed while the state is one merge would refuse for a reason no other rail
//     resolves (assessment "conflict" → the close path owns it; "unstable" → CI itself owns it, #10116);
//   • "behind" never holds (the rebase rail owns it) and stays approvable;
//   • "blocked"/"unknown"/absent stay approvable (the bot's own approval can be the unblocking act,
//     and a transient null must not spray hold labels);
//   • merge requires exactly "clean" — the strictest predicate, unchanged since before #8758.

/** Every meaning the raw GitHub `mergeable_state` string carries for the disposition surfaces. This is
 *  THE single interpretation point — no other module may compare the raw string against a literal. */
export type MergeableAssessment =
  /** Safe to merge right now (the only state `canMerge` accepts). */
  | "clean"
  /** Hard base conflict — the CLOSE path's business (`isConflict`), never approve, never hold-label. */
  | "conflict"
  /** Behind the base — the rebase rail's business; approvable, never a manual hold. */
  | "behind"
  /** Required checks green but a non-required check/status is not, OR checks are still running — GitHub
   *  reports the same string for both. Merge self-suppresses, so approve must too, or the PR lands in
   *  #8711's "approved, labeled ready, never merged, nobody told" stall. It is NOT a manual hold (#10116):
   *  the state is visible on the PR's own Checks tab and resolves itself on the next push, so no maintainer
   *  is summoned for something CI has already answered. */
  | "unstable"
  /** blocked / unknown / null / anything else: not mergeable YET, but approvable — the missing piece may
   *  be the bot's own approval (blocked) or a transient computation (unknown). Never a hold. */
  | "indeterminate";

export function assessMergeableState(state: string | null | undefined): MergeableAssessment {
  switch ((state ?? "").toLowerCase()) {
    case "clean":
      return "clean";
    case "dirty":
      return "conflict";
    case "behind":
      return "behind";
    case "unstable":
      return "unstable";
    default:
      return "indeterminate";
  }
}

/**
 * Every input that SUPPRESSES a would-merge into a manual hold, as DATA (#9738).
 *
 * The input type, the `heldForManualReview` formula, and every test fixture are derived from this table, so
 * adding a hold is one entry rather than three edits that can each be forgotten independently -- which is
 * exactly how a hold gets declared and then silently not folded into the decision. The value documents WHY
 * the input holds; nothing reads it as text today, and it is the natural place for a ledger reason to come
 * from when one is wanted.
 *
 * A hold NEVER closes a PR. Each of these downgrades a merge into a held-for-review state and nothing more.
 */
const MERGE_HOLD_INPUTS = {
  guardrailHit: "the PR touches a hard-guardrail path",
  migrationCollisionHold: "two migrations claim the same number",
  unlinkedIssueMatchHold: "an unlinked issue appears to match this work",
  advisoryCheckHold: "an advisory check the maintainer configured is not passing",
  priorityEligibilityHold: "the linked priority issue's eligibility window has not elapsed",
  screenshotEvidenceHold: "the screenshot-table gate is set to block and the PR has no visual evidence",
  unlinkedIssueMatchCloseWithoutCloseActing: "a repeat unlinked-issue match while close autonomy is off",
} as const;

export type MergeHoldInput = keyof typeof MERGE_HOLD_INPUTS;

/** The table's keys, resolved once. Exported so a caller (or a test fixture) can enumerate every hold
 *  without restating them -- the restatement is the thing this table exists to remove. */
export const MERGE_HOLD_INPUT_KEYS = Object.keys(MERGE_HOLD_INPUTS) as MergeHoldInput[];

/** The hold inputs every surface must agree on. Each field mirrors the planner input of the same name —
 *  the caller (planner or processors.ts) resolves them once and both surfaces read the same values. */
export type PrDispositionInput = Record<MergeHoldInput, boolean> & {
  mergeableState: string | null | undefined;
  /** Gate conclusion success/neutral AND required CI passed — the only thing that earns approve/merge. */
  reviewGood: boolean;
  /** #9810 follow-up: GitHub says `unstable`, but the ONLY non-passing check explaining it is one the
   *  maintainer listed in `gate.ignoredCheckRuns`. LoopOver's own CI aggregate already excludes such a run --
   *  yet `mergeable_state` is GitHub's computation, not ours, and it stays "unstable" while the check exists
   *  at all. Without this the ignore was half-effective: the check no longer failed the gate, and the PR was
   *  held anyway (observed on JSONbored/loopover#9816, reason "mergeable_state is unstable — non-required
   *  check(s) not passing: Contributor trust"). Set ONLY when nothing else adverse was seen. */
  unstableExplainedByIgnoredChecks?: boolean | undefined;
  /** #9808 second half: the `guardrailHit` hold was CLEARED by a clean escalated review — see `releasedHolds`
   *  in derivePrDisposition. Resolved by the caller (agent-actions.ts), which requires ALL of:
   *  `guardrailEscalation.onCleanReview: proceed` configured, at least one escalation knob actually set (the
   *  extra scrutiny must exist before it can vouch for anything), and reviewGood (gate success — which folds in
   *  the AI verdict's blockers — plus green CI). Releases ONLY the guardrail term; every other hold in
   *  MERGE_HOLD_INPUTS is untouched. Default false ⇒ byte-identical to the pre-#9808 behaviour. */
  guardrailEscalationCleared?: boolean | undefined;
};

export type PrDisposition = {
  mergeable: MergeableAssessment;
  /** The SAME formula agent-actions.ts's heldForManualReview computes — one definition, two readers. */
  heldForManualReview: boolean;
  /** #9991: which declared inputs actually held, in MERGE_HOLD_INPUTS declaration order. Empty when the only
   *  suppressor is the unstable mergeable state — that is GitHub's computation, not one of our declared hold
   *  inputs, and it is reported by `heldForUnstableMergeState` instead. */
  heldBy: MergeHoldInput[];
  /** True when the ONLY thing suppressing a would-merge is the unstable mergeable state. Since #10116 this
   *  is REPORTING, not a hold: the planner reads it to choose NO disposition label (neither `manual-review`
   *  nor `ready-to-merge`), and the comment surface reads it to refuse the "safe to merge" claim. It is a
   *  separate field from `heldForManualReview` precisely so those two can differ — "not ready" and "a human
   *  must act" were conflated here, and the conflation is what labelled every in-flight PR. */
  heldForUnstableMergeState: boolean;
  /** reviewGood && not held && not the close path's conflict — the approve gate's shared core. The
   *  planner still conjoins its own idempotency/autonomy terms (reviewDecision, approvedHeadSha,
   *  acting("approve")) — those are planner-private state, not disposition. */
  wouldApprove: boolean;
  /** reviewGood && not held && exactly-clean — the merge gate's shared core. The planner still conjoins
   *  approvalsSatisfied / mergeTerminallyBlocked / acting("merge") — planner-private state. */
  wouldMerge: boolean;
  /** The comment surface's readiness downgrade: an otherwise-"ready" status must render held for any
   *  state in this set (conflict/behind/unstable — never claim "safe to merge" while GitHub disagrees),
   *  mirroring deriveUnifiedStatus's historical {dirty, behind, unstable} set exactly. */
  commentMergeStateHeld: boolean;
};

export function derivePrDisposition(input: PrDispositionInput): PrDisposition {
  const mergeable = assessMergeableState(input.mergeableState);
  // An "unstable" state that ONLY an ignored check explains carries no signal a maintainer asked to act on:
  // they explicitly declared that check meaningless for this repo. Every other unstable cause still holds.
  const unstableHolds = mergeable === "unstable" && input.unstableExplainedByIgnoredChecks !== true;
  // Derived from MERGE_HOLD_INPUTS, so a hold declared in that table is folded in by construction and a
  // new one can never be added-but-not-honoured.
  //
  // #9808: a hold may also be explicitly RELEASED. A guardrail hit whose escalated review came back clean no
  // longer summons a human -- the guarded path is protected by the escalated review instead of by a queue.
  // Expressed as a release map rather than by dropping the term, so the table stays the single declaration of
  // what holds and this stays the single declaration of what can lift one.
  const releasedHolds: Partial<Record<MergeHoldInput, boolean>> = {
    guardrailHit: input.guardrailEscalationCleared === true,
  };
  // #9991: WHICH inputs held, not merely whether any did. This was a `.some(...)` over exactly this set that
  // threw the answer away, which is why the ledger could only fall back to the gate conclusion -- leaving 518
  // holds on the production Orb filed under reason "success", a bucket conflating seven distinct mechanisms
  // that #9729 cannot run a per-path clearance against.
  //
  // Filtered from MERGE_HOLD_INPUT_KEYS rather than restated, so a hold added to the table is enumerated here
  // automatically -- restatement is the thing that table exists to remove. Order is the table's own
  // declaration order, which makes the recorded cause deterministic for identical inputs.
  const heldBy = MERGE_HOLD_INPUT_KEYS.filter((key) => input[key] === true && releasedHolds[key] !== true);
  // #10116: an unstable merge state NO LONGER summons a human. GitHub reports `unstable` for checks that are
  // failing OR still running, so this term was labelling `manual-review` on every PR whose CI had not finished
  // -- the dominant cause of the held-with-`reason_code: success` records on the production Orb, and pure
  // noise on a repo meant to run autonomously. Neither case wants a maintainer: a pending PR is simply not
  // ready, and a failing one has already been answered by CI, so the contributor fixes CI rather than a human
  // reviewing something that cannot merge.
  //
  // This does NOT make an unstable PR mergeable. `wouldMerge` requires `mergeable === "clean"` independently,
  // and `reviewGood` requires green CI, so both remain false. What changes is only whether a human is summoned.
  const heldForManualReview = heldBy.length > 0;
  // Still reported, and still true: the comment surface reads it to refuse the "safe to merge" claim (#8758).
  // Saying "this is not ready" is useful; escalating it to a maintainer is not.
  const heldForUnstableMergeState = unstableHolds;
  // `!unstableHolds` is now EXPLICIT rather than riding on heldForManualReview. It used to be implied by the
  // unstable term above, and dropping that term without restating it here would let approve fire on an
  // unstable PR while merge self-suppressed -- exactly #8711's "approved, labeled ready, never merged, nobody
  // told" incident. `reviewGood` alone does not cover it: our own CI aggregate can read passed while GitHub
  // still reports unstable for a non-required check.
  //
  // Keyed on `unstableHolds`, NOT on `mergeable === "unstable"`. The difference is #9810: an instability
  // explained solely by a check the maintainer declared meaningless must stay APPROVABLE, and a blanket
  // mergeable-state test would silently un-fix that. Caught by its own test when I first wrote it too broadly.
  const wouldApprove = input.reviewGood && !heldForManualReview && mergeable !== "conflict" && !unstableHolds;
  const wouldMerge = input.reviewGood && !heldForManualReview && mergeable === "clean";
  // The comment's historical downgrade set, byte-identical to deriveUnifiedStatus's own
  // {dirty, behind, unstable} check (#ready-needs-mergeable / #pr-5288-confusing-verdict): "behind"
  // downgrades the COMMENT's "safe to merge" claim (the rebase hasn't happened yet) even though it never
  // holds the PLANNER (the rebase rail acts) — a deliberate, documented asymmetry, not drift: the two
  // surfaces answer different questions ("is it safe to claim mergeable NOW" vs "should a human step in").
  const commentMergeStateHeld = mergeable === "conflict" || mergeable === "behind" || unstableHolds;
  return { mergeable, heldForManualReview, heldBy, heldForUnstableMergeState, wouldApprove, wouldMerge, commentMergeStateHeld };
}

/** The comment surface's merge-state downgrade as a standalone predicate (#8759): the bridge
 *  (unified-comment-bridge.ts) resolves it and passes the BOOLEAN into the self-contained renderer, so
 *  unified-comment.ts keeps its zero-import contract while reading the same interpretation the planner
 *  uses. Equal by construction to derivePrDisposition(...).commentMergeStateHeld -- including the
 *  `unstableExplainedByIgnoredChecks` term (#10055): a state-only interpretation of "unstable" went stale
 *  the moment that flag was added to PrDispositionInput, since a caller that never threads it through still
 *  held a PR the planner had already stopped holding. `unstableExplainedByIgnoredChecks` defaults to
 *  `undefined` so every existing caller that cannot resolve it keeps today's behaviour byte-identical. */
export function isCommentMergeStateHeld(
  state: string | null | undefined,
  unstableExplainedByIgnoredChecks?: boolean | undefined,
): boolean {
  const mergeable = assessMergeableState(state);
  // Identical to derivePrDisposition's own `unstableHolds` term (line 132) by design -- the two must never
  // be able to drift back apart.
  const unstableHolds = mergeable === "unstable" && unstableExplainedByIgnoredChecks !== true;
  return mergeable === "conflict" || mergeable === "behind" || unstableHolds;
}
