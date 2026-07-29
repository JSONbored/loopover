import { describe, expect, it } from "vitest";

import { listAuditEventsByType, recordAuditEvent } from "../../src/db/repositories";
import { createSignalStore, DEFAULT_RULE_HISTORY_LIMIT } from "../../src/review/signal-tracking-wire";
import { createTestEnv } from "../helpers/d1";

const ONE_HOUR_MS = 60 * 60 * 1000;

// Fixed reference point (not Date.now() at test-file-load time) so every event's occurredAt/sinceMs stays
// relative to the SAME instant throughout a single test, regardless of how long a real session has been
// running when this file executes.
function isoOffset(baseMs: number, deltaMs: number): string {
  return new Date(baseMs + deltaMs).toISOString();
}

describe("createSignalStore (#7982) — recordRuleFired + queryRuleHistory round-trip", () => {
  it("records a rule-fired event and reads it back with its outcome and target intact", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const now = Date.now();
    const occurredAt = isoOffset(now, 0);
    await store.recordRuleFired({
      ruleId: "missing_linked_issue",
      targetKey: "owner/repo#123",
      outcome: "block",
      occurredAt,
    });
    const history = await store.queryRuleHistory("missing_linked_issue", now - ONE_HOUR_MS);
    expect(history.fired).toEqual([
      {
        ruleId: "missing_linked_issue",
        targetKey: "owner/repo#123",
        outcome: "block",
        occurredAt,
      },
    ]);
    expect(history.overrides).toEqual([]);
  });

  it("preserves extra metadata on a fired event, separately from the domain outcome", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const now = Date.now();
    const occurredAt = isoOffset(now, 0);
    await store.recordRuleFired({
      ruleId: "missing_eligibility_label",
      targetKey: "owner/repo#issue-5",
      outcome: "exclude",
      occurredAt,
      metadata: { profileConfidence: "explicit" },
    });
    const history = await store.queryRuleHistory("missing_eligibility_label", now - ONE_HOUR_MS);
    expect(history.fired).toEqual([
      {
        ruleId: "missing_eligibility_label",
        targetKey: "owner/repo#issue-5",
        outcome: "exclude",
        occurredAt,
        metadata: { profileConfidence: "explicit" },
      },
    ]);
  });

  it("preserves extra metadata on an override event, separately from the verdict", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const now = Date.now();
    const occurredAt = isoOffset(now, 0);
    await store.recordHumanOverride({
      ruleId: "missing_linked_issue",
      targetKey: "owner/repo#123",
      verdict: "confirmed",
      occurredAt,
      metadata: { reviewer: "maintainer" },
    });
    const history = await store.queryRuleHistory("missing_linked_issue", now - ONE_HOUR_MS);
    expect(history.overrides).toEqual([
      {
        ruleId: "missing_linked_issue",
        targetKey: "owner/repo#123",
        verdict: "confirmed",
        occurredAt,
        metadata: { reviewer: "maintainer" },
      },
    ]);
  });

  it("records a human-override event and reads it back with its verdict intact", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const now = Date.now();
    const occurredAt = isoOffset(now, 5 * 60 * 1000);
    await store.recordHumanOverride({
      ruleId: "missing_linked_issue",
      targetKey: "owner/repo#123",
      verdict: "reversed",
      occurredAt,
    });
    const history = await store.queryRuleHistory("missing_linked_issue", now - ONE_HOUR_MS);
    expect(history.overrides).toEqual([
      {
        ruleId: "missing_linked_issue",
        targetKey: "owner/repo#123",
        verdict: "reversed",
        occurredAt,
      },
    ]);
    expect(history.fired).toEqual([]);
  });

  it("keeps fired and override events for the SAME ruleId in separate buckets, never cross-contaminating", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const now = Date.now();
    await store.recordRuleFired({ ruleId: "rule_a", targetKey: "owner/repo#1", outcome: "block", occurredAt: isoOffset(now, 0) });
    await store.recordHumanOverride({ ruleId: "rule_a", targetKey: "owner/repo#1", verdict: "confirmed", occurredAt: isoOffset(now, 60_000) });
    const history = await store.queryRuleHistory("rule_a", now - ONE_HOUR_MS);
    expect(history.fired).toHaveLength(1);
    expect(history.overrides).toHaveLength(1);
    expect(history.overrides[0]?.verdict).toBe("confirmed");
  });

  it("never mixes events for a DIFFERENT ruleId into the query result", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const now = Date.now();
    await store.recordRuleFired({ ruleId: "rule_a", targetKey: "owner/repo#1", outcome: "block", occurredAt: isoOffset(now, 0) });
    await store.recordRuleFired({ ruleId: "rule_b", targetKey: "owner/repo#2", outcome: "block", occurredAt: isoOffset(now, 0) });
    const history = await store.queryRuleHistory("rule_a", now - ONE_HOUR_MS);
    expect(history.fired).toHaveLength(1);
    expect(history.fired[0]?.ruleId).toBe("rule_a");
  });

  it("excludes an event older than sinceMs", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const now = Date.now();
    await store.recordRuleFired({ ruleId: "rule_a", targetKey: "owner/repo#1", outcome: "block", occurredAt: isoOffset(now, -2 * ONE_HOUR_MS) });
    const history = await store.queryRuleHistory("rule_a", now - ONE_HOUR_MS);
    expect(history.fired).toEqual([]);
  });

  it("returns fired events oldest-first, matching a precision/trend report's natural read order", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const now = Date.now();
    await store.recordRuleFired({ ruleId: "rule_a", targetKey: "owner/repo#1", outcome: "block", occurredAt: isoOffset(now, 2 * 60_000) });
    await store.recordRuleFired({ ruleId: "rule_a", targetKey: "owner/repo#2", outcome: "block", occurredAt: isoOffset(now, 0) });
    await store.recordRuleFired({ ruleId: "rule_a", targetKey: "owner/repo#3", outcome: "block", occurredAt: isoOffset(now, 60_000) });
    const history = await store.queryRuleHistory("rule_a", now - 24 * ONE_HOUR_MS);
    expect(history.fired.map((event) => event.targetKey)).toEqual(["owner/repo#2", "owner/repo#3", "owner/repo#1"]);
  });

  it("a recording failure is swallowed, never thrown into the caller (best-effort, matching every other audit-event write)", async () => {
    const env = { ...createTestEnv(), DB: null } as unknown as ReturnType<typeof createTestEnv>;
    const store = createSignalStore(env);
    const occurredAt = new Date().toISOString();
    await expect(
      store.recordRuleFired({ ruleId: "rule_a", targetKey: "owner/repo#1", outcome: "block", occurredAt }),
    ).resolves.toBeUndefined();
    await expect(
      store.recordHumanOverride({ ruleId: "rule_a", targetKey: "owner/repo#1", verdict: "confirmed", occurredAt }),
    ).resolves.toBeUndefined();
  });

  it("a read failure PROPAGATES rather than failing open — a caller must know its history is incomplete, not silently score against a partial one", async () => {
    const env = { ...createTestEnv(), DB: null } as unknown as ReturnType<typeof createTestEnv>;
    const store = createSignalStore(env);
    await expect(store.queryRuleHistory("rule_a", Date.now() - ONE_HOUR_MS)).rejects.toBeDefined();
  });

  it("an empty occurredAt falls back to the current time instead of writing a blank createdAt", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const before = Date.now();
    await store.recordRuleFired({ ruleId: "rule_a", targetKey: "owner/repo#1", outcome: "block", occurredAt: "" });
    await store.recordHumanOverride({ ruleId: "rule_a", targetKey: "owner/repo#1", verdict: "confirmed", occurredAt: "" });
    const after = Date.now();
    const history = await store.queryRuleHistory("rule_a", before - ONE_HOUR_MS);
    expect(history.fired).toHaveLength(1);
    expect(history.overrides).toHaveLength(1);
    const firedAtMs = new Date(history.fired[0]?.occurredAt ?? "").getTime();
    const overrideAtMs = new Date(history.overrides[0]?.occurredAt ?? "").getTime();
    expect(firedAtMs).toBeGreaterThanOrEqual(before);
    expect(firedAtMs).toBeLessThanOrEqual(after);
    expect(overrideAtMs).toBeGreaterThanOrEqual(before);
    expect(overrideAtMs).toBeLessThanOrEqual(after);
  });

  // #7982-defensive: these three simulate a row that never should exist (every real writer round-trips
  // through recordRuleFired/recordHumanOverride, which always produce a string outcome/valid verdict and a
  // real targetKey) by writing directly through recordAuditEvent -- the same "a single bad row must never
  // break a whole precision report" contract listAuditEventsByType's own doc comment states.
  it("a fired row with a non-string/missing metadata.outcome degrades to an empty string rather than throwing", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const now = Date.now();
    await recordAuditEvent(env, {
      eventType: "signal.rule_fired:rule_a",
      actor: "loopover",
      targetKey: "owner/repo#1",
      outcome: "completed",
      metadata: {},
      createdAt: isoOffset(now, 0),
    });
    const history = await store.queryRuleHistory("rule_a", now - ONE_HOUR_MS);
    expect(history.fired).toEqual([{ ruleId: "rule_a", targetKey: "owner/repo#1", outcome: "", occurredAt: isoOffset(now, 0) }]);
  });

  it("a row with a null targetKey degrades to an empty string rather than null", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const now = Date.now();
    await recordAuditEvent(env, {
      eventType: "signal.rule_fired:rule_a",
      actor: "loopover",
      targetKey: null,
      outcome: "completed",
      metadata: { outcome: "block" },
      createdAt: isoOffset(now, 0),
    });
    const history = await store.queryRuleHistory("rule_a", now - ONE_HOUR_MS);
    expect(history.fired[0]?.targetKey).toBe("");
  });

  it("an override row with a verdict other than 'reversed' and a null targetKey degrades to 'confirmed' + '' -- fails toward NOT inflating the reversal count", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const now = Date.now();
    await recordAuditEvent(env, {
      eventType: "signal.human_override:rule_a",
      actor: "human",
      targetKey: null,
      outcome: "completed",
      metadata: {},
      createdAt: isoOffset(now, 0),
    });
    const history = await store.queryRuleHistory("rule_a", now - ONE_HOUR_MS);
    expect(history.overrides[0]?.verdict).toBe("confirmed");
    expect(history.overrides[0]?.targetKey).toBe("");
  });
});

// db/repositories.ts's listAuditEventsByType, tested directly (not through the adapter above) — a corrupt
// metadata_json value can only ever reach a real row via something OTHER than recordAuditEvent (which always
// round-trips through jsonString, producing valid JSON object text), so these simulate that with a raw INSERT.
describe("listAuditEventsByType (#7982) — corrupt-row resilience", () => {
  it("a metadata_json that parses but isn't an object degrades to {} rather than throwing", async () => {
    const env = createTestEnv();
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("corrupt-array", "signal.rule_fired:rule_a", "loopover", "owner/repo#1", "completed", null, "[1,2,3]", nowIso)
      .run();
    const rows = await listAuditEventsByType(env, "signal.rule_fired:rule_a", new Date(Date.now() - ONE_HOUR_MS).toISOString());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({});
  });

  it("an invalid (unparseable) metadata_json degrades to {} rather than throwing", async () => {
    const env = createTestEnv();
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("corrupt-json", "signal.rule_fired:rule_a", "loopover", "owner/repo#1", "completed", null, "{not valid json", nowIso)
      .run();
    const rows = await listAuditEventsByType(env, "signal.rule_fired:rule_a", new Date(Date.now() - ONE_HOUR_MS).toISOString());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({});
  });
});

// #9805: the read bound is now explicit, and `saturated` reports whether it was hit. This matters because
// /v1/public/eval-corpus publishes a checksum over what this returns -- committing a published score to a
// silently-truncated corpus is the failure the flag exists to make impossible.
describe("queryRuleHistory read bound and saturation (#9805)", () => {
  const seed = async (env: Env, ruleId: string, n: number) => {
    const store = createSignalStore(env);
    for (let i = 0; i < n; i += 1) {
      await store.recordRuleFired({
        ruleId,
        targetKey: `acme/widgets#${i}`,
        outcome: "close",
        occurredAt: new Date(Date.now() - 10_000 - i).toISOString(),
        metadata: { confidence: 0.5 },
      });
    }
  };

  it("reports saturated=false when the read comfortably fits inside its bound", async () => {
    const env = createTestEnv();
    await seed(env, "small_rule", 3);
    const history = await createSignalStore(env).queryRuleHistory("small_rule", Date.now() - 86_400_000, 10);
    expect(history.fired).toHaveLength(3);
    expect(history.saturated).toBe(false);
  });

  it("reports saturated=true when the read comes back AT its bound, and returns only that many", async () => {
    const env = createTestEnv();
    await seed(env, "big_rule", 6);
    const history = await createSignalStore(env).queryRuleHistory("big_rule", Date.now() - 86_400_000, 4);
    expect(history.fired).toHaveLength(4); // rows were left behind
    expect(history.saturated).toBe(true);
  });

  it("saturates on the OVERRIDES side too, not just firings", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    for (let i = 0; i < 5; i += 1) {
      await store.recordHumanOverride({
        ruleId: "override_heavy",
        targetKey: `acme/widgets#${i}`,
        verdict: "confirmed",
        occurredAt: new Date(Date.now() - 10_000 - i).toISOString(),
      });
    }
    const history = await store.queryRuleHistory("override_heavy", Date.now() - 86_400_000, 5);
    expect(history.fired).toHaveLength(0);
    expect(history.saturated).toBe(true);
  });

  it("defaults to DEFAULT_RULE_HISTORY_LIMIT when no bound is given, preserving every pre-existing caller", async () => {
    const env = createTestEnv();
    await seed(env, "defaulted", 2);
    const history = await createSignalStore(env).queryRuleHistory("defaulted", Date.now() - 86_400_000);
    expect(history.fired).toHaveLength(2);
    expect(history.saturated).toBe(false);
    expect(DEFAULT_RULE_HISTORY_LIMIT).toBe(500);
  });
});
