// Governor run-loop halt gate (#2347). Consults non-convergence + budget caps at each iteration boundary,
// releases in-flight portfolio items on a fresh halt, and records the decision to the governor ledger.

import {
  buildRunLoopHaltGovernorLedgerEvent,
  evaluateRunLoopHalt,
} from "@jsonbored/gittensory-engine";
import { appendGovernorEvent } from "./governor-ledger.js";

/**
 * Evaluate run-loop halt signals before claiming the next portfolio item.
 *
 * @param {object} input
 * @param {boolean} [input.runHalted] whether the run is already halted
 * @param {import("@jsonbored/gittensory-engine").GovernorCapUsage} input.usage cumulative run usage
 * @param {import("@jsonbored/gittensory-engine").GovernorCapLimits} input.limits run ceilings
 * @param {import("@jsonbored/gittensory-engine").PortfolioConvergenceInput} input.convergence in-flight item history
 * @param {import("@jsonbored/gittensory-engine").PortfolioConvergenceThresholds} [input.convergenceThresholds]
 * @param {{ repoFullName: string, identifier: string } | null | undefined} [input.inFlightItem]
 * @param {(repoFullName: string, identifier: string) => import("./portfolio-queue.js").QueueEntry | null} [input.markFailed]
 * @param {{ append?: typeof appendGovernorEvent }} [options]
 */
export function evaluateRunLoopBoundaryGate(input, options = {}) {
  const append = options.append ?? appendGovernorEvent;
  const wasHalted = Boolean(input.runHalted);
  const verdict = evaluateRunLoopHalt({
    runHalted: wasHalted,
    usage: input.usage,
    limits: input.limits,
    convergence: input.convergence,
    convergenceThresholds: input.convergenceThresholds,
  });

  const newlyHalted = !wasHalted && verdict.shouldHalt;
  let releasedItem = null;
  if (newlyHalted && input.inFlightItem && typeof input.markFailed === "function") {
    releasedItem = input.markFailed(input.inFlightItem.repoFullName, input.inFlightItem.identifier);
  }

  const recorded =
    newlyHalted || (!wasHalted && !verdict.shouldHalt)
      ? append(
          buildRunLoopHaltGovernorLedgerEvent(
            input.inFlightItem?.repoFullName ?? null,
            input.inFlightItem?.identifier ?? null,
            verdict,
          ),
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
