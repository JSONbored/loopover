import { describe, expect, it } from "vitest";
import {
  GOVERNOR_LEDGER_EVENT_TYPES,
  normalizeGovernorLedgerEvent,
} from "../../packages/gittensory-engine/src/governor-ledger";

describe("governor ledger normalization (#2328)", () => {
  it("exposes the frozen governor event vocabulary", () => {
    expect(GOVERNOR_LEDGER_EVENT_TYPES).toEqual(["allowed", "denied", "throttled", "kill_switch"]);
    expect(Object.isFrozen(GOVERNOR_LEDGER_EVENT_TYPES)).toBe(true);
  });

  it.each(GOVERNOR_LEDGER_EVENT_TYPES.map((eventType) => [eventType]))(
    "accepts a valid %s event with optional repo scope and payload",
    (eventType) => {
      expect(
        normalizeGovernorLedgerEvent({
          eventType,
          repoFullName: "acme/widgets",
          actionClass: "write",
          decision: eventType === "allowed" ? "allow" : "block",
          reason: "unit test",
          payload: { attempt: 1 },
        }),
      ).toMatchObject({
        eventType,
        repoFullName: "acme/widgets",
        actionClass: "write",
        payloadJson: JSON.stringify({ attempt: 1 }),
      });
    },
  );

  it("defaults missing repo scope and payload to null and {}", () => {
    expect(
      normalizeGovernorLedgerEvent({
        eventType: "denied",
        actionClass: "write",
        decision: "block",
        reason: "house rule",
      }),
    ).toEqual({
      eventType: "denied",
      repoFullName: null,
      actionClass: "write",
      decision: "block",
      reason: "house rule",
      payloadJson: "{}",
    });
  });

  it("rejects unknown event types before insert", () => {
    expect(() =>
      normalizeGovernorLedgerEvent({
        eventType: "maybe",
        actionClass: "write",
        decision: "block",
        reason: "nope",
      }),
    ).toThrow(/invalid_event_type/);
  });

  it("rejects malformed repo slugs, blank required strings, and lossy payloads", () => {
    const base = {
      eventType: "throttled",
      actionClass: "write",
      decision: "retry",
      reason: "rate limit",
    };
    expect(() => normalizeGovernorLedgerEvent({ ...base, repoFullName: "bad" })).toThrow(
      /invalid_repo_full_name/,
    );
    expect(() => normalizeGovernorLedgerEvent({ ...base, repoFullName: "a/b/c" })).toThrow(
      /invalid_repo_full_name/,
    );
    expect(() => normalizeGovernorLedgerEvent({ ...base, repoFullName: 42 } as unknown)).toThrow(
      /invalid_repo_full_name/,
    );
    expect(() => normalizeGovernorLedgerEvent({ ...base, actionClass: 0 } as unknown)).toThrow(
      /invalid_action_class/,
    );
    expect(() => normalizeGovernorLedgerEvent({ ...base, decision: false } as unknown)).toThrow(
      /invalid_decision/,
    );
    expect(() => normalizeGovernorLedgerEvent({ ...base, eventType: 1 } as unknown)).toThrow(
      /invalid_event_type/,
    );
    expect(() => normalizeGovernorLedgerEvent({ ...base, reason: "  " })).toThrow(/invalid_reason/);
    expect(() => normalizeGovernorLedgerEvent({ ...base, payload: null } as unknown)).toThrow(
      /invalid_payload/,
    );
    expect(() => normalizeGovernorLedgerEvent({ ...base, payload: ["bad"] } as unknown)).toThrow(
      /invalid_payload/,
    );
    expect(() =>
      normalizeGovernorLedgerEvent({ ...base, payload: { value: undefined } }),
    ).toThrow(/invalid_payload/);
    expect(() => normalizeGovernorLedgerEvent(null)).toThrow(/invalid_event/);
    expect(() => normalizeGovernorLedgerEvent("not-an-object")).toThrow(/invalid_event/);
  });
});
