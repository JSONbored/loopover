// Anonymized discovery-plane telemetry event schema (pure) — #4301, Wave 2 tracker #2353 Phase 6.
//
// Typed event shapes for the OPTIONAL hosted discovery-index service (#4250) — which candidates a miner
// fetched/ranked and whether a soft-claim succeeded or collided — so that shared service can be operated and
// debugged WITHOUT ever holding source, diffs, or credentials. This mirrors governor-ledger.ts's pure
// validate/normalize shape (fixed fail-closed vocabulary, JSON-round-trip-verified payload) and copies the
// anonymization POSTURE of src/selfhost/orb-collector.ts (the one shipped precedent for "anonymized telemetry
// leaving an instance"): repo/issue identifiers are HMAC hashes keyed by a per-instance secret the collector
// never holds, and free-text-adjacent fields are collapsed to a fixed low-cardinality bucket rather than raw text.
//
// NEVER INCLUDED in a telemetry event (the discovery-plane analogue of orb-collector.ts:1-18's inventory): no
// source contents, no diffs, no GitHub tokens or credentials, no full issue bodies or titles, no commit SHAs, and
// no RAW repo/issue identifiers — only the exporter's per-instance HMAC hashes reach this shape. This module is
// SCHEMA/TYPES ONLY: it does not export events, hash anything itself (the exporter does that at #4250's boundary),
// or wire into an endpoint. It only defines and validates the on-the-wire contract.

/** Immutable discovery-plane telemetry event vocabulary — an unknown value fails closed before it is recorded. */
export const MINER_TELEMETRY_EVENT_TYPES = Object.freeze([
  "query_issued",
  "candidates_returned",
  "soft_claim_attempted",
  "soft_claim_succeeded",
  "soft_claim_collided",
] as const);

export type MinerTelemetryEventType = (typeof MINER_TELEMETRY_EVENT_TYPES)[number];

/** Fixed low-cardinality outcome buckets — the discovery-plane analogue of orb-collector's `bucketReasonCode`, so a
 *  free-text reason can never leak through the telemetry surface. */
export const MINER_TELEMETRY_OUTCOME_BUCKETS = Object.freeze([
  "ok",
  "empty",
  "collision",
  "rate_limited",
  "error",
  "other",
] as const);

export type MinerTelemetryOutcomeBucket = (typeof MINER_TELEMETRY_OUTCOME_BUCKETS)[number];

/** A single discovery-plane telemetry event, pre-anonymization-checked. `repoHash`/`issueHash` are the exporter's
 *  per-instance HMAC hashes (orb-collector's `getOrCreateAnonSecret`/`hmacField` posture) — NEVER a raw
 *  `owner/repo` or issue number. `metrics` is count-only quantitative data (e.g. `candidatesReturned`), never text. */
export type MinerTelemetryEvent = {
  eventType: MinerTelemetryEventType;
  repoHash?: string | null | undefined;
  issueHash?: string | null | undefined;
  outcome: MinerTelemetryOutcomeBucket;
  metrics?: Record<string, number> | undefined;
};

/** The normalized, storage/transport-ready form: hashes coerced to `string | null`, metrics serialized to JSON. */
export type NormalizedMinerTelemetryEvent = {
  eventType: MinerTelemetryEventType;
  repoHash: string | null;
  issueHash: string | null;
  outcome: MinerTelemetryOutcomeBucket;
  metricsJson: string;
};

const telemetryEventTypeSet = new Set<string>(MINER_TELEMETRY_EVENT_TYPES);
const telemetryOutcomeSet = new Set<string>(MINER_TELEMETRY_OUTCOME_BUCKETS);

/** Coerce an optional anonymized identifier. Present values must be a non-empty opaque hash — an anti-leak guard
 *  rejects anything that looks like a RAW identifier (contains `/`, i.e. `owner/repo`, or any whitespace), so a
 *  caller cannot accidentally ship an un-hashed `repoFullName` through the anonymized surface. */
function normalizeOptionalHash(value: unknown, code: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(code);
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("/") || /\s/.test(trimmed)) throw new Error(code);
  return trimmed;
}

/** Serialize the count-only metrics map, rejecting any non-finite-number value (so no free text or NaN/Infinity can
 *  slip into the telemetry payload). Absent metrics normalize to an empty object. */
function normalizeMetrics(metrics: unknown): string {
  if (metrics === undefined) return "{}";
  if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics)) throw new Error("invalid_metrics");
  for (const value of Object.values(metrics as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid_metrics");
  }
  return JSON.stringify(metrics);
}

/**
 * Validate and normalize a discovery-plane telemetry event before it is recorded/exported. Fail-closed, mirroring
 * {@link normalizeGovernorLedgerEvent}: an unknown `eventType`/`outcome`, a non-hash identifier, or a non-numeric
 * metric throws rather than silently shipping malformed or de-anonymizing data. Defines the contract only — it does
 * NOT perform the HMAC hashing (that is the exporter's job at #4250's boundary) or send anything.
 */
export function normalizeMinerTelemetryEvent(input: unknown): NormalizedMinerTelemetryEvent {
  if (!input || typeof input !== "object") throw new Error("invalid_event");
  const event = input as Partial<MinerTelemetryEvent>;
  const eventType = typeof event.eventType === "string" ? event.eventType.trim() : "";
  if (!telemetryEventTypeSet.has(eventType)) throw new Error("invalid_event_type");
  const outcome = typeof event.outcome === "string" ? event.outcome.trim() : "";
  if (!telemetryOutcomeSet.has(outcome)) throw new Error("invalid_outcome");
  return {
    eventType: eventType as MinerTelemetryEventType,
    repoHash: normalizeOptionalHash(event.repoHash, "invalid_repo_hash"),
    issueHash: normalizeOptionalHash(event.issueHash, "invalid_issue_hash"),
    outcome: outcome as MinerTelemetryOutcomeBucket,
    metricsJson: normalizeMetrics(event.metrics),
  };
}
