// Closed-loop discovery re-entry policy (#2338): the pure decision half of "on a resolved outcome (merged, or
// rejected-and-disengaged), automatically re-invoke discovery to select the next candidate." Deliberately split
// from the miner-side orchestrator (packages/gittensory-miner/lib/loop-reentry.js), which owns the REAL IO --
// reading recent event-ledger history to compute the tallies this policy consumes, dequeuing the next
// candidate, and transitioning run-state -- mirroring this session's established engine (pure) / miner-lib
// (stateful) split for every other governor primitive.
//
// TOP SLOP-AT-SCALE RISK: this issue's own framing calls out "a bug here (re-entering too fast, ignoring a
// circuit-breaker, or looping on a permanently-rejected repo) is the top slop-at-scale risk for the whole miner
// subsystem." Both failure modes get an INDEPENDENT hard ceiling here, neither one masking the other:
//   - A per-repo circuit breaker: N consecutive disengaged (rejected) outcomes on the SAME repo pauses further
//     re-entry for that repo, regardless of how much of the hour/session rate budget remains.
//   - A hard rate/session cap: independent of any repo's own history, a conservative ceiling on how many
//     re-entries may fire in a rolling hour or across the whole session.
// Both reasons are collected (not short-circuited) so a caller logging the decision sees every ceiling that
// was hit, not just the first one checked.
//
// KILL-SWITCH (#2339): checked FIRST, before any other logic -- flipping the kill-switch must halt any pending
// re-entry immediately, the same way it halts the Governor chokepoint (#2340). Reuses
// `isMinerKillSwitchActive` (kill-switch.ts, #2341) directly -- the identical shared helper
// `submission-gate.ts`'s `shouldSubmit` consults, per #2339's own "single shared helper, not duplicated per
// call site" deliverable. Unlike the reasons above, the kill-switch check DOES short-circuit (an active kill-
// switch is the only reason reported) -- "as their FIRST guard, before any other logic" reads as "don't even
// evaluate the rest," not "collect this alongside the rest."

import { isMinerKillSwitchActive, type MinerKillSwitchScope } from "../governor/kill-switch.js";

/** The terminal outcome that just resolved for the repo the caller is considering re-entering on. */
export type LoopReentryOutcome = "merged" | "disengaged" | "other";

export const DEFAULT_MAX_CONSECUTIVE_DISENGAGEMENTS = 3;
export const DEFAULT_MAX_REENTRIES_PER_HOUR = 4;
export const DEFAULT_MAX_REENTRIES_PER_SESSION = 20;

export type LoopReentryCandidate = {
  /** Checked FIRST, before any other field below -- see the module doc comment's KILL-SWITCH section. */
  killSwitchScope: MinerKillSwitchScope;
  repoFullName: string;
  outcome: LoopReentryOutcome;
  /** Caller-computed count of CONSECUTIVE `"disengaged"` outcomes for this repo, ending with (and including,
   *  when `outcome === "disengaged"`) this one. Any non-disengaged outcome resets this to 0 -- the caller owns
   *  that computation, this policy only consumes the resulting integer (mirrors `reputation-throttle.ts`'s
   *  caller-supplied `RepoOutcomeHistory`). */
  consecutiveDisengagements: number;
  maxConsecutiveDisengagements?: number | undefined;
  /** Caller-tracked re-entry counters for the hard rate/session cap -- independent of the per-repo circuit
   *  breaker above. */
  reentriesThisHour: number;
  maxReentriesPerHour?: number | undefined;
  reentriesThisSession: number;
  maxReentriesPerSession?: number | undefined;
};

export type LoopReentryDecision = {
  reenter: boolean;
  /** Always populated when `reenter` is `false`; every ceiling that was hit, not just the first. */
  reasons: string[];
};

/**
 * Decide whether the loop may re-enter discovery for this repo. Pure; identical inputs always yield the
 * identical decision. `outcome === "merged"` alone never bypasses the rate/session cap -- a healthy repo can
 * still be rate-limited if the operator-wide ceiling is already spent. The kill-switch is checked FIRST and
 * short-circuits everything else -- an active kill-switch blocks unconditionally.
 */
export function shouldReenter(candidate: LoopReentryCandidate): LoopReentryDecision {
  if (isMinerKillSwitchActive(candidate.killSwitchScope)) {
    return { reenter: false, reasons: [`${candidate.killSwitchScope}_kill_switch_active`] };
  }

  const reasons: string[] = [];
  const maxConsecutiveDisengagements = candidate.maxConsecutiveDisengagements ?? DEFAULT_MAX_CONSECUTIVE_DISENGAGEMENTS;
  const maxReentriesPerHour = candidate.maxReentriesPerHour ?? DEFAULT_MAX_REENTRIES_PER_HOUR;
  const maxReentriesPerSession = candidate.maxReentriesPerSession ?? DEFAULT_MAX_REENTRIES_PER_SESSION;

  if (candidate.outcome === "disengaged" && candidate.consecutiveDisengagements >= maxConsecutiveDisengagements) {
    reasons.push(`repo_paused_after_consecutive_disengagements:${candidate.consecutiveDisengagements}>=${maxConsecutiveDisengagements}`);
  }
  if (candidate.reentriesThisHour >= maxReentriesPerHour) {
    reasons.push(`hourly_reentry_cap_reached:${candidate.reentriesThisHour}>=${maxReentriesPerHour}`);
  }
  if (candidate.reentriesThisSession >= maxReentriesPerSession) {
    reasons.push(`session_reentry_cap_reached:${candidate.reentriesThisSession}>=${maxReentriesPerSession}`);
  }

  return { reenter: reasons.length === 0, reasons };
}
