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
import { appendDecisionLedger, LEDGER_GENESIS_HASH, loadDecisionRecordCollapsible, verifyDecisionLedger } from "../../src/review/decision-record";
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
    aiConfidence: null,
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
    const { record: bare } = await buildDecisionRecord({ ...recordInput(), gatePack: undefined, ciState: undefined, baseSha: undefined, aiConfidence: undefined });
    expect(bare.gatePack).toBeNull();
    expect(bare.ciState).toBeNull();
    expect(bare.baseSha).toBeNull();
    expect(bare.aiConfidence).toBeNull();
    // #8834: a stated confidence (including explicit 0) survives normalization.
    const { record: withConf } = await buildDecisionRecord({ ...recordInput(), aiConfidence: 0 });
    expect(withConf.aiConfidence).toBe(0);
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

    const ai = await buildDecisionRecord(recordInput({ modelId: "claude-sonnet-5", promptDigest: "p".repeat(64), aiConfidence: 0.97 }));
    const aiBody = renderDecisionRecordSection(ai.record, ai.recordDigest);
    expect(aiBody).toContain("**model**: claude-sonnet-5");
    expect(aiBody).toContain("`pppppppppppp`");
    expect(aiBody).toContain("**confidence**: 0.97");
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

describe("decision ledger (#8837)", () => {
  const persist = async (env: Env, pull: number, action = "close") => {
    const { record, recordDigest } = await buildDecisionRecord(recordInput({ pullNumber: pull, action }));
    await persistDecisionRecord(env, record, recordDigest);
    return recordDigest;
  };

  it("every persist appends a chained row: explicit contiguous seq, genesis prev, linked hashes", async () => {
    const env = createTestEnv();
    await persist(env, 1);
    await persist(env, 2);
    // A rewrite of the SAME record id appends a THIRD row — supersessions are visible history.
    await persist(env, 1, "merge");
    const rows = (await env.DB.prepare("SELECT seq, prev_hash AS prevHash, row_hash AS rowHash FROM decision_ledger ORDER BY seq").all<{ seq: number; prevHash: string; rowHash: string }>()).results!;
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]!.prevHash).toBe(LEDGER_GENESIS_HASH);
    expect(rows[1]!.prevHash).toBe(rows[0]!.rowHash);
    expect(rows[2]!.prevHash).toBe(rows[1]!.rowHash);
    const verified = await verifyDecisionLedger(env);
    expect(verified).toMatchObject({ ok: true, checked: 3, nextAfterSeq: null });
  });

  it("verification is RESUMABLE: a full window returns the cursor, the next call continues from it", async () => {
    const env = createTestEnv();
    for (let i = 1; i <= 5; i += 1) await persist(env, i);
    const first = await verifyDecisionLedger(env, 0, 2);
    expect(first).toMatchObject({ ok: true, checked: 2, nextAfterSeq: 2 });
    const second = await verifyDecisionLedger(env, first.nextAfterSeq!, 2);
    expect(second).toMatchObject({ ok: true, checked: 2, nextAfterSeq: 4 });
    const last = await verifyDecisionLedger(env, second.nextAfterSeq!, 2);
    expect(last).toMatchObject({ ok: true, checked: 1, nextAfterSeq: null });
    // Resuming from a seq that does not exist is itself a reported gap, not a silent clean pass.
    expect((await verifyDecisionLedger(env, 99)).break).toMatchObject({ kind: "sequence_gap" });
  });

  it("reports the FIRST break per corruption class: gap, predecessor, row rewrite", async () => {
    const gapEnv = createTestEnv();
    for (let i = 1; i <= 3; i += 1) await persist(gapEnv, i);
    await gapEnv.DB.prepare("DELETE FROM decision_ledger WHERE seq = 2").run();
    expect((await verifyDecisionLedger(gapEnv)).break).toMatchObject({ kind: "sequence_gap", atSeq: 3, expectedSeq: 2 });

    const predEnv = createTestEnv();
    for (let i = 1; i <= 3; i += 1) await persist(predEnv, i);
    await predEnv.DB.prepare("UPDATE decision_ledger SET prev_hash = ? WHERE seq = 3").bind("f".repeat(64)).run();
    expect((await verifyDecisionLedger(predEnv)).break).toMatchObject({ kind: "predecessor_mismatch", atSeq: 3 });

    const rewriteEnv = createTestEnv();
    for (let i = 1; i <= 3; i += 1) await persist(rewriteEnv, i);
    await rewriteEnv.DB.prepare("UPDATE decision_ledger SET record_digest = ? WHERE seq = 2").bind("a".repeat(64)).run();
    const broken = await verifyDecisionLedger(rewriteEnv);
    expect(broken.break).toMatchObject({ kind: "row_hash_mismatch", atSeq: 2 });
    expect(broken.checked).toBe(1); // seq 1 verified before the break
  });

  it("a concurrent append races on the PK and retries with a re-read predecessor — both rows land, chain intact", async () => {
    const env = createTestEnv();
    await Promise.all([appendDecisionLedger(env, "record:a", "1".repeat(64)), appendDecisionLedger(env, "record:b", "2".repeat(64))]);
    const verified = await verifyDecisionLedger(env);
    expect(verified).toMatchObject({ ok: true, checked: 2 });
  });

  it("an exhausted retry budget rethrows (persistDecisionRecord's own warn covers it)", async () => {
    const env = createTestEnv();
    await appendDecisionLedger(env, "record:a", "1".repeat(64));
    const { vi } = await import("vitest");
    const realPrepare = env.DB.prepare.bind(env.DB);
    // Freeze the tip read at a stale value so every retry collides.
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("ORDER BY seq DESC LIMIT 1")) {
        return { first: async () => ({ seq: 0, rowHash: LEDGER_GENESIS_HASH }) } as never;
      }
      return realPrepare(sql);
    });
    await expect(appendDecisionLedger(env, "record:c", "3".repeat(64), 2)).rejects.toThrow();
    vi.restoreAllMocks();
  });
});
