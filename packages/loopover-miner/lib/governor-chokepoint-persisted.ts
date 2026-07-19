import type { GovernorChokepointInput } from "@loopover/engine";
import { evaluateGovernorChokepointGate } from "./governor-chokepoint.js";
import type { EvaluateGovernorChokepointGateResult } from "./governor-chokepoint.js";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";
import { openGovernorState } from "./governor-state.js";
import type { GovernorState } from "./governor-state.js";

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

// rateLimitBuckets/rateLimitBackoffAttempts/capUsage are required on GovernorChokepointInput itself, but this
// wrapper auto-supplies them from persisted state when the caller omits them -- loosen just those three to
// optional so a caller that WANTS the persisted defaults doesn't have to fake a value just to satisfy the type.
export type GovernorChokepointInputPersisted = Omit<GovernorChokepointInput, "rateLimitBuckets" | "rateLimitBackoffAttempts" | "capUsage"> &
  Partial<Pick<GovernorChokepointInput, "rateLimitBuckets" | "rateLimitBackoffAttempts" | "capUsage">>;

export type EvaluateGovernorChokepointGatePersistedOptions = {
  governorState?: GovernorState;
  append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry;
};

export function evaluateGovernorChokepointGatePersisted(
  input: GovernorChokepointInputPersisted,
  options: EvaluateGovernorChokepointGatePersistedOptions = {},
): EvaluateGovernorChokepointGateResult {
  const ownsGovernorState = options.governorState === undefined;
  const governorState = options.governorState ?? openGovernorState();
  try {
    const persistedRateLimit = governorState.loadRateLimitState();
    const persistedCapUsage = governorState.loadCapUsage();
    const resolvedInput: GovernorChokepointInput = {
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
