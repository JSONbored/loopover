// Governor run-loop halt gate (#2347). Consults non-convergence + budget caps at each iteration boundary,
// releases in-flight portfolio items on a fresh halt, and records the decision to the governor ledger.

import {
  buildRunLoopHaltGovernorLedgerEvent,
  evaluateRunLoopHalt,
  type GovernorCapLimits,
  type GovernorCapUsage,
  type PortfolioConvergenceInput,
  type PortfolioConvergenceThresholds,
  type RunLoopHaltVerdict,
} from "@loopover/engine";
import { appendGovernorEvent } from "./governor-ledger.js";
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
export function evaluateRunLoopBoundaryGate(
  input: EvaluateRunLoopBoundaryGateInput,
  options: { append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry } = {},
): EvaluateRunLoopBoundaryGateResult {
  const append = options.append ?? appendGovernorEvent;
  const wasHalted = Boolean(input.runHalted);
  const verdict = evaluateRunLoopHalt({
    runHalted: wasHalted,
    usage: input.usage,
    limits: input.limits,
    convergence: input.convergence,
    ...(input.convergenceThresholds !== undefined
      ? { convergenceThresholds: input.convergenceThresholds }
      : {}),
  });

  const newlyHalted = !wasHalted && verdict.shouldHalt;
  let releasedItem: QueueEntry | null = null;
  if (newlyHalted && input.inFlightItem && typeof input.markFailed === "function") {
    releasedItem = input.markFailed(input.inFlightItem.repoFullName, input.inFlightItem.identifier);
  }

  const recorded =
    newlyHalted || (!wasHalted && !verdict.shouldHalt)
      ? append(
          // Engine ledger events allow explicit `undefined` on optional fields; the miner append
          // contract uses exactOptionalPropertyTypes (`?: T` without `| undefined`).
          buildRunLoopHaltGovernorLedgerEvent(
            input.inFlightItem?.repoFullName ?? null,
            input.inFlightItem?.identifier ?? null,
            verdict,
          ) as AppendGovernorEventInput,
        )
      : null;

  return {
    verdict,
    recorded,
    runHalted: verdict.shouldHalt,
    canClaimNext: verdict.canClaimNext,
    releasedItem,
  };
}
