// AMS adapter for @loopover/engine's shared signal-tracking primitive (#7982). WRAPS the miner's existing
// local, append-only event-ledger.js -- no new table, no new storage mechanism -- the same "reuse, don't
// rewrite" contract ORB's own adapter (src/review/signal-tracking-wire.ts) follows for audit_events.
//
// Event-ledger vocabulary: two typed event kinds, mirroring MINER_PR_OUTCOME_EVENT's own naming convention
// (pr-outcome.ts). ruleId/outcome/verdict/extra metadata live in the ledger's `payload` (a plain JSON object,
// the ledger's own storage unit) -- there is no indexed column to fold ruleId into the way ORB's audit_events
// event_type affords, so queryRuleHistory reads the WHOLE ledger and filters client-side, mirroring
// calibration-cli.ts's toOutcomeRecords (the ledger's only other "scan + typed filter" reader). Fine for AMS's
// bounded, single-operator local volume; not a hosted-scale query pattern -- a future issue can index this if
// it ever needs to be.

import type { HumanOverrideEvent, RuleFiredEvent, SignalStore } from "@loopover/engine";

import type { AppendEventInput, LedgerEntry, ReadEventsFilter } from "./event-ledger.js";

export const SIGNAL_RULE_FIRED_EVENT = "signal_rule_fired" as const;
export const SIGNAL_HUMAN_OVERRIDE_EVENT = "signal_human_override" as const;

/** The minimal event-ledger surface this adapter needs -- same "reuse the real interface, don't invent a
 *  narrower one" shape as pr-outcome.ts's own RecordPrOutcomeOptions.eventLedger, so a genuine EventLedger
 *  (not just a same-shaped stub) satisfies this without a cast. */
export type SignalTrackingLedger = {
  appendEvent(event: AppendEventInput): LedgerEntry;
  readEvents(filter?: ReadEventsFilter): LedgerEntry[];
};

type RuleFiredPayload = { ruleId: string; targetKey: string; outcome: string; occurredAt: string; metadata?: Record<string, unknown> };
type HumanOverridePayload = { ruleId: string; targetKey: string; verdict: "reversed" | "confirmed"; occurredAt: string; metadata?: Record<string, unknown> };

function toRuleFiredPayload(event: RuleFiredEvent): RuleFiredPayload {
  return {
    ruleId: event.ruleId,
    targetKey: event.targetKey,
    outcome: event.outcome,
    occurredAt: event.occurredAt,
    ...(event.metadata ? { metadata: event.metadata } : {}),
  };
}

function toHumanOverridePayload(event: HumanOverrideEvent): HumanOverridePayload {
  return {
    ruleId: event.ruleId,
    targetKey: event.targetKey,
    verdict: event.verdict,
    occurredAt: event.occurredAt,
    ...(event.metadata ? { metadata: event.metadata } : {}),
  };
}

/** Best-effort `owner/repo` scope for the ledger row, parsed from targetKey's `owner/repo#...` convention (the
 *  same shape ORB's own targetKey uses, e.g. `owner/repo#123`). A targetKey that doesn't match this shape
 *  stays UNSCOPED (repoFullName omitted) rather than guessing wrong -- a wrong scope would make the row
 *  permanently invisible to a repo-filtered read, which is worse than just being unscoped. */
function repoFullNameFromTargetKey(targetKey: string): string | undefined {
  const match = /^([^/]+\/[^/#]+)#/.exec(targetKey);
  return match?.[1];
}

/** True when `payload` is a well-formed {@link RuleFiredPayload} for exactly `ruleId` -- both the type guard
 *  AND the ruleId filter in one check, since every caller of this immediately wants both. A payload that
 *  doesn't match (wrong ruleId, or missing/wrong-typed fields from some other event this adapter didn't
 *  write) is silently skipped by the caller, never thrown on -- the ledger holds every miner event type, not
 *  just this adapter's own. */
function isRuleFiredPayload(payload: Record<string, unknown>, ruleId: string): payload is RuleFiredPayload {
  return payload.ruleId === ruleId && typeof payload.targetKey === "string" && typeof payload.outcome === "string" && typeof payload.occurredAt === "string";
}

/** The override-side mirror of {@link isRuleFiredPayload}. */
function isHumanOverridePayload(payload: Record<string, unknown>, ruleId: string): payload is HumanOverridePayload {
  return (
    payload.ruleId === ruleId &&
    typeof payload.targetKey === "string" &&
    (payload.verdict === "reversed" || payload.verdict === "confirmed") &&
    typeof payload.occurredAt === "string"
  );
}

/**
 * Local, event-ledger-backed {@link SignalStore} for AMS. `eventLedger` is REQUIRED (not defaulted to a
 * module-level singleton) — same discipline as pr-outcome.ts's own `RecordPrOutcomeOptions.eventLedger`: the
 * caller already owns the ledger's open/close lifecycle (a real SQLite file handle), so this adapter never
 * opens or closes one itself.
 */
export function createSignalTrackingStore(eventLedger: SignalTrackingLedger): SignalStore {
  return {
    async recordRuleFired(event: RuleFiredEvent): Promise<void> {
      const repoFullName = repoFullNameFromTargetKey(event.targetKey);
      eventLedger.appendEvent({
        type: SIGNAL_RULE_FIRED_EVENT,
        ...(repoFullName ? { repoFullName } : {}),
        payload: toRuleFiredPayload(event),
      });
    },
    async recordHumanOverride(event: HumanOverrideEvent): Promise<void> {
      const repoFullName = repoFullNameFromTargetKey(event.targetKey);
      eventLedger.appendEvent({
        type: SIGNAL_HUMAN_OVERRIDE_EVENT,
        ...(repoFullName ? { repoFullName } : {}),
        payload: toHumanOverridePayload(event),
      });
    },
    // #9805: the interface carries a `limit`/`saturated` pair so a publishing caller can tell a complete read
    // from a truncated one. This store reads the WHOLE local event ledger in memory -- there is no bound to
    // hit and nothing is ever left behind -- so `limit` is accepted for interface conformance and ignored,
    // and `saturated` is unconditionally false. That is a true statement here, not a stub: reporting `true`
    // would claim missing rows that do not exist.
    async queryRuleHistory(ruleId: string, sinceMs: number): Promise<{ fired: RuleFiredEvent[]; overrides: HumanOverrideEvent[]; saturated: boolean }> {
      const sinceIso = new Date(sinceMs).toISOString();
      const fired: RuleFiredEvent[] = [];
      const overrides: HumanOverrideEvent[] = [];
      // ISO 8601 UTC timestamps (every occurredAt/createdAt in this module) compare correctly as plain
      // strings -- same assumption the SQL `created_at >= ?` comparisons elsewhere in this codebase already
      // rely on -- so no Date parsing is needed just to filter the window.
      for (const entry of eventLedger.readEvents()) {
        if (entry.createdAt < sinceIso) continue;
        if (entry.type === SIGNAL_RULE_FIRED_EVENT && isRuleFiredPayload(entry.payload, ruleId)) {
          fired.push({
            ruleId,
            targetKey: entry.payload.targetKey,
            outcome: entry.payload.outcome,
            occurredAt: entry.payload.occurredAt,
            ...(entry.payload.metadata ? { metadata: entry.payload.metadata } : {}),
          });
        } else if (entry.type === SIGNAL_HUMAN_OVERRIDE_EVENT && isHumanOverridePayload(entry.payload, ruleId)) {
          overrides.push({
            ruleId,
            targetKey: entry.payload.targetKey,
            verdict: entry.payload.verdict,
            occurredAt: entry.payload.occurredAt,
            ...(entry.payload.metadata ? { metadata: entry.payload.metadata } : {}),
          });
        }
      }
      return { fired, overrides, saturated: false };
    },
  };
}
