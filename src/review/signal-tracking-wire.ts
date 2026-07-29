// ORB adapter for @loopover/engine's shared signal-tracking primitive (#7982). WRAPS the existing audit_events
// store (via recordAuditEvent/listAuditEventsByType, db/repositories.ts) — this file intentionally contains no
// new schema, no new table, and no gate-decision logic of its own. It does NOT replace outcomes-wire.ts's
// pr_outcome/reversal system; that stays the ground-truth source for ORB's existing merge/close precision
// breaker (auto-tune.ts). This adapter exists so a NEW rule-level signal (starting with #7983/#7984/#7986) can
// be recorded the same way AMS's own adapter (packages/loopover-miner/lib/signal-tracking-store.ts) records
// its eligibility/policy calls, without either side reinventing storage.
//
// Event-type encoding: `ruleId` is folded directly into audit_events.event_type (`signal.rule_fired:<ruleId>`,
// `signal.human_override:<ruleId>`) rather than left in metadata — audit_events already carries a
// (event_type, created_at) index, so a per-rule history query stays an efficient index range scan instead of a
// metadata JSON scan. The rest of the event (target, domain-specific outcome/verdict, extra metadata) lives in
// metadataJson, read back via listAuditEventsByType.

import type { HumanOverrideEvent, RuleFiredEvent, SignalStore } from "@loopover/engine";

import { listAuditEventsByType, recordAuditEvent } from "../db/repositories";
import { nowIso } from "../utils/json";

const RULE_FIRED_EVENT_TYPE_PREFIX = "signal.rule_fired:";
const HUMAN_OVERRIDE_EVENT_TYPE_PREFIX = "signal.human_override:";

function ruleFiredEventType(ruleId: string): string {
  return `${RULE_FIRED_EVENT_TYPE_PREFIX}${ruleId}`;
}

function humanOverrideEventType(ruleId: string): string {
  return `${HUMAN_OVERRIDE_EVENT_TYPE_PREFIX}${ruleId}`;
}

/** Reconstruct a {@link RuleFiredEvent} from an `audit_events` row written by {@link createSignalStore}'s
 *  `recordRuleFired`. `ruleId` comes from the CALLER (the query was already scoped to one rule's event_type),
 *  not re-parsed from the row — mirrors how the row itself never duplicates it into metadata. A row with a
 *  missing/non-string `outcome` in its metadata (should never happen — see the doc comment on
 *  {@link listAuditEventsByType}) degrades to an empty string rather than throwing, keeping a report over a
 *  large window resilient to one bad row. */
function toRuleFiredEvent(ruleId: string, row: { targetKey: string | null; metadata: Record<string, unknown>; createdAt: string }): RuleFiredEvent {
  const outcome = typeof row.metadata.outcome === "string" ? row.metadata.outcome : "";
  const extraMetadata = { ...row.metadata };
  delete extraMetadata.outcome;
  return {
    ruleId,
    targetKey: row.targetKey ?? "",
    outcome,
    occurredAt: row.createdAt,
    ...(Object.keys(extraMetadata).length > 0 ? { metadata: extraMetadata } : {}),
  };
}

/** Reconstruct a {@link HumanOverrideEvent}, the override-side mirror of {@link toRuleFiredEvent}. A row whose
 *  metadata `verdict` isn't exactly `"reversed"`/`"confirmed"` degrades to `"confirmed"` (fail toward NOT
 *  inflating the reversal count on corrupt data) rather than throwing. */
function toHumanOverrideEvent(ruleId: string, row: { targetKey: string | null; metadata: Record<string, unknown>; createdAt: string }): HumanOverrideEvent {
  const verdict = row.metadata.verdict === "reversed" ? "reversed" : "confirmed";
  const extraMetadata = { ...row.metadata };
  delete extraMetadata.verdict;
  return {
    ruleId,
    targetKey: row.targetKey ?? "",
    verdict,
    occurredAt: row.createdAt,
    ...(Object.keys(extraMetadata).length > 0 ? { metadata: extraMetadata } : {}),
  };
}

/** Live, D1/Postgres-backed {@link SignalStore} for ORB. Every write is best-effort (`.catch(() => undefined)`,
 *  matching every other audit-event write in this codebase, e.g. outcomes-wire.ts's `recordAuditEvent` calls) —
 *  a failure to record a signal must never fail the review pass that produced it. Reads (`queryRuleHistory`)
 *  are NOT fail-open the same way: a read error propagates, since a caller computing a precision report needs
 *  to know its input is incomplete rather than silently scoring against a partial (possibly empty) history.
 */
/** listAuditEventsByType's own default, restated so callers that do not pass a limit keep today's behaviour
 *  explicitly rather than by inheritance (#9805). */
export const DEFAULT_RULE_HISTORY_LIMIT = 500;

/** The most rows one queryRuleHistory read can return: listAuditEventsByType hard-clamps its limit to this,
 *  so asking for more silently yields this many. Anything built on top of a rule-history read is bounded by
 *  it, and a cap declared ABOVE it can never be the thing that actually truncates. */
export const MAX_RULE_HISTORY_LIMIT = 2_000;

export function createSignalStore(env: Env): SignalStore {
  return {
    async recordRuleFired(event: RuleFiredEvent): Promise<void> {
      await recordAuditEvent(env, {
        eventType: ruleFiredEventType(event.ruleId),
        actor: "loopover",
        targetKey: event.targetKey,
        outcome: "completed",
        detail: `rule ${event.ruleId} fired (${event.outcome}) against ${event.targetKey}`,
        metadata: { outcome: event.outcome, ...(event.metadata ?? {}) },
        createdAt: event.occurredAt || nowIso(),
      }).catch(() => undefined);
    },
    async recordHumanOverride(event: HumanOverrideEvent): Promise<void> {
      await recordAuditEvent(env, {
        eventType: humanOverrideEventType(event.ruleId),
        actor: "human",
        targetKey: event.targetKey,
        outcome: "completed",
        detail: `human ${event.verdict} rule ${event.ruleId} against ${event.targetKey}`,
        metadata: { verdict: event.verdict, ...(event.metadata ?? {}) },
        createdAt: event.occurredAt || nowIso(),
      }).catch(() => undefined);
    },
    // #9805: `limit` is explicit rather than left to listAuditEventsByType's default of 500. The published
    // corpus needs to know whether it saw the WHOLE window, and a caller that cannot choose the bound cannot
    // tell a complete read from a truncated one. Defaulted so every existing caller is byte-identical.
    //
    // `saturated` is the honest signal: the row count came back exactly at the bound, so there are almost
    // certainly more rows the caller did not see. It is deliberately not "did we hit MAX_CASES" -- the read
    // bound is what actually limits the corpus, and conflating the two is how /v1/public/eval-corpus came to
    // report `truncated: false` over a read it could not have completed.
    async queryRuleHistory(
      ruleId: string,
      sinceMs: number,
      limit: number = DEFAULT_RULE_HISTORY_LIMIT,
    ): Promise<{ fired: RuleFiredEvent[]; overrides: HumanOverrideEvent[]; saturated: boolean }> {
      const sinceIso = new Date(sinceMs).toISOString();
      const [firedRows, overrideRows] = await Promise.all([
        listAuditEventsByType(env, ruleFiredEventType(ruleId), sinceIso, limit),
        listAuditEventsByType(env, humanOverrideEventType(ruleId), sinceIso, limit),
      ]);
      return {
        fired: firedRows.map((row) => toRuleFiredEvent(ruleId, row)),
        overrides: overrideRows.map((row) => toHumanOverrideEvent(ruleId, row)),
        saturated: firedRows.length >= limit || overrideRows.length >= limit,
      };
    },
  };
}
