import { describe, expect, it } from "vitest";
import {
  MINER_TELEMETRY_EVENT_TYPES,
  MINER_TELEMETRY_OUTCOME_BUCKETS,
  normalizeMinerTelemetryEvent,
  type MinerTelemetryEvent,
} from "../../packages/gittensory-engine/src/miner-telemetry";

const base: MinerTelemetryEvent = { eventType: "candidates_returned", outcome: "ok" };

describe("miner-telemetry schema (#4301)", () => {
  it("freezes fixed, low-cardinality vocabularies", () => {
    expect(Object.isFrozen(MINER_TELEMETRY_EVENT_TYPES)).toBe(true);
    expect(Object.isFrozen(MINER_TELEMETRY_OUTCOME_BUCKETS)).toBe(true);
    expect([...MINER_TELEMETRY_EVENT_TYPES]).toContain("soft_claim_collided");
    expect([...MINER_TELEMETRY_OUTCOME_BUCKETS]).toContain("collision");
  });

  it("normalizes a full event: hashed identifiers pass through, metrics serialize to JSON", () => {
    expect(
      normalizeMinerTelemetryEvent({
        eventType: "candidates_returned",
        repoHash: "  a1b2c3  ",
        issueHash: "deadbeef",
        outcome: "ok",
        metrics: { candidatesReturned: 12, rankMs: 3 },
      }),
    ).toEqual({
      eventType: "candidates_returned",
      repoHash: "a1b2c3",
      issueHash: "deadbeef",
      outcome: "ok",
      metricsJson: '{"candidatesReturned":12,"rankMs":3}',
    });
  });

  it("defaults absent identifiers to null and absent metrics to an empty object", () => {
    expect(normalizeMinerTelemetryEvent({ eventType: "query_issued", outcome: "empty" })).toEqual({
      eventType: "query_issued",
      repoHash: null,
      issueHash: null,
      outcome: "empty",
      metricsJson: "{}",
    });
    // explicit null identifiers are also accepted
    expect(normalizeMinerTelemetryEvent({ ...base, repoHash: null, issueHash: null }).repoHash).toBeNull();
  });

  it("fails closed on a non-object, an unknown event type, or an unknown outcome bucket", () => {
    expect(() => normalizeMinerTelemetryEvent(null)).toThrow("invalid_event");
    expect(() => normalizeMinerTelemetryEvent("nope")).toThrow("invalid_event");
    expect(() => normalizeMinerTelemetryEvent({ ...base, eventType: "mystery" })).toThrow("invalid_event_type");
    expect(() => normalizeMinerTelemetryEvent({ eventType: 7, outcome: "ok" })).toThrow("invalid_event_type");
    expect(() => normalizeMinerTelemetryEvent({ ...base, outcome: "great" })).toThrow("invalid_outcome");
    expect(() => normalizeMinerTelemetryEvent({ eventType: "query_issued", outcome: 5 })).toThrow("invalid_outcome");
  });

  it("anti-leak guard: rejects a non-hash identifier (raw owner/repo, whitespace, non-string, or empty)", () => {
    expect(() => normalizeMinerTelemetryEvent({ ...base, repoHash: "acme/widgets" })).toThrow("invalid_repo_hash");
    expect(() => normalizeMinerTelemetryEvent({ ...base, repoHash: "has space" })).toThrow("invalid_repo_hash");
    expect(() => normalizeMinerTelemetryEvent({ ...base, repoHash: "   " })).toThrow("invalid_repo_hash");
    expect(() => normalizeMinerTelemetryEvent({ ...base, repoHash: 123 })).toThrow("invalid_repo_hash");
    expect(() => normalizeMinerTelemetryEvent({ ...base, issueHash: "owner/12" })).toThrow("invalid_issue_hash");
  });

  it("rejects non-numeric or malformed metrics (no free text or NaN can leak through)", () => {
    expect(() => normalizeMinerTelemetryEvent({ ...base, metrics: { n: "twelve" } })).toThrow("invalid_metrics");
    expect(() => normalizeMinerTelemetryEvent({ ...base, metrics: { n: Number.NaN } })).toThrow("invalid_metrics");
    expect(() => normalizeMinerTelemetryEvent({ ...base, metrics: [1, 2] })).toThrow("invalid_metrics");
    expect(() => normalizeMinerTelemetryEvent({ ...base, metrics: null })).toThrow("invalid_metrics");
  });

  it("rejects metric names that could carry raw identifiers or free text", () => {
    expect(() =>
      normalizeMinerTelemetryEvent({
        ...base,
        metrics: { "acme/private-repo#123 leaked issue title": 1 },
      }),
    ).toThrow("invalid_metrics");
    expect(() => normalizeMinerTelemetryEvent({ ...base, metrics: { "rank-ms": 3 } })).toThrow(
      "invalid_metrics",
    );
    expect(() => normalizeMinerTelemetryEvent({ ...base, metrics: { "": 1 } })).toThrow("invalid_metrics");
  });

  it("is re-exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.normalizeMinerTelemetryEvent).toBe("function");
    expect(barrel.MINER_TELEMETRY_EVENT_TYPES).toBe(MINER_TELEMETRY_EVENT_TYPES);
  });
});
