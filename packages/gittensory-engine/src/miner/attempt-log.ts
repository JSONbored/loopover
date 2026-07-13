// Driver-level structured attempt log — pure event shapes (#4294). Mirrors `governor-ledger.ts`: fixed vocabulary,
// fail-closed normalization, JSON-round-trip-verified payloads. SQLite persistence + JSONL export live in
// `packages/gittensory-miner/lib/attempt-log.js`, which imports this normalizer from the engine package.

import type { CodingAgentExecutionMode } from "./coding-agent-mode.js";

export const ATTEMPT_LOG_EVENT_TYPES = Object.freeze([
  "attempt_started",
  "attempt_tool_edit",
  "attempt_shadow",
  "attempt_succeeded",
  "attempt_failed",
  "attempt_aborted",
  // #5185: one summary row per completed attempt, written by the miner CLI (attempt-cli.js) once `runIterateLoop`
  // returns -- distinct from the five iteration-level types above (all written from inside iterate-loop.ts's own
  // per-iteration decision trail). Carries provider/costUsd, the two real (never-fabricated) signals a
  // per-provider usage dashboard needs that no iteration-level event captures today.
  "attempt_outcome_summary",
] as const);

export type AttemptLogEventType = (typeof ATTEMPT_LOG_EVENT_TYPES)[number];

export type AttemptLogEvent = {
  eventType: AttemptLogEventType;
  attemptId: string;
  actionClass: string;
  mode: CodingAgentExecutionMode;
  reason: string;
  payload?: Record<string, unknown> | undefined;
  /** Coding-agent provider name (claude-cli/codex-cli/agent-sdk/noop) this attempt used, when known (#5185).
   *  Optional: every event type that predates this field omits it; only `attempt_outcome_summary` sets it. */
  provider?: string | undefined;
  /** Real dollar cost, mirroring `CodingAgentDriverResult.costUsd`'s own convention: absent (not zero) when the
   *  provider never reports a cost signal, never fabricated (#5185). */
  costUsd?: number | undefined;
  /** Real token count, when some future driver reports one. Always absent today -- no driver reports real token
   *  usage yet (#5395) -- an honest gap, not a fabricated zero. */
  tokensUsed?: number | undefined;
};

export type NormalizedAttemptLogEvent = {
  eventType: AttemptLogEventType;
  attemptId: string;
  actionClass: string;
  mode: CodingAgentExecutionMode;
  reason: string;
  payloadJson: string;
  provider: string | null;
  costUsd: number | null;
  tokensUsed: number | null;
};

const attemptEventTypeSet = new Set<string>(ATTEMPT_LOG_EVENT_TYPES);
const codingAgentModes = new Set<string>(["paused", "dry_run", "live"]);

/* v8 ignore start -- Normalization helpers are covered through normalizeAttemptLogEvent export tests. */
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
/* v8 ignore stop */

function normalizeMode(value: unknown): CodingAgentExecutionMode {
  const mode = normalizeRequiredString(value, "invalid_mode");
  if (!codingAgentModes.has(mode)) throw new Error("invalid_mode");
  return mode as CodingAgentExecutionMode;
}

/** `undefined` -> `null` ("not set"); any other non-empty-string value must be a valid string, or this fails
 *  closed rather than silently coercing (#5185). */
function normalizeOptionalString(value: unknown, code: string): string | null {
  if (value === undefined) return null;
  return normalizeRequiredString(value, code);
}

/** `undefined` -> `null` ("no signal, never fabricated as 0"); any other value must be a finite number >= 0
 *  (#5185) -- mirrors `CodingAgentDriverResult.costUsd`'s own absent-vs-zero distinction. */
function normalizeOptionalNonNegativeNumber(value: unknown, code: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
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
    provider: normalizeOptionalString(event.provider, "invalid_provider"),
    costUsd: normalizeOptionalNonNegativeNumber(event.costUsd, "invalid_cost_usd"),
    tokensUsed: normalizeOptionalNonNegativeNumber(event.tokensUsed, "invalid_tokens_used"),
  };
}

/** Serialize normalized events as JSONL (one attempt's trace). Pure. */
export function formatAttemptLogJsonl(events: readonly NormalizedAttemptLogEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

/** In-memory appender for tests and local tooling — production persistence uses `gittensory-miner/lib/attempt-log.js`. */
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
