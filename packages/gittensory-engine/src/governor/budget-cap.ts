// Governor budget/turn/termination cap calculator (pure).
// Deterministic, side-effect-free math for the local Governor. Given a run's cumulative usage snapshot and a
// set of ceilings it decides, per dimension, whether a cap has been reached and combines the three into one
// verdict. A SIBLING to ./rate-limit.ts, not built on top of it: rate-limit measures a rolling-WINDOW request
// rate that resets, whereas these caps are cumulative, monotonic counters across a whole run (total budget
// spent, total turns taken, elapsed session time vs. a termination ceiling) — a different shape of math with
// no window to reset. Like rate-limit.ts, this module computes numbers only: it does NOT store state, read a
// clock (elapsed time and usage are caller-supplied, exactly like rate-limit's injected `nowMs`), schedule
// anything, or gate any write action. The actual fail-closed enforcement chokepoint that composes this
// calculator with rate-limit and the non-convergence detector is separate, maintainer-owned work (#2340); this
// module only produces one of the verdicts that chokepoint (and the governor-ledger) will later consume.
import type { GovernorLedgerEventType } from "../governor-ledger.js";

/** The three independent ceilings for a whole run. A dimension with a ceiling of 0 permits no usage at all
 *  (any usage reaches it), mirroring rate-limit.ts treating `limit: 0` as "nothing allowed". */
export type GovernorCapLimits = {
  /** Maximum cumulative budget/cost units permitted for the run (may be fractional, e.g. a dollar cost). */
  budget: number;
  /** Maximum cumulative turns/iterations permitted for the run (whole counts). */
  turns: number;
  /** Termination ceiling: maximum elapsed session time in milliseconds. */
  elapsedMs: number;
};

/** A run's cumulative usage so far. Caller-supplied — this module never reads a clock or a meter itself. */
export type GovernorCapUsage = {
  /** Budget/cost already spent this run. */
  budgetSpent: number;
  /** Turns/iterations already taken this run. */
  turnsTaken: number;
  /** Elapsed session time so far in milliseconds. */
  elapsedMs: number;
};

/** One dimension's evaluation. `remaining` is headroom before the ceiling and is never negative. */
export type GovernorCapDimension = {
  /** The normalized ceiling for this dimension. */
  limit: number;
  /** The normalized usage measured against that ceiling. */
  used: number;
  /** Headroom left before the ceiling (0 once reached; never negative). */
  remaining: number;
  /** True once usage has reached OR passed the ceiling. */
  exceeded: boolean;
};

/** The combined report. `verdict` is drawn from GOVERNOR_LEDGER_EVENT_TYPES (not a parallel vocabulary) so it
 *  aligns with the events the governor-ledger records: `allowed` (all caps clear), `denied` (a budget/turn cap
 *  reached), or `kill_switch` (the termination ceiling reached — a hard wall-clock stop). */
export type GovernorCapReport = {
  verdict: GovernorLedgerEventType;
  budget: GovernorCapDimension;
  turns: GovernorCapDimension;
  termination: GovernorCapDimension;
};

// Normalize any numeric input to a finite, non-negative value (a non-finite or negative value becomes 0), so no
// input can make a verdict NaN or a remaining value negative. Mirrors rate-limit.ts's finiteNonNegativeInt but
// keeps fractional precision for continuous dimensions (budget cost, elapsed milliseconds).
function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

// Integer variant for the turn-count dimension (turns are whole iterations), matching rate-limit.ts exactly.
function finiteNonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

// Evaluate one dimension: usage reaching or passing the ceiling is `exceeded`, and headroom is clamped at 0 so
// it can never go negative. Both operands are already normalized by the caller.
function evaluateDimension(used: number, limit: number): GovernorCapDimension {
  return { limit, used, remaining: Math.max(0, limit - used), exceeded: used >= limit };
}

/**
 * Evaluate a run's cumulative usage against its budget/turn/termination ceilings. Pure: it reads the two typed
 * inputs and returns a report without mutating anything or reading a clock. Each dimension is normalized and
 * evaluated independently, then combined into one verdict — termination (a hard wall-clock ceiling) is the most
 * severe (`kill_switch`), a reached budget or turn ceiling is `denied`, and everything clear is `allowed`.
 * Every numeric input is normalized first, so a non-finite, negative, or fractional value can never produce a
 * NaN verdict or a negative remaining-budget/turns value.
 */
export function evaluateGovernorCaps(usage: GovernorCapUsage, limits: GovernorCapLimits): GovernorCapReport {
  const budget = evaluateDimension(finiteNonNegative(usage.budgetSpent), finiteNonNegative(limits.budget));
  const turns = evaluateDimension(finiteNonNegativeInt(usage.turnsTaken), finiteNonNegativeInt(limits.turns));
  const termination = evaluateDimension(finiteNonNegative(usage.elapsedMs), finiteNonNegative(limits.elapsedMs));
  const verdict: GovernorLedgerEventType = termination.exceeded
    ? "kill_switch"
    : budget.exceeded || turns.exceeded
      ? "denied"
      : "allowed";
  return { verdict, budget, turns, termination };
}
