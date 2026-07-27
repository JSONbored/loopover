// Clock-injected staleness rule evaluation (#9028, epic #8828 Phase 4) — the two `gate.*` staleness rules
// as PURE functions of their inputs plus an explicitly supplied instant.
//
// Why this module exists: `requireFreshRebaseWindowMinutes` was evaluated by reading `Date.now()` inline
// inside an IO helper (processors.ts `maybeForceFreshRebase`). That made the rule structurally unreplayable
// — nothing recorded WHICH instant the comparison used, so re-deriving the decision later could silently
// reach the opposite answer purely because the wall clock had moved. Time is a decision INPUT; an input that
// is not recorded is not replayable. The engine now reads one decision-time instant per pass, records it into
// `decision_replay_inputs.replay_json`, and every clock-dependent rule reads THAT instant rather than the
// clock (see `DecisionReplayInput.clock`).
//
// `staleBaseAheadByThreshold` is deliberately included here even though it reads NO clock: it is a commit-COUNT
// comparison (`aheadBy >= threshold`), so it is instant-independent by construction. Stating that as a pure,
// tested function is what makes the property provable rather than assumed — the replay suite pins it by
// evaluating the same inputs at wildly different instants and asserting an identical answer.

/** Minutes → milliseconds, named so the fresh-rebase window's unit conversion has exactly one definition. */
export const MS_PER_MINUTE = 60_000;

/** The decision-time wall clock, captured ONCE per evaluation pass and recorded with the replay input. Every
 *  clock-dependent gate rule reads this instead of calling `Date.now()` itself, so a replay re-derives the
 *  same answer the live pass reached instead of whatever the clock happens to say at replay time. */
export type DecisionClockCapture = {
  /** Unix epoch milliseconds, from a single `Date.now()` read at the top of the decision pass. */
  nowMs: number;
};

/**
 * `gate.requireFreshRebaseWindow` (#2552): true when the base branch's tip commit landed WITHIN
 * `windowMinutes` of `nowMs` — i.e. the base moved so recently that a `mergeable_state: clean` read may
 * predate it, so a merge should be preceded by a forced rebase + CI recheck.
 *
 * PURE and total: an unparseable/non-finite `baseAdvancedAtMs` returns false (fail-open to today's behavior —
 * an unreadable base commit must never manufacture a rebase), matching the live call site's own guard. A base
 * commit dated in the FUTURE relative to the captured instant (clock skew between GitHub and this engine)
 * yields a negative age, which is inside any positive window and therefore correctly reads as "just moved".
 */
export function isWithinFreshRebaseWindow(args: { baseAdvancedAtMs: number; windowMinutes: number; nowMs: number }): boolean {
  const { baseAdvancedAtMs, windowMinutes, nowMs } = args;
  if (!Number.isFinite(baseAdvancedAtMs)) return false;
  return nowMs - baseAdvancedAtMs < windowMinutes * MS_PER_MINUTE;
}

/**
 * `gate.staleBaseAheadByThreshold` (#review-grounding stale-base fact): true when the repo's default branch
 * has advanced at least `threshold` commits beyond this PR's head, so the PR should be updated before review.
 *
 * PURE, total, and deliberately CLOCK-FREE — a commit count carries no notion of "now", so this rule's answer
 * is identical at every instant. A non-finite `aheadBy` (an unreadable compare API response) returns false,
 * fail-open, matching the live call site's `typeof aheadBy === "number"` guard.
 */
export function isBaseStaleByAheadBy(args: { aheadBy: number; threshold: number }): boolean {
  const { aheadBy, threshold } = args;
  if (!Number.isFinite(aheadBy)) return false;
  return aheadBy >= threshold;
}
