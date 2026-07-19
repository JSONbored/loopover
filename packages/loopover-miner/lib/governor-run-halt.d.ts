import { type GovernorCapLimits, type GovernorCapUsage, type PortfolioConvergenceInput, type PortfolioConvergenceThresholds, type RunLoopHaltVerdict } from "@loopover/engine";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";
import type { QueueEntry } from "./portfolio-queue.js";
export type RunLoopInFlightItem = {
    repoFullName: string;
    identifier: string;
};
export type EvaluateRunLoopBoundaryGateInput = {
    runHalted?: boolean;
    usage: GovernorCapUsage;
    limits: GovernorCapLimits;
    convergence: PortfolioConvergenceInput;
    convergenceThresholds?: PortfolioConvergenceThresholds;
    inFlightItem?: RunLoopInFlightItem | null;
    markFailed?: (repoFullName: string, identifier: string) => QueueEntry | null;
};
export type EvaluateRunLoopBoundaryGateResult = {
    verdict: RunLoopHaltVerdict;
    recorded: GovernorLedgerEntry | null;
    runHalted: boolean;
    canClaimNext: boolean;
    releasedItem: QueueEntry | null;
};
/**
 * Evaluate run-loop halt signals before claiming the next portfolio item.
 */
export declare function evaluateRunLoopBoundaryGate(input: EvaluateRunLoopBoundaryGateInput, options?: {
    append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry;
}): EvaluateRunLoopBoundaryGateResult;
