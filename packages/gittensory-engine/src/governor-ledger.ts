/** Immutable governor decision vocabulary — unknown values fail closed before insert. */
export const GOVERNOR_LEDGER_EVENT_TYPES = Object.freeze([
  "allowed",
  "denied",
  "throttled",
  "kill_switch",
] as const);

export type GovernorLedgerEventType = (typeof GOVERNOR_LEDGER_EVENT_TYPES)[number];

export type GovernorLedgerEvent = {
  eventType: GovernorLedgerEventType;
  repoFullName?: string | null | undefined;
  actionClass: string;
  decision: string;
  reason: string;
  payload?: Record<string, unknown> | undefined;
};

export type NormalizedGovernorLedgerEvent = {
  eventType: GovernorLedgerEventType;
  repoFullName: string | null;
  actionClass: string;
  decision: string;
  reason: string;
  payloadJson: string;
};

const governorEventTypeSet = new Set<string>(GOVERNOR_LEDGER_EVENT_TYPES);

/* v8 ignore start -- Normalization helpers are covered through normalizeGovernorLedgerEvent export tests. */
function normalizeRequiredString(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(code);
  return trimmed;
}

function normalizeOptionalRepoFullName(repoFullName: unknown): string | null {
  if (repoFullName === undefined || repoFullName === null) return null;
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

// Structural equality between a JSON.parse() result and the plain object it was stringified from. One side is
// always JSON-safe (parsed from JSON text); this only needs to compare plain objects/arrays/primitives, not the
// full generality of node:util's isDeepStrictEqual (no Dates/RegExp/Maps/getters/symbols to worry about) — this
// package's tsconfig deliberately sets `types: []` (no Node ambient types leak into its public .d.ts surface),
// so importing "node:util" here isn't viable; a small local check avoids that entirely.
function jsonRoundTripEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const bArr = b as unknown[];
    const aArr = a as unknown[];
    return aArr.length === bArr.length && aArr.every((value, index) => jsonRoundTripEqual(value, bArr[index]));
  }
  const aKeys = Object.keys(a as object);
  const bRecord = b as Record<string, unknown>;
  return aKeys.length === Object.keys(bRecord).length && aKeys.every((key) => Object.hasOwn(bRecord, key) && jsonRoundTripEqual((a as Record<string, unknown>)[key], bRecord[key]));
}

function serializePayload(payload: unknown): string {
  if (payload === undefined) return "{}";
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid_payload");
  }
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw new Error("invalid_payload");
  }
  if (!jsonRoundTripEqual(JSON.parse(json), payload)) {
    throw new Error("invalid_payload");
  }
  return json;
}
/* v8 ignore stop */

/**
 * Validate and normalize a governor ledger row before append-only insert. Mirrors the structured-event shape of
 * `logAudit` in `src/selfhost/audit.ts`, but for local SQLite storage. This module does NOT wire into live
 * governor enforcement — it only defines the storage contract other issues will write into. (#2328)
 */
export function normalizeGovernorLedgerEvent(input: unknown): NormalizedGovernorLedgerEvent {
  if (!input || typeof input !== "object") throw new Error("invalid_event");
  const event = input as Partial<GovernorLedgerEvent>;
  const eventType = normalizeRequiredString(event.eventType, "invalid_event_type");
  if (!governorEventTypeSet.has(eventType)) throw new Error("invalid_event_type");
  return {
    eventType: eventType as GovernorLedgerEventType,
    repoFullName: normalizeOptionalRepoFullName(event.repoFullName),
    actionClass: normalizeRequiredString(event.actionClass, "invalid_action_class"),
    decision: normalizeRequiredString(event.decision, "invalid_decision"),
    reason: normalizeRequiredString(event.reason, "invalid_reason"),
    payloadJson: serializePayload(event.payload),
  };
}
