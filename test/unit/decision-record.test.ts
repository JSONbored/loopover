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
import { appendDecisionLedger, buildLedgerAnchorPayload, LEDGER_GENESIS_HASH, loadDecisionRecordCollapsible, loadPublicDecisionRecord, verifyDecisionLedger } from "../../src/review/decision-record";
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
    salvageability: null,
    headSha: "abc1234def",
    baseSha: "base999",
    action: "close",
    reasonCode: "ci_readiness",
    configDigest: "c".repeat(64),
    settingsDigest: "s".repeat(64),
    gatePack: "gittensor",
    ciState: "failed",
    modelIds: null,
    promptDigest: null,
    aiConfidence: null,
    divertedByHoldout: false,
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
    const { record: bare } = await buildDecisionRecord({
      ...recordInput(),
      gatePack: undefined,
      ciState: undefined,
      baseSha: undefined,
      aiConfidence: undefined,
      settingsDigest: undefined,
      divertedByHoldout: undefined,
    });
    expect(bare.gatePack).toBeNull();
    expect(bare.ciState).toBeNull();
    expect(bare.baseSha).toBeNull();
    expect(bare.aiConfidence).toBeNull();
    // #9124/#9135: the two newest optional-normalized fields default the same way — null/false, not undefined.
    expect(bare.settingsDigest).toBeNull();
    expect(bare.divertedByHoldout).toBe(false);
    // #8834: a stated confidence (including explicit 0) survives normalization.
    const { record: withConf } = await buildDecisionRecord({ ...recordInput(), aiConfidence: 0 });
    expect(withConf.aiConfidence).toBe(0);
    // #9135: an explicit true is never coerced back to the false default.
    const { record: diverted } = await buildDecisionRecord({ ...recordInput(), divertedByHoldout: true });
    expect(diverted.divertedByHoldout).toBe(true);
  });

  it("a re-persist at the SAME (repo, pull, head) is a NEW revisioned row, never an overwrite (#9123)", async () => {
    const env = createTestEnv();
    const first = await buildDecisionRecord(recordInput({ action: "merge", reasonCode: "success", decidedAt: "2026-07-26T00:00:00Z" } as never));
    const firstId = await persistDecisionRecord(env, first.record, first.recordDigest);
    // The FIRST record for a head keeps the plain, no-suffix id every existing consumer (the replay CLI's
    // documented extract query) already expects.
    expect(firstId).toBe(`record:o/r#7@abc1234def`);
    const second = await buildDecisionRecord(recordInput({ action: "close", reasonCode: "policy_close:contributor_cap", decidedAt: "2026-07-26T01:00:00Z" } as never));
    const secondId = await persistDecisionRecord(env, second.record, second.recordDigest);
    expect(secondId).toBe(`record:o/r#7@abc1234def:rev2`);
    const rows = (
      await env.DB.prepare("SELECT id, action, reason_code, record_digest, record_json FROM decision_records ORDER BY id").all<{ id: string; action: string; reason_code: string; record_digest: string; record_json: string }>()
    ).results!;
    // BOTH rows exist -- the compounding bug this fixes was the second write silently overwriting the first.
    expect(rows).toHaveLength(2);
    const firstRow = rows.find((row) => row.id === firstId)!;
    expect(firstRow).toMatchObject({ action: "merge", reason_code: "success", record_digest: first.recordDigest });
    // The FIRST record's preimage is still fully intact and re-hashes to the digest the ledger chained for it.
    expect(await sha256Hex(firstRow.record_json)).toBe(first.recordDigest);
    const secondRow = rows.find((row) => row.id === secondId)!;
    expect(secondRow).toMatchObject({ action: "close", reason_code: "policy_close:contributor_cap", record_digest: second.recordDigest });
    // Both writes chained into the ledger as their OWN rows (two appends, not a rewrite of one).
    const ledgerRecordIds = (await env.DB.prepare("SELECT record_id AS recordId FROM decision_ledger ORDER BY seq").all<{ recordId: string }>()).results!.map((row) => row.recordId);
    expect(ledgerRecordIds).toEqual([firstId, secondId]);
  });

  it("a third persist at the same head keeps counting revisions (:rev2, :rev3, ...)", async () => {
    const env = createTestEnv();
    const one = await buildDecisionRecord(recordInput({ decidedAt: "2026-07-26T00:00:00Z" } as never));
    const two = await buildDecisionRecord(recordInput({ decidedAt: "2026-07-26T01:00:00Z" } as never));
    const three = await buildDecisionRecord(recordInput({ decidedAt: "2026-07-26T02:00:00Z" } as never));
    const idOne = await persistDecisionRecord(env, one.record, one.recordDigest);
    const idTwo = await persistDecisionRecord(env, two.record, two.recordDigest);
    const idThree = await persistDecisionRecord(env, three.record, three.recordDigest);
    expect([idOne, idTwo, idThree]).toEqual([`record:o/r#7@abc1234def`, `record:o/r#7@abc1234def:rev2`, `record:o/r#7@abc1234def:rev3`]);
  });

  it("a persist failure is swallowed (legibility must never break finalization) and resolves null", async () => {
    const env = createTestEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("db down");
    });
    const { record, recordDigest } = await buildDecisionRecord(recordInput());
    await expect(persistDecisionRecord(env, record, recordDigest)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("an INSERT collision (a concurrent supersession racing the count-then-insert) retries and lands on the next revision", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    let insertAttempts = 0;
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO decision_records")) {
        insertAttempts += 1;
        if (insertAttempts === 1) {
          return { bind: () => ({ run: async () => { throw new Error("UNIQUE constraint failed: decision_records.id"); } }) } as never;
        }
      }
      return realPrepare(sql);
    });
    const { record, recordDigest } = await buildDecisionRecord(recordInput());
    const id = await persistDecisionRecord(env, record, recordDigest);
    expect(id).toBe(`record:o/r#7@abc1234def`);
    expect(insertAttempts).toBe(2);
    vi.restoreAllMocks();
  });

  it("an exhausted INSERT retry budget rethrows, swallowed by the outer best-effort catch (resolves null, warns)", async () => {
    const env = createTestEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const realPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO decision_records")) {
        return { bind: () => ({ run: async () => { throw new Error("UNIQUE constraint failed: decision_records.id"); } }) } as never;
      }
      return realPrepare(sql);
    });
    const { record, recordDigest } = await buildDecisionRecord(recordInput());
    await expect(persistDecisionRecord(env, record, recordDigest, 2)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("renderDecisionRecordSection", () => {
  it("renders the claim + FULL 64-hex digests (#9123 -- a prefix is not a commitment); model line only when an AI review contributed", async () => {
    const { record, recordDigest } = await buildDecisionRecord(recordInput());
    const body = renderDecisionRecordSection(record, recordDigest);
    // The section body carries no <details> chrome — the bridge's UnifiedCollapsible renders the title.
    expect(body).not.toContain("<details>");
    expect(body).toContain("`ci_readiness`");
    // Full digests, not a 12-char prefix -- a challenger must be able to re-hash and compare the WHOLE value.
    expect(body).toContain(`\`${record.configDigest}\``);
    expect(record.configDigest).toHaveLength(64);
    expect(body).toContain(`\`${recordDigest}\``);
    expect(body).not.toContain("**model**");
    // The head sha keeps its conventional 7-char git-abbreviation — a display convention, not a digest.
    expect(body).toContain(`\`${record.headSha.slice(0, 7)}\``);

    const ai = await buildDecisionRecord(recordInput({ modelIds: ["claude-sonnet-5"], promptDigest: "p".repeat(64), aiConfidence: 0.97 }));
    const aiBody = renderDecisionRecordSection(ai.record, ai.recordDigest);
    expect(aiBody).toContain("**model**: claude-sonnet-5");
    expect(aiBody).toContain(`\`${"p".repeat(64)}\``);
    expect(aiBody).toContain("**confidence**: 0.97");
    // Bounded: a record section must stay a small fixed-size block even with three full 64-hex digests inline.
    expect(aiBody.length).toBeLessThan(900);

    // #9124: more than one parsed reviewer joins with "+" — the full set, never a representative one.
    const dual = await buildDecisionRecord(recordInput({ modelIds: ["claude-code", "codex"], promptDigest: "p".repeat(64), aiConfidence: 0.8 }));
    expect(renderDecisionRecordSection(dual.record, dual.recordDigest)).toContain("**model**: claude-code+codex");

    // Null pack/ci render nothing for those segments; a prompt digest without a model id renders "n/a".
    const bare = await buildDecisionRecord(recordInput({ gatePack: null, ciState: null, modelIds: null, promptDigest: "q".repeat(64) }));
    const bareBody = renderDecisionRecordSection(bare.record, bare.recordDigest);
    expect(bareBody).not.toContain("**pack**");
    expect(bareBody).not.toContain("**ci**");
    expect(bareBody).toContain("**model**: n/a");
    expect(bareBody).toContain(`\`${"q".repeat(64)}\``);
    // Model id present with NO prompt digest: the model line renders without a prompt segment.
    const modelOnly = await buildDecisionRecord(recordInput({ modelIds: ["claude-sonnet-5"] }));
    expect(renderDecisionRecordSection(modelOnly.record, modelOnly.recordDigest)).toContain("**model**: claude-sonnet-5");
    expect(renderDecisionRecordSection(modelOnly.record, modelOnly.recordDigest)).not.toContain("**prompt**");
  });

  it("#9135: a diverted-by-holdout decision surfaces the note on the record's own face", async () => {
    const notDiverted = await buildDecisionRecord(recordInput());
    expect(renderDecisionRecordSection(notDiverted.record, notDiverted.recordDigest)).not.toContain("**note**");
    const diverted = await buildDecisionRecord(recordInput({ action: "hold", divertedByHoldout: true }));
    const body = renderDecisionRecordSection(diverted.record, diverted.recordDigest);
    expect(body).toContain("**note**");
    expect(body).toContain("close-audit holdout");
  });

  it("defends against a genuinely ABSENT (not merely null) field from an older persisted record's JSON", async () => {
    const { record, recordDigest } = await buildDecisionRecord(recordInput());
    // Simulate a pre-#9135 stored record.json: divertedByHoldout was never a key at all, not present-as-null.
    const preExisting = { ...record } as Partial<DecisionRecord>;
    delete preExisting.divertedByHoldout;
    const body = renderDecisionRecordSection(preExisting as DecisionRecord, recordDigest);
    expect(body).not.toContain("**note**"); // degrades to false, same as an explicit false
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

describe("loadPublicDecisionRecord (#9123)", () => {
  it("returns the latest record verbatim + its digest for the public route; null when none exists yet", async () => {
    const env = createTestEnv();
    expect(await loadPublicDecisionRecord(env, "o/r", 7)).toBeNull();
    const { record, recordDigest } = await buildDecisionRecord(recordInput());
    await persistDecisionRecord(env, record, recordDigest);
    const published = await loadPublicDecisionRecord(env, "o/r", 7);
    expect(published!.recordDigest).toBe(recordDigest);
    // Verbatim -- every field survives, not the bounded/truncated markdown summary.
    expect(published!.record).toEqual(record);
    expect(published!.record.decidedAt).toBeTruthy();
    expect(published!.record.baseSha).toBe("base999");
  });

  it("returns the LATEST revision after a supersession, not the superseded first record", async () => {
    const env = createTestEnv();
    const first = await buildDecisionRecord(recordInput({ action: "merge", decidedAt: "2026-07-26T00:00:00Z" } as never));
    await persistDecisionRecord(env, first.record, first.recordDigest);
    const second = await buildDecisionRecord(recordInput({ action: "close", decidedAt: "2026-07-26T01:00:00Z" } as never));
    await persistDecisionRecord(env, second.record, second.recordDigest);
    const published = await loadPublicDecisionRecord(env, "o/r", 7);
    expect(published!.recordDigest).toBe(second.recordDigest);
    expect(published!.record.action).toBe("close");
  });

  it("fails safe (null) on unreadable stored JSON rather than throwing", async () => {
    const env = createTestEnv();
    const { record, recordDigest } = await buildDecisionRecord(recordInput());
    await persistDecisionRecord(env, record, recordDigest);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await env.DB.prepare("UPDATE decision_records SET record_json = '{not json' WHERE pull_number = 7").run();
    expect(await loadPublicDecisionRecord(env, "o/r", 7)).toBeNull();
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("buildLedgerAnchorPayload (#9122)", () => {
  it("returns exactly {seq, rowHash, at} from a tip, using a caller-supplied timestamp", () => {
    const payload = buildLedgerAnchorPayload({ seq: 5, rowHash: "a".repeat(64) }, "2026-01-01T00:00:00.000Z");
    expect(payload).toEqual({ seq: 5, rowHash: "a".repeat(64), at: "2026-01-01T00:00:00.000Z" });
  });

  it("defaults `at` to the current time when the caller omits it", () => {
    const beforeMs = Date.now();
    const payload = buildLedgerAnchorPayload({ seq: 1, rowHash: LEDGER_GENESIS_HASH });
    expect(payload.seq).toBe(1);
    expect(payload.rowHash).toBe(LEDGER_GENESIS_HASH);
    expect(Date.parse(payload.at)).toBeGreaterThanOrEqual(beforeMs);
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
    // #9122: the current global tip + total row count are always returned, so a third party can checkpoint.
    expect(verified.tipSeq).toBe(3);
    expect(verified.tipHash).toBe(rows[2]!.rowHash);
    expect(verified.totalCount).toBe(3);
  });

  it("verifying a completely empty ledger returns ok:true with a zero tip, and skips the tail-truncation check (nothing to anchor against yet)", async () => {
    const env = createTestEnv();
    const verified = await verifyDecisionLedger(env);
    expect(verified).toEqual({ ok: true, checked: 0, nextAfterSeq: null, tipSeq: 0, tipHash: LEDGER_GENESIS_HASH, totalCount: 0 });
  });

  it("TAIL TRUNCATION now breaks verify instead of passing clean (#9122): dropping the newest ledger rows leaves an orphaned decision_records tail", async () => {
    const env = createTestEnv();
    // Force well-separated, deterministic timestamps via fake system time (not a post-hoc created_at UPDATE --
    // that would desync row_hash, which is computed OVER createdAt at write time, from the stored value and
    // make every row after it look like a row_hash_mismatch instead of exercising the real, timing-independent
    // tail-truncation bug this test pins). Five persists in a tight loop could otherwise land in the same
    // millisecond on a fast in-memory harness, which would make the reconciliation's strict `created_at >`
    // comparison flaky.
    vi.useFakeTimers();
    try {
      for (let i = 1; i <= 5; i += 1) {
        vi.setSystemTime(new Date(2026, 0, 1, 0, 0, i));
        await persist(env, i);
      }
    } finally {
      vi.useRealTimers();
    }
    // Drop the newest 2 ledger rows (the most disputable, per the issue) -- their decision_records rows
    // (pulls 4 and 5) are untouched, since the DELETE only targets decision_ledger.
    await env.DB.prepare("DELETE FROM decision_ledger WHERE seq > 3").run();
    const verified = await verifyDecisionLedger(env);
    expect(verified.ok).toBe(false);
    expect(verified.break).toEqual({ kind: "short_tail", atSeq: 3 });
    expect(verified.checked).toBe(3); // rows 1-3 verify perfectly clean on their own
    expect(verified.totalCount).toBe(3); // the ledger itself only knows about what's left
  });

  it("a genuinely short ledger with NO orphaned records still verifies clean (both sides of the reconciliation)", async () => {
    const env = createTestEnv();
    await persist(env, 1);
    await persist(env, 2);
    const verified = await verifyDecisionLedger(env);
    expect(verified.ok).toBe(true);
    expect(verified.break).toBeUndefined();
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
