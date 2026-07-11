import type {
  GovernorCapLimits,
  GovernorCapUsage,
  PortfolioConvergenceInput,
  PortfolioConvergenceThresholds,
  RunLoopHaltVerdict,
} from "@jsonbored/gittensory-engine";
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

export function evaluateRunLoopBoundaryGate(
  input: EvaluateRunLoopBoundaryGateInput,
  options?: { append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry },
): EvaluateRunLoopBoundaryGateResult;
