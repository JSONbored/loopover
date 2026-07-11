// Governor run-loop halt enforcement (#2347): composes the pure non-convergence detector and the
// budget/turn/termination cap calculator at every iteration boundary before the portfolio queue claims
// the next item. Either signal tripping halts the current run; the caller releases in-flight work and
// blocks further claims until a human clears the halt.

import type { GovernorLedgerEvent, GovernorLedgerEventType } from "../governor-ledger.js";
import {
  classifyPortfolioConvergence,
  DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS,
  type PortfolioConvergenceInput,
  type PortfolioConvergenceThresholds,
} from "../portfolio/non-convergence.js";
import {
  evaluateGovernorCaps,
  type GovernorCapLimits,
  type GovernorCapReport,
  type GovernorCapUsage,
} from "./budget-cap.js";

/** Issue vocabulary alias for the pure budget/turn/termination cap calculator. */
export const evaluateBudgetCaps = evaluateGovernorCaps;

export type NonConvergenceSignal = {
  tripped: boolean;
  status: ReturnType<typeof classifyPortfolioConvergence>["status"];
  reasons: string[];
};

/** Issue vocabulary wrapper over {@link classifyPortfolioConvergence}. */
export function detectNonConvergence(
  input: PortfolioConvergenceInput,
  thresholds: PortfolioConvergenceThresholds = DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS,
): NonConvergenceSignal {
  const verdict = classifyPortfolioConvergence(input, thresholds);
  return {
    tripped: verdict.status === "non_convergent",
    status: verdict.status,
    reasons: verdict.reasons,
  };
}

export type RunLoopHaltReason =
  | "cleared"
  | "prior_halt"
  | "non_convergence"
  | "budget_exceeded"
  | "turn_cap_exceeded"
  | "termination_cap_exceeded";

export type RunLoopHaltVerdict = {
  shouldHalt: boolean;
  canClaimNext: boolean;
  reason: RunLoopHaltReason;
  convergence: NonConvergenceSignal;
  caps: GovernorCapReport;
  ledgerEventType: GovernorLedgerEventType;
  ledgerReason: string;
};

function haltVerdict(
  reason: RunLoopHaltReason,
  convergence: NonConvergenceSignal,
  caps: GovernorCapReport,
  ledgerEventType: GovernorLedgerEventType,
  ledgerReason: string,
): RunLoopHaltVerdict {
  return {
    shouldHalt: true,
    canClaimNext: false,
    reason,
    convergence,
    caps,
    ledgerEventType,
    ledgerReason,
  };
}

/**
 * Consult non-convergence and budget caps at a run-loop iteration boundary. A prior halt sticks until
 * the caller clears it; otherwise either signal tripping halts the run and blocks further queue claims.
 */
export function evaluateRunLoopHalt(input: {
  runHalted: boolean;
  usage: GovernorCapUsage;
  limits: GovernorCapLimits;
  convergence: PortfolioConvergenceInput;
  convergenceThresholds?: PortfolioConvergenceThresholds;
}): RunLoopHaltVerdict {
  const convergence = detectNonConvergence(input.convergence, input.convergenceThresholds);
  const caps = evaluateGovernorCaps(input.usage, input.limits);

  if (input.runHalted) {
    return haltVerdict("prior_halt", convergence, caps, "denied", "run_already_halted");
  }

  if (caps.verdict === "kill_switch") {
    return haltVerdict(
      "termination_cap_exceeded",
      convergence,
      caps,
      "kill_switch",
      "termination_cap_exceeded",
    );
  }
  if (caps.budget.exceeded) {
    return haltVerdict("budget_exceeded", convergence, caps, "denied", "budget_cap_exceeded");
  }
  if (caps.turns.exceeded) {
    return haltVerdict("turn_cap_exceeded", convergence, caps, "denied", "turn_cap_exceeded");
  }
  if (convergence.tripped) {
    return haltVerdict(
      "non_convergence",
      convergence,
      caps,
      "denied",
      "non_convergence_detected",
    );
  }

  return {
    shouldHalt: false,
    canClaimNext: true,
    reason: "cleared",
    convergence,
    caps,
    ledgerEventType: "allowed",
    ledgerReason: "under_limit",
  };
}

/** Reset latch after an operator clears a halted run. */
export function clearRunLoopHalt(): { runHalted: false } {
  return { runHalted: false };
}

/** Governor-ledger row for a run-loop halt decision (#2347 deliverable). */
export function buildRunLoopHaltGovernorLedgerEvent(
  repoFullName: string | null | undefined,
  inFlightIdentifier: string | null | undefined,
  verdict: RunLoopHaltVerdict,
): GovernorLedgerEvent {
  return {
    eventType: verdict.ledgerEventType,
    repoFullName,
    actionClass: "run_loop",
    decision: verdict.shouldHalt ? "halt" : "continue",
    reason: verdict.ledgerReason,
    payload: {
      haltReason: verdict.reason,
      convergenceStatus: verdict.convergence.status,
      convergenceReasons: verdict.convergence.reasons,
      budgetExceeded: verdict.caps.budget.exceeded,
      turnsExceeded: verdict.caps.turns.exceeded,
      terminationExceeded: verdict.caps.termination.exceeded,
      inFlightIdentifier: inFlightIdentifier ?? null,
    },
  };
}
