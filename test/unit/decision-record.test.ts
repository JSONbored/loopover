import { describe, expect, it, vi } from "vitest";
import {
  buildDecisionRecord,
  canonicalJson,
  contentDigest,
  DECISION_RECORD_SCHEMA_VERSION,
  persistDecisionRecord,
  renderDecisionRecordSection,
  sha256Hex,
  type DecisionRecord,
} from "../../src/review/decision-record";
import { loadDecisionRecordCollapsible } from "../../src/review/decision-record";
import { createTestEnv } from "../helpers/d1";

// #8836: the digests are commitments a contributor can challenge — key-order invariance and unicode
// stability are not niceties, they are what makes "config abc123" a meaningful claim.
describe("canonicalJson", () => {
  it("is KEY-ORDER INVARIANT at every nesting depth", () => {
    const a = { b: 1, a: { d: [1, 2], c: "x" } };
    const b = { a: { c: "x", d: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
  });

  it("preserves array order (order IS meaning there), drops undefined members, and is unicode-stable", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
    expect(canonicalJson("hélloé")).toBe(JSON.stringify("hélloé"));
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(3.5)).toBe("3.5");
    expect(canonicalJson([undefined])).toBe("[null]"); // JSON.stringify's own array-slot coercion, delegated per-entry
  });

  it("REFUSES un-JSON-able values loudly — a silent wrong digest is worse than a throw", () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/unsupported value type/);
    expect(() => canonicalJson(Symbol("x") as never)).toThrow(/unsupported value type/);
  });
});

describe("sha256Hex / contentDigest", () => {
  it("matches the known SHA-256 of 'abc' and digests canonical forms identically", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await contentDigest({ b: 1, a: 2 })).toBe(await contentDigest({ a: 2, b: 1 }));
    expect(await contentDigest({ a: 2 })).not.toBe(await contentDigest({ a: 3 }));
  });
});

function recordInput(over: Partial<DecisionRecord> = {}): Omit<DecisionRecord, "schemaVersion" | "decidedAt"> {
  return {
    repoFullName: "o/r",
    pullNumber: 7,
    headSha: "abc1234def",
    baseSha: "base999",
    action: "close",
    reasonCode: "ci_readiness",
    configDigest: "c".repeat(64),
    gatePack: "gittensor",
    ciState: "failed",
    modelId: null,
    promptDigest: null,
    ...over,
  };
}

describe("buildDecisionRecord / persistDecisionRecord", () => {
  it("stamps schema version + decidedAt, digests the whole record, and normalizes undefined optionals to null", async () => {
    const { record, recordDigest } = await buildDecisionRecord(recordInput());
    expect(record.schemaVersion).toBe(DECISION_RECORD_SCHEMA_VERSION);
    expect(typeof record.decidedAt).toBe("string");
    expect(recordDigest).toBe(await contentDigest(record));
    // Call sites pass optional-shaped settings fields raw; normalization happens HERE, once.
    const { record: bare } = await buildDecisionRecord({ ...recordInput(), gatePack: undefined, ciState: undefined, baseSha: undefined });
    expect(bare.gatePack).toBeNull();
    expect(bare.ciState).toBeNull();
    expect(bare.baseSha).toBeNull();
  });

  it("persists with latest-finalize-wins per (target, head sha)", async () => {
    const env = createTestEnv();
    const first = await buildDecisionRecord(recordInput({ action: "merge", reasonCode: "success", decidedAt: "2026-07-26T00:00:00Z" } as never));
    await persistDecisionRecord(env, first.record, first.recordDigest);
    const second = await buildDecisionRecord(recordInput({ action: "close", reasonCode: "policy_close:contributor_cap", decidedAt: "2026-07-26T01:00:00Z" } as never));
    await persistDecisionRecord(env, second.record, second.recordDigest);
    const rows = await env.DB.prepare("SELECT action, reason_code, record_digest, record_json FROM decision_records").all<{ action: string; reason_code: string; record_digest: string; record_json: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]).toMatchObject({ action: "close", reason_code: "policy_close:contributor_cap", record_digest: second.recordDigest });
    // The stored JSON is the canonical form — re-digesting it reproduces the stored digest (the replay check).
    expect(await sha256Hex(rows.results![0]!.record_json)).toBe(second.recordDigest);
  });

  it("a persist failure is swallowed (legibility must never break finalization)", async () => {
    const env = createTestEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("db down");
    });
    const { record, recordDigest } = await buildDecisionRecord(recordInput());
    await expect(persistDecisionRecord(env, record, recordDigest)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("renderDecisionRecordSection", () => {
  it("renders the claim + truncated digests; model line only when an AI review contributed", async () => {
    const { record, recordDigest } = await buildDecisionRecord(recordInput());
    const body = renderDecisionRecordSection(record, recordDigest);
    // The section body carries no <details> chrome — the bridge's UnifiedCollapsible renders the title.
    expect(body).not.toContain("<details>");
    expect(body).toContain("`ci_readiness`");
    expect(body).toContain(record.configDigest.slice(0, 12));
    expect(body).toContain(recordDigest.slice(0, 12));
    expect(body).not.toContain("**model**");

    const ai = await buildDecisionRecord(recordInput({ modelId: "claude-sonnet-5", promptDigest: "p".repeat(64) }));
    const aiBody = renderDecisionRecordSection(ai.record, ai.recordDigest);
    expect(aiBody).toContain("**model**: claude-sonnet-5");
    expect(aiBody).toContain("`pppppppppppp`");
    // Bounded: a record section must stay a small fixed-size block.
    expect(aiBody.length).toBeLessThan(700);

    // Null pack/ci render nothing for those segments; a prompt digest without a model id renders "n/a".
    const bare = await buildDecisionRecord(recordInput({ gatePack: null, ciState: null, modelId: null, promptDigest: "q".repeat(64) }));
    const bareBody = renderDecisionRecordSection(bare.record, bare.recordDigest);
    expect(bareBody).not.toContain("**pack**");
    expect(bareBody).not.toContain("**ci**");
    expect(bareBody).toContain("**model**: n/a");
    expect(bareBody).toContain("`qqqqqqqqqqqq`");
    // Model id present with NO prompt digest: the model line renders without a prompt segment.
    const modelOnly = await buildDecisionRecord(recordInput({ modelId: "claude-sonnet-5" }));
    expect(renderDecisionRecordSection(modelOnly.record, modelOnly.recordDigest)).toContain("**model**: claude-sonnet-5");
    expect(renderDecisionRecordSection(modelOnly.record, modelOnly.recordDigest)).not.toContain("**prompt**");
  });
});

describe("loadDecisionRecordCollapsible", () => {
  it("returns the latest record as a collapsible; null when none exists; null (fail-safe) on unreadable JSON", async () => {
    const env = createTestEnv();
    expect(await loadDecisionRecordCollapsible(env, "o/r", 7)).toBeNull();
    const { record, recordDigest } = await buildDecisionRecord(recordInput());
    await persistDecisionRecord(env, record, recordDigest);
    const collapsible = await loadDecisionRecordCollapsible(env, "o/r", 7);
    expect(collapsible!.title).toBe("Decision record");
    expect(collapsible!.body).toContain(record.configDigest.slice(0, 12));
    // Corrupt the stored JSON: the publish path must omit the section, never throw.
    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await env.DB.prepare("UPDATE decision_records SET record_json = '{not json' WHERE pull_number = 7").run();
    expect(await loadDecisionRecordCollapsible(env, "o/r", 7)).toBeNull();
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
