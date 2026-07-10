// Reversal-health analytics card model (#2193). UI-side mirror of the AgentHealth fields from
// src/review/ops.ts surfaced on the operator-dashboard payload — plus status helpers for the card.

/** A bot auto-action a human overrode (revert of a bot-merge / reopen of a bot-close). */
export type ReversedTarget = {
  number: number;
  repo: string;
  status: string;
  eventType: string;
};

/** AgentHealth subset used by ReversalHealthCard (ops.ts:42-55). */
export type ReversalHealth = {
  reversals: number;
  reversalRate: number;
  manualRate: number;
  recentAutoActions: number;
  reversedTargets?: ReversedTarget[];
};

/** alerts.ts:204 — any human reversal of a bot auto-action is the calibration-regression signal. */
export const REVERSAL_ALERT_MIN = 1;

export function formatRatePct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function formatReversalEventType(eventType: string): string {
  if (eventType === "reversal_reverted") return "merge reverted";
  if (eventType === "reversal_reopened") return "close reopened";
  return eventType.replaceAll("_", " ");
}

export function reversalHealthStatus(health: ReversalHealth): {
  tone: "ready" | "warn" | "info";
  label: string;
} {
  if (health.recentAutoActions === 0) {
    return { tone: "info", label: "no auto-actions in window" };
  }
  if (health.reversals >= REVERSAL_ALERT_MIN) {
    return { tone: "warn", label: `${health.reversals} reversal(s)` };
  }
  return { tone: "ready", label: "0 reversals" };
}
