// Per-attempt cost/turn metering (#4311): pure accumulation of a coding-agent attempt's usage
// (tokens / turns / wall-clock / cost) plus a pure evaluation of the running totals against a configured
// budget. Numbers only — no IO, no Date.now(), no randomness, no enforcement. This module reports whether a
// ceiling has been reached; it never stops, kills, or gates a driver. That enforcement wiring (graceful-stop
// vs. hard SIGKILL) and the attempt-log persistence (#4294) are separate, maintainer-owned concerns.
//
// Mirrors the governor/rate-limit.ts discipline ("computes numbers only... does NOT store state, schedule,
// or gate any write action"). Drivers report usage in different native shapes (CLI-subprocess vs. Agent-SDK);
// the caller normalizes each increment to the {tokens, turns, wallClockMs, costUsd} unit defined here.

/** One usage increment normalized to the metered unit. `costUsd` is 0 when a driver can't report spend. */
export type AttemptUsage = {
  /** Model tokens consumed (prompt + completion) in this increment. */
  tokens: number;
  /** Agent turns (one full agent iteration) in this increment. */
  turns: number;
  /** Wall-clock milliseconds elapsed in this increment. */
  wallClockMs: number;
  /** Monetary cost (USD) of this increment; 0 when the driver does not report spend. */
  costUsd: number;
};

/** Accumulated attempt totals — same shape as a single increment. */
export type AttemptMeterTotals = AttemptUsage;

/** Per-axis ceilings. An omitted axis means "no limit on that axis". */
export type AttemptBudget = {
  maxTokens?: number;
  maxTurns?: number;
  maxWallClockMs?: number;
  maxCostUsd?: number;
};

/** Which metered axes have reached or exceeded their ceiling. */
export type AttemptBudgetAxis = "tokens" | "turns" | "wallClockMs" | "costUsd";

export type AttemptMeterVerdict = {
  totals: AttemptMeterTotals;
  /** True when no axis has reached its ceiling. */
  withinBudget: boolean;
  /** The axes at/over ceiling (empty when within budget). */
  breaches: AttemptBudgetAxis[];
};

const ZERO_USAGE: AttemptUsage = { tokens: 0, turns: 0, wallClockMs: 0, costUsd: 0 };

/** Fold one usage increment into a running total. Pure — returns a new total, mutates nothing. */
export function accumulateAttemptUsage(
  total: AttemptMeterTotals,
  next: AttemptUsage,
): AttemptMeterTotals {
  return {
    tokens: total.tokens + next.tokens,
    turns: total.turns + next.turns,
    wallClockMs: total.wallClockMs + next.wallClockMs,
    costUsd: total.costUsd + next.costUsd,
  };
}

/** Sum a sequence of usage increments from zero. Pure. */
export function meterAttemptUsage(increments: readonly AttemptUsage[]): AttemptMeterTotals {
  return increments.reduce(accumulateAttemptUsage, { ...ZERO_USAGE });
}

/**
 * Evaluate accumulated totals against a budget. An axis is breached when its total is **at or above** its
 * ceiling (`>=`), so a total exactly equal to the ceiling counts as a breach — the boundary the caller must
 * stop on. An omitted ceiling never breaches. Pure and deterministic.
 */
export function evaluateAttemptBudget(
  totals: AttemptMeterTotals,
  budget: AttemptBudget,
): AttemptMeterVerdict {
  const breaches: AttemptBudgetAxis[] = [];
  if (budget.maxTokens !== undefined && totals.tokens >= budget.maxTokens) breaches.push("tokens");
  if (budget.maxTurns !== undefined && totals.turns >= budget.maxTurns) breaches.push("turns");
  if (budget.maxWallClockMs !== undefined && totals.wallClockMs >= budget.maxWallClockMs) {
    breaches.push("wallClockMs");
  }
  if (budget.maxCostUsd !== undefined && totals.costUsd >= budget.maxCostUsd) breaches.push("costUsd");
  return { totals, withinBudget: breaches.length === 0, breaches };
}
