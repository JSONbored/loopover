import { describe, expect, it } from "vitest";
import {
  SIGNAL_HUMAN_OVERRIDE_EVENT,
  SIGNAL_RULE_FIRED_EVENT,
  createSignalTrackingStore,
} from "../../packages/loopover-miner/lib/signal-tracking-store";
import type { AppendEventInput, LedgerEntry } from "../../packages/loopover-miner/lib/event-ledger";

const ONE_HOUR_MS = 60 * 60 * 1000;

// Same mock-ledger shape as test/unit/miner-pr-outcome.test.ts's own mockLedger, so these stay pure unit tests
// with no SQLite file. Typed against the real EventLedger contract so it can't silently drift.
function mockLedger(): {
  appendEvent: (e: AppendEventInput) => LedgerEntry;
  readEvents: () => LedgerEntry[];
  _events: LedgerEntry[];
} {
  const events: LedgerEntry[] = [];
  let seq = 0;
  return {
    appendEvent: (e) => {
      const entry: LedgerEntry = { id: ++seq, seq, type: e.type, repoFullName: e.repoFullName ?? null, payload: e.payload, createdAt: new Date().toISOString() };
      events.push(entry);
      return entry;
    },
    readEvents: () => events,
    _events: events,
  };
}

describe("createSignalTrackingStore (#7982) — recordRuleFired + queryRuleHistory round-trip", () => {
  it("records a rule-fired event and reads it back with its outcome and target intact", async () => {
    const ledger = mockLedger();
    const store = createSignalTrackingStore(ledger);
    const now = Date.now();
    const occurredAt = new Date(now).toISOString();
    await store.recordRuleFired({ ruleId: "missing_eligibility_label", targetKey: "owner/repo#issue-5", outcome: "exclude", occurredAt });
    const history = await store.queryRuleHistory("missing_eligibility_label", now - ONE_HOUR_MS);
    expect(history.fired).toEqual([
      { ruleId: "missing_eligibility_label", targetKey: "owner/repo#issue-5", outcome: "exclude", occurredAt },
    ]);
    expect(history.overrides).toEqual([]);
  });

  it("preserves extra metadata on a fired event, separately from the domain outcome", async () => {
    const ledger = mockLedger();
    const store = createSignalTrackingStore(ledger);
    const now = Date.now();
    const occurredAt = new Date(now).toISOString();
    await store.recordRuleFired({
      ruleId: "missing_eligibility_label",
      targetKey: "owner/repo#issue-5",
      outcome: "exclude",
      occurredAt,
      metadata: { profileConfidence: "explicit" },
    });
    const history = await store.queryRuleHistory("missing_eligibility_label", now - ONE_HOUR_MS);
    expect(history.fired[0]?.metadata).toEqual({ profileConfidence: "explicit" });
  });

  it("records a human-override event and reads it back with its verdict intact", async () => {
    const ledger = mockLedger();
    const store = createSignalTrackingStore(ledger);
    const now = Date.now();
    const occurredAt = new Date(now).toISOString();
    await store.recordHumanOverride({ ruleId: "missing_eligibility_label", targetKey: "owner/repo#issue-5", verdict: "reversed", occurredAt });
    const history = await store.queryRuleHistory("missing_eligibility_label", now - ONE_HOUR_MS);
    expect(history.overrides).toEqual([
      { ruleId: "missing_eligibility_label", targetKey: "owner/repo#issue-5", verdict: "reversed", occurredAt },
    ]);
    expect(history.fired).toEqual([]);
  });

  it("writes each event under the correct event-ledger type constant", async () => {
    const ledger = mockLedger();
    const store = createSignalTrackingStore(ledger);
    const occurredAt = new Date().toISOString();
    await store.recordRuleFired({ ruleId: "rule_a", targetKey: "owner/repo#1", outcome: "block", occurredAt });
    await store.recordHumanOverride({ ruleId: "rule_a", targetKey: "owner/repo#1", verdict: "confirmed", occurredAt });
    expect(ledger._events.map((e) => e.type)).toEqual([SIGNAL_RULE_FIRED_EVENT, SIGNAL_HUMAN_OVERRIDE_EVENT]);
  });

  it("scopes the ledger row's repoFullName from a well-formed owner/repo#N targetKey", async () => {
    const ledger = mockLedger();
    const store = createSignalTrackingStore(ledger);
    await store.recordRuleFired({ ruleId: "rule_a", targetKey: "owner/repo#123", outcome: "block", occurredAt: new Date().toISOString() });
    expect(ledger._events[0]?.repoFullName).toBe("owner/repo");
  });

  it("leaves the ledger row unscoped (null repoFullName) when targetKey doesn't match the owner/repo#N shape", async () => {
    const ledger = mockLedger();
    const store = createSignalTrackingStore(ledger);
    await store.recordRuleFired({ ruleId: "rule_a", targetKey: "not-a-real-target", outcome: "block", occurredAt: new Date().toISOString() });
    expect(ledger._events[0]?.repoFullName).toBeNull();
  });

  it("never mixes events for a DIFFERENT ruleId into the query result", async () => {
    const ledger = mockLedger();
    const store = createSignalTrackingStore(ledger);
    const occurredAt = new Date().toISOString();
    await store.recordRuleFired({ ruleId: "rule_a", targetKey: "owner/repo#1", outcome: "block", occurredAt });
    await store.recordRuleFired({ ruleId: "rule_b", targetKey: "owner/repo#2", outcome: "block", occurredAt });
    const history = await store.queryRuleHistory("rule_a", Date.now() - ONE_HOUR_MS);
    expect(history.fired).toHaveLength(1);
    expect(history.fired[0]?.ruleId).toBe("rule_a");
  });

  it("keeps fired and override events for the SAME ruleId in separate buckets, never cross-contaminating", async () => {
    const ledger = mockLedger();
    const store = createSignalTrackingStore(ledger);
    const occurredAt = new Date().toISOString();
    await store.recordRuleFired({ ruleId: "rule_a", targetKey: "owner/repo#1", outcome: "block", occurredAt });
    await store.recordHumanOverride({ ruleId: "rule_a", targetKey: "owner/repo#1", verdict: "confirmed", occurredAt });
    const history = await store.queryRuleHistory("rule_a", Date.now() - ONE_HOUR_MS);
    expect(history.fired).toHaveLength(1);
    expect(history.overrides).toHaveLength(1);
  });

  it("excludes an event older than sinceMs", async () => {
    const ledger = mockLedger();
    // Manually seed an old event -- the mock's appendEvent always stamps "now", so an explicit direct push is
    // how this test controls createdAt, same technique test/unit/miner-pr-outcome.test.ts's own suite uses via
    // its exposed `_events` array.
    ledger._events.push({
      id: 1,
      seq: 1,
      type: SIGNAL_RULE_FIRED_EVENT,
      repoFullName: "owner/repo",
      payload: { ruleId: "rule_a", targetKey: "owner/repo#1", outcome: "block", occurredAt: new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString() },
      createdAt: new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString(),
    });
    const store = createSignalTrackingStore(ledger);
    const history = await store.queryRuleHistory("rule_a", Date.now() - ONE_HOUR_MS);
    expect(history.fired).toEqual([]);
  });

  it("skips a ledger row for the target ruleId whose payload is malformed, without throwing", async () => {
    const ledger = mockLedger();
    ledger._events.push({
      id: 1,
      seq: 1,
      type: SIGNAL_RULE_FIRED_EVENT,
      repoFullName: "owner/repo",
      payload: { ruleId: "rule_a", targetKey: "owner/repo#1" /* missing outcome/occurredAt */ },
      createdAt: new Date().toISOString(),
    });
    const store = createSignalTrackingStore(ledger);
    const history = await store.queryRuleHistory("rule_a", Date.now() - ONE_HOUR_MS);
    expect(history.fired).toEqual([]);
  });

  it("skips a ledger row whose verdict isn't 'reversed' or 'confirmed', without throwing", async () => {
    const ledger = mockLedger();
    ledger._events.push({
      id: 1,
      seq: 1,
      type: SIGNAL_HUMAN_OVERRIDE_EVENT,
      repoFullName: "owner/repo",
      payload: { ruleId: "rule_a", targetKey: "owner/repo#1", verdict: "maybe", occurredAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
    });
    const store = createSignalTrackingStore(ledger);
    const history = await store.queryRuleHistory("rule_a", Date.now() - ONE_HOUR_MS);
    expect(history.overrides).toEqual([]);
  });

  it("ignores an unrelated event type entirely (the ledger holds every miner event kind, not just this adapter's own)", async () => {
    const ledger = mockLedger();
    ledger._events.push({
      id: 1,
      seq: 1,
      type: "pr_outcome",
      repoFullName: "owner/repo",
      payload: { prNumber: 1, decision: "merged" },
      createdAt: new Date().toISOString(),
    });
    const store = createSignalTrackingStore(ledger);
    const history = await store.queryRuleHistory("rule_a", Date.now() - ONE_HOUR_MS);
    expect(history.fired).toEqual([]);
    expect(history.overrides).toEqual([]);
  });
});
