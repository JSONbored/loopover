import type { GovernorChokepointInput } from "@loopover/engine";
import type { EvaluateGovernorChokepointGateResult } from "./governor-chokepoint.js";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";
import type { GovernorState } from "./governor-state.js";
export type GovernorChokepointInputPersisted = Omit<GovernorChokepointInput, "rateLimitBuckets" | "rateLimitBackoffAttempts" | "capUsage"> & Partial<Pick<GovernorChokepointInput, "rateLimitBuckets" | "rateLimitBackoffAttempts" | "capUsage">>;
export type EvaluateGovernorChokepointGatePersistedOptions = {
    governorState?: GovernorState;
    append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry;
};
export declare function evaluateGovernorChokepointGatePersisted(input: GovernorChokepointInputPersisted, options?: EvaluateGovernorChokepointGatePersistedOptions): EvaluateGovernorChokepointGateResult;
