import type { GovernorChokepointInput } from "@jsonbored/gittensory-engine";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";
import type { EvaluateGovernorChokepointGateResult } from "./governor-chokepoint.js";
import type { GovernorState } from "./governor-state.js";

// rateLimitBuckets/rateLimitBackoffAttempts/capUsage are required on GovernorChokepointInput itself, but this
// wrapper auto-supplies them from persisted state when the caller omits them -- loosen just those three to
// optional so a caller that WANTS the persisted defaults doesn't have to fake a value just to satisfy the type.
export type GovernorChokepointInputPersisted = Omit<GovernorChokepointInput, "rateLimitBuckets" | "rateLimitBackoffAttempts" | "capUsage"> &
  Partial<Pick<GovernorChokepointInput, "rateLimitBuckets" | "rateLimitBackoffAttempts" | "capUsage">>;

export function evaluateGovernorChokepointGatePersisted(
  input: GovernorChokepointInputPersisted,
  options?: {
    governorState?: GovernorState;
    append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry;
  },
): EvaluateGovernorChokepointGateResult;
