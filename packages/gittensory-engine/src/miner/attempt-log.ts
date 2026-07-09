// Driver-level structured attempt log — pure event shapes (#4294). Mirrors `governor-ledger.ts`: fixed vocabulary,
// fail-closed normalization, JSON-round-trip-verified payloads. Persistence (SQLite/JSONL export) is a miner-package
// follow-up; this module is the engine-side contract the invoke layer writes into.

import type { CodingAgentExecutionMode } from "./coding-agent-mode.js";

export const ATTEMPT_LOG_EVENT_TYPES = Object.freeze([
  "attempt_started",
  "attempt_shadow",
  "attempt_succeeded",
  "attempt_failed",
  "attempt_aborted",
] as const);

export type AttemptLogEventType = (typeof ATTEMPT_LOG_EVENT_TYPES)[number];

export type AttemptLogEvent = {
  eventType: AttemptLogEventType;
  attemptId: string;
  actionClass: string;
  mode: CodingAgentExecutionMode;
  reason: string;
  payload?: Record<string, unknown> | undefined;
};

export type NormalizedAttemptLogEvent = {
  eventType: AttemptLogEventType;
  attemptId: string;
  actionClass: string;
  mode: CodingAgentExecutionMode;
  reason: string;
  payloadJson: string;
};

const attemptEventTypeSet = new Set<string>(ATTEMPT_LOG_EVENT_TYPES);
const codingAgentModes = new Set<string>(["paused", "dry_run", "live"]);

function normalizeRequiredString(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(code);
  return trimmed;
}

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

function normalizeMode(value: unknown): CodingAgentExecutionMode {
  const mode = normalizeRequiredString(value, "invalid_mode");
  if (!codingAgentModes.has(mode)) throw new Error("invalid_mode");
  return mode as CodingAgentExecutionMode;
}

/** Validate and normalize an attempt-log row before append. Fail-closed on unknown types/modes. */
export function normalizeAttemptLogEvent(input: unknown): NormalizedAttemptLogEvent {
  if (!input || typeof input !== "object") throw new Error("invalid_event");
  const event = input as Partial<AttemptLogEvent>;
  const eventType = normalizeRequiredString(event.eventType, "invalid_event_type");
  if (!attemptEventTypeSet.has(eventType)) throw new Error("invalid_event_type");
  return {
    eventType: eventType as AttemptLogEventType,
    attemptId: normalizeRequiredString(event.attemptId, "invalid_attempt_id"),
    actionClass: normalizeRequiredString(event.actionClass, "invalid_action_class"),
    mode: normalizeMode(event.mode),
    reason: normalizeRequiredString(event.reason, "invalid_reason"),
    payloadJson: serializePayload(event.payload),
  };
}

/** Serialize normalized events as JSONL (one attempt's trace). Pure. */
export function formatAttemptLogJsonl(events: readonly NormalizedAttemptLogEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

/** In-memory appender for tests and local tooling — production persistence imports the normalizer only. */
export function createAttemptLogBuffer(): {
  append: (event: AttemptLogEvent) => NormalizedAttemptLogEvent;
  events: () => readonly NormalizedAttemptLogEvent[];
  jsonl: () => string;
} {
  const rows: NormalizedAttemptLogEvent[] = [];
  return {
    append(event) {
      const normalized = normalizeAttemptLogEvent(event);
      rows.push(normalized);
      return normalized;
    },
    events: () => rows,
    jsonl: () => formatAttemptLogJsonl(rows),
  };
}
