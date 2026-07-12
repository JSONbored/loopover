import { evaluateGovernorChokepointGate } from "./governor-chokepoint.js";
import { openGovernorState } from "./governor-state.js";

// The real cross-attempt integration point for #5134: composes governor-chokepoint.js's existing, UNMODIFIED
// evaluateGovernorChokepointGate (still exactly as pure-per-call as before -- every existing caller/test of
// it is untouched) with governor-state.js's persistence, so attempt N+1's decision actually sees attempt N's
// rate-limit/backoff outcome. Kept as a separate composing function rather than changing
// evaluateGovernorChokepointGate itself: this issue is flagged as the safety-critical core of its gap-fill
// batch, and a caller-controlled wrapper is a smaller, more isolated surface to review than a behavior change
// to an already-relied-upon function.
//
// capUsage is LOADED here (so a caller that doesn't track its own running totals still gets real prior state
// instead of silently starting from zero every call) but deliberately NOT saved here: budget-cap.ts's
// GovernorCapUsage has no mutator (unlike write-rate-limit.ts's buckets/backoff, nothing computes "the next
// capUsage" from a verdict -- the caller is the only one who knows how much THIS attempt actually spent,
// which isn't known until after the attempt runs, not at the gate-check moment). Saving the next capUsage is
// the caller's job via `saveCapUsage` once the attempt's real spend/turns/elapsed are known.

/**
 * @param {import("./governor-chokepoint-persisted.js").GovernorChokepointInputPersisted} input
 * @param {{
 *   governorState?: import("./governor-state.js").GovernorState,
 *   append?: (event: unknown) => unknown,
 * }} [options]
 * @returns {import("./governor-chokepoint.js").EvaluateGovernorChokepointGateResult}
 */
export function evaluateGovernorChokepointGatePersisted(input, options = {}) {
  const ownsGovernorState = options.governorState === undefined;
  const governorState = options.governorState ?? openGovernorState();
  try {
    const persistedRateLimit = governorState.loadRateLimitState();
    const persistedCapUsage = governorState.loadCapUsage();
    const resolvedInput = {
      ...input,
      rateLimitBuckets: input.rateLimitBuckets ?? persistedRateLimit.buckets,
      rateLimitBackoffAttempts: input.rateLimitBackoffAttempts ?? persistedRateLimit.backoffAttempts,
      capUsage: input.capUsage ?? persistedCapUsage,
    };
    const gateOptions = options.append === undefined ? {} : { append: options.append };
    const result = evaluateGovernorChokepointGate(resolvedInput, gateOptions);
    governorState.saveRateLimitState({ buckets: result.rateLimitBuckets, backoffAttempts: result.rateLimitBackoffAttempts });
    return result;
  } finally {
    if (ownsGovernorState) governorState.close();
  }
}
