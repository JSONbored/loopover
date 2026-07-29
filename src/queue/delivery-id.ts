// The delivery-id vocabulary (#9742).
//
// Every `agent-regate-pr` job carries a `deliveryId`. Most are a REAL GitHub webhook delivery id -- the
// event that caused the work. The rest are SYNTHETIC ids minted by a producer that has no webhook to
// point at (a scheduled sweep, a repair fan-out, an operator's manual re-gate), and each of those tags
// itself with a prefix naming its origin.
//
// The prefixes were string literals at each producer with matching `startsWith` reads scattered
// elsewhere. They live here now because the re-evaluation reason a decision record must declare
// (#9742) is DERIVED from them: `REEVALUATION_REASON_BY_ORIGIN` in review/decision-record.ts is typed
// `Record<DeliveryIdOrigin, ReevaluationReason>`, so a new origin added here without a reason assigned
// there fails the build. A verdict whose cause nobody assigned is a verdict nobody can explain.

export const DELIVERY_ID_PREFIXES = {
  /** The scheduled re-gate sweep's own per-PR fan-out (#audit-sweep-fanout). */
  regateSweep: "regate-sweep:",
  /** The sweep's outage-repair fan-out: a PR missing a current-head Gate check or surface publish. */
  regateRepair: "regate-repair:",
  /** An operator's explicit re-gate through the internal jobs endpoint. */
  manualRegate: "manual-regate:",
  /** Backlog convergence: an open PR whose surface was never published for its current head. */
  backlogConvergence: "backlog-convergence:",
  /** Recovery of a panel "Re-run review" click whose webhook delivery was lost. */
  panelRetriggerRecovery: "panel-retrigger-recovery:",
  /** Pass 2 of flag-then-close: re-verify the linked issue after the pending-closure label landed. */
  linkedIssueVerify: "linked-issue-verify:",
  /** PR reconciliation repair. */
  reconcile: "reconcile:",
  /** A published surface with no disposition marker for its head -- a crashed or lost pass. */
  surfaceWithoutDisposition: "surface-without-disposition:",
} as const;

/** The producers that mint a synthetic delivery id. A raw GitHub delivery id has no origin. */
export type DeliveryIdOrigin = keyof typeof DELIVERY_ID_PREFIXES;

export const DELIVERY_ID_ORIGINS = Object.keys(DELIVERY_ID_PREFIXES) as readonly DeliveryIdOrigin[];

/** Build a synthetic delivery id, so no producer repeats a prefix literal. */
export function deliveryIdFor(origin: DeliveryIdOrigin, suffix: string): string {
  return `${DELIVERY_ID_PREFIXES[origin]}${suffix}`;
}

/**
 * Which producer minted this delivery id, or null for a raw GitHub webhook delivery id.
 *
 * First match wins, which is unambiguous ONLY because no prefix here is a prefix of another -- an
 * invariant asserted directly in decision-record.test.ts rather than worked around with a
 * longest-match scan. A tie-break that can never run is untestable defensive code; a failing
 * invariant test names the real problem (two origins that cannot be told apart) to whoever adds one.
 */
export function deliveryIdOrigin(deliveryId: string | null | undefined): DeliveryIdOrigin | null {
  if (typeof deliveryId !== "string") return null;
  return DELIVERY_ID_ORIGINS.find((origin) => deliveryId.startsWith(DELIVERY_ID_PREFIXES[origin])) ?? null;
}
