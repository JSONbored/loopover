import type { MinerKillSwitchScope } from "@loopover/engine";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";
export type CheckMinerKillSwitchInput = {
    repoPaused?: boolean;
    env?: Record<string, string | undefined>;
};
export type CheckMinerKillSwitchResult = {
    scope: MinerKillSwitchScope;
    active: boolean;
};
/**
 * Resolve the current kill-switch scope for a repo from process env plus a per-repo paused flag (typically
 * `MinerGoalSpec.killSwitch.paused` from the repo's parsed `.loopover-miner.yml`).
 */
export declare function checkMinerKillSwitch(input?: CheckMinerKillSwitchInput): CheckMinerKillSwitchResult;
export type RecordMinerKillSwitchTransitionInput = {
    repoFullName?: string;
    actionClass: string;
    previousScope: MinerKillSwitchScope;
    scope: MinerKillSwitchScope;
};
/**
 * Record a kill-switch state transition to the governor ledger. No-op (returns null, appends nothing) when the
 * scope has not actually changed since the previous check — callers own tracking the previous scope (in-memory
 * or persisted); this module holds no state of its own.
 */
export declare function recordMinerKillSwitchTransition(input: RecordMinerKillSwitchTransitionInput, options?: {
    append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry;
}): GovernorLedgerEntry | null;
