import { describe, expect, it, vi } from "vitest";
import {
  buildDecisionRecord,
  canonicalJson,
  contentDigest,
  DECISION_RECORD_SCHEMA_VERSION,
  parseLedgerContentWaiver,
  persistDecisionRecord,
  deriveReevaluationReason,
  REEVALUATION_REASON_BY_ORIGIN,
  REEVALUATION_REASONS,
  UndeclaredReevaluationError,
  isReevaluationReason,
  renderDecisionRecordSection,
  sha256Hex,
  type DecisionRecord,
} from "../../src/review/decision-record";
import { DELIVERY_ID_ORIGINS, DELIVERY_ID_PREFIXES, deliveryIdFor, deliveryIdOrigin } from "../../src/queue/delivery-id";
import { appendDecisionLedger, LEDGER_GENESIS_HASH, loadDecisionLedgerTip, loadDecisionRecordCollapsible, loadPublicDecisionRecord, verifyDecisionLedger } from "../../src/review/decision-record";
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
    aiAgreement: null,
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
    // #9742: a repeat evaluation of the same head SHA must now DECLARE why. The revisioning this test pins
    // is unchanged; only the requirement to say why is new.
    const secondId = await persistDecisionRecord(env, second.record, second.recordDigest, 3, { reason: "config_change" });
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
    const idTwo = await persistDecisionRecord(env, two.record, two.recordDigest, 3, { reason: "config_change" });
    const idThree = await persistDecisionRecord(env, three.record, three.recordDigest, 3, { reason: "config_change" });
    expect([idOne, idTwo, idThree]).toEqual([`record:o/r#7@abc1234def`, `record:o/r#7@abc1234def:rev2`, `record:o/r#7@abc1234def:rev3`]);
  });

  it("#9078: a ledger-append failure after a successful record insert raises a dedicated alarm (not a swallowed warn) and still returns the id", async () => {
    const env = createTestEnv();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const realPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO decision_ledger")) {
        return {
          bind: () => ({
            run: async () => {
              throw new Error("ledger down");
            },
          }),
        } as never;
      }
      return realPrepare(sql);
    });
    const { record, recordDigest } = await buildDecisionRecord(recordInput());
    const id = await persistDecisionRecord(env, record, recordDigest);
    // The record row itself still landed -- an append failure must not be conflated with a persist failure.
    expect(id).toBe(`record:o/r#7@abc1234def`);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("decision_ledger_append_failed"));
    expect(warnSpy).not.toHaveBeenCalled();
    const row = await env.DB.prepare("SELECT id FROM decision_records WHERE id = ?").bind(id).first();
    expect(row).toBeTruthy();
    const ledgerRow = await env.DB.prepare("SELECT seq FROM decision_ledger").first();
    // Unchained -- exactly the state verifyDecisionLedger's `missing_record` reconciliation now catches.
    expect(ledgerRow ?? null).toBeNull();
    vi.restoreAllMocks();
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
    await persistDecisionRecord(env, second.record, second.recordDigest, 3, { reason: "config_change" });
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

// #9270 superseded the old {seq, rowHash, at} stub that used to live here (buildLedgerAnchorPayload) with a
// self-describing, SIGNED payload -- see src/review/ledger-anchor.ts and test/unit/ledger-anchor.test.ts.

describe("loadDecisionLedgerTip (#9274)", () => {
  it("returns genesis/seq 0/count 0 on an empty ledger", async () => {
    expect(await loadDecisionLedgerTip(createTestEnv())).toEqual({ seq: 0, rowHash: LEDGER_GENESIS_HASH, totalCount: 0 });
  });

  it("returns the real tip and total count once records exist, lighter than a full verify walk", async () => {
    const env = createTestEnv();
    await appendDecisionLedger(env, "record:acme/widgets#1", "digest1");
    await appendDecisionLedger(env, "record:acme/widgets#2", "digest2");
    const tip = await loadDecisionLedgerTip(env);
    expect(tip.seq).toBe(2);
    expect(tip.totalCount).toBe(2);
    expect(tip.rowHash).toMatch(/^[0-9a-f]{64}$/);
    // Matches what verifyDecisionLedger's own tip computation reports for the same chain.
    const verified = await verifyDecisionLedger(env);
    expect(tip).toEqual({ seq: verified.tipSeq, rowHash: verified.tipHash, totalCount: verified.totalCount });
  });
});

describe("decision ledger (#8837)", () => {
  /** #9742: `reevaluation` is threaded so a helper that deliberately re-persists the SAME target can say
   *  why, exactly as a real re-evaluation must. A first persist passes none, like every ordinary write. */
  const persist = async (env: Env, pull: number, action = "close", reevaluation?: { reason: "config_change" }) => {
    const { record, recordDigest } = await buildDecisionRecord(recordInput({ pullNumber: pull, action }));
    await persistDecisionRecord(env, record, recordDigest, 3, reevaluation);
    return recordDigest;
  };

  it("every persist appends a chained row: explicit contiguous seq, genesis prev, linked hashes", async () => {
    const env = createTestEnv();
    await persist(env, 1);
    await persist(env, 2);
    // A rewrite of the SAME record id appends a THIRD row — supersessions are visible history.
    await persist(env, 1, "merge", { reason: "config_change" });
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
    expect(verified).toEqual({ ok: true, checked: 0, nextAfterSeq: null, tipSeq: 0, tipHash: LEDGER_GENESIS_HASH, totalCount: 0, prunedRecords: 0, contentMismatches: 0, waivedContentMismatches: 0, contentWaiver: null });
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
    // #9078: verifyDecisionLedger now reconciles every chain row against a real decision_records preimage, so
    // this test (which is really about the ledger's own PK-collision race, not persistDecisionRecord's insert
    // path) needs real backing rows instead of the bare synthetic digests it used before that reconciliation
    // existed.
    const a = await buildDecisionRecord(recordInput({ pullNumber: 201 }));
    const b = await buildDecisionRecord(recordInput({ pullNumber: 202 }));
    for (const [id, built] of [
      ["record:a", a],
      ["record:b", b],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, built.record.repoFullName, built.record.pullNumber, built.record.headSha, built.record.action, built.record.reasonCode, built.recordDigest, canonicalJson(built.record), built.record.decidedAt)
        .run();
    }
    await Promise.all([appendDecisionLedger(env, "record:a", a.recordDigest), appendDecisionLedger(env, "record:b", b.recordDigest)]);
    const verified = await verifyDecisionLedger(env);
    expect(verified).toMatchObject({ ok: true, checked: 2 });
  });

  it("#9078: a rewritten record_json is caught as a content mismatch even when the record_digest column is untouched", async () => {
    const env = createTestEnv();
    await persist(env, 1);
    await env.DB.prepare("UPDATE decision_records SET record_json = ? WHERE pull_number = 1")
      .bind(JSON.stringify({ tampered: true }))
      .run();
    const verified = await verifyDecisionLedger(env);
    expect(verified.ok).toBe(false);
    expect(verified.break).toMatchObject({ kind: "content_mismatch", atSeq: 1, recordId: "record:o/r#1@abc1234def" });
  });

  it("#9078: unreadable record_json is treated as a content mismatch rather than throwing", async () => {
    const env = createTestEnv();
    await persist(env, 1);
    await env.DB.prepare("UPDATE decision_records SET record_json = '{not json' WHERE pull_number = 1").run();
    const verified = await verifyDecisionLedger(env);
    expect(verified.ok).toBe(false);
    expect(verified.break).toMatchObject({ kind: "content_mismatch" });
  });

  it("#9078: a ledger row whose decision_records preimage was deleted outright is reported as a missing record, distinct from a content mismatch", async () => {
    const env = createTestEnv();
    await persist(env, 1);
    await env.DB.prepare("DELETE FROM decision_records WHERE pull_number = 1").run();
    const verified = await verifyDecisionLedger(env);
    expect(verified.ok).toBe(false);
    expect(verified.break).toMatchObject({ kind: "missing_record", recordId: "record:o/r#1@abc1234def" });
  });

  it("#9078: an untampered chain still verifies clean through the new content reconciliation", async () => {
    const env = createTestEnv();
    await persist(env, 1);
    await persist(env, 2);
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

// #9474 + #9489: the verifier's two relationships with ABSENCE. A record can be absent because the published
// retention policy pruned it (legitimate, must NOT read as tampering) or because something deleted it out of
// band (must). And a record can lack a chain row because the append is milliseconds in flight (legitimate) or
// because the append failed / the tail was truncated (must be reported -- including INTERIOR orphans, which
// the old tail-only comparison lost forever the moment any newer row chained).
describe("verifier vs absence (#9474 pruned records, #9489 grace + interior orphans)", () => {
  const persist = async (env: Env, pull: number, action = "close") => {
    const { record, recordDigest } = await buildDecisionRecord(recordInput({ pullNumber: pull, action }));
    await persistDecisionRecord(env, record, recordDigest);
    return recordDigest;
  };
  /** Persist with the system clock frozen at `at` so the row's hash-chained created_at is genuinely old --
   *  a post-hoc UPDATE of created_at would desync row_hash and turn every test below into row_hash_mismatch. */
  const persistAt = async (env: Env, pull: number, at: Date) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at);
      await persist(env, pull);
    } finally {
      vi.useRealTimers();
    }
  };
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  it("REGRESSION (#9474): a record pruned by the 180-day retention window verifies clean, counted in prunedRecords -- not reported as tampering", async () => {
    const env = createTestEnv();
    await persistAt(env, 1, daysAgo(200)); // older than the decision_records window: prunable
    await persistAt(env, 2, daysAgo(10)); // young: its record must survive
    // Simulate exactly what pruneExpiredRecords does: delete the RECORD, never the ledger row.
    const first = await env.DB.prepare("SELECT record_id AS id FROM decision_ledger WHERE seq = 1").first<{ id: string }>();
    await env.DB.prepare("DELETE FROM decision_records WHERE id = ?").bind(first!.id).run();

    const verified = await verifyDecisionLedger(env);

    expect(verified.ok).toBe(true);
    expect(verified.break).toBeUndefined();
    expect(verified.prunedRecords).toBe(1);
    expect(verified.checked).toBe(2); // the chain checks still ran over BOTH rows
  });

  it("INVARIANT (#9474): a RECENT record deleted out of band is still missing_record -- the tolerance keys on the hash-chained ledger timestamp, so it cannot launder a fresh deletion", async () => {
    const env = createTestEnv();
    await persistAt(env, 1, daysAgo(10)); // far inside the retention window
    const first = await env.DB.prepare("SELECT record_id AS id FROM decision_ledger WHERE seq = 1").first<{ id: string }>();
    await env.DB.prepare("DELETE FROM decision_records WHERE id = ?").bind(first!.id).run();

    const verified = await verifyDecisionLedger(env);

    expect(verified.ok).toBe(false);
    expect(verified.break).toEqual({ kind: "missing_record", atSeq: 1, recordId: first!.id });
    expect(verified.prunedRecords).toBe(0);
  });

  it("REGRESSION (#9489): a verify landing between the record INSERT and its ledger append reports ok -- an in-flight write is not a tamper signal", async () => {
    const env = createTestEnv();
    await persistAt(env, 1, daysAgo(1)); // an established, chained tip to reconcile against
    // The in-flight state: record row present (created JUST now, inside the grace window), no ledger row yet.
    await env.DB.prepare("INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at) SELECT 'in-flight', repo_full_name, 99, head_sha, action, reason_code, record_digest, record_json, ? FROM decision_records LIMIT 1")
      .bind(new Date().toISOString())
      .run();

    const verified = await verifyDecisionLedger(env);

    expect(verified.ok).toBe(true);
    expect(verified.break).toBeUndefined();
  });

  it("INVARIANT (#9489): past the grace window the same unchained record IS reported -- the grace bounds the blind spot, it does not remove the check", async () => {
    const env = createTestEnv();
    await persistAt(env, 1, daysAgo(2));
    // An orphan NEWER than the verified tail but well past the 5-minute grace: the truncated-tail signature.
    await env.DB.prepare("INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at) SELECT 'stale-orphan', repo_full_name, 99, head_sha, action, reason_code, record_digest, record_json, ? FROM decision_records LIMIT 1")
      .bind(daysAgo(1).toISOString())
      .run();

    const verified = await verifyDecisionLedger(env);

    expect(verified.ok).toBe(false);
    expect(verified.break).toEqual({ kind: "short_tail", atSeq: 1 });
  });

  it("REGRESSION (#9489): an INTERIOR orphan -- a failed append with newer rows chained cleanly after it -- is unchained_record, no longer invisible forever", async () => {
    const env = createTestEnv();
    await persistAt(env, 1, daysAgo(3));
    await persistAt(env, 3, daysAgo(1)); // the newer, cleanly chained row that used to hide the orphan
    // The failed-append signature: a record BETWEEN them (created_at behind the verified tail) with no chain row.
    await env.DB.prepare("INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at) SELECT 'interior-orphan', repo_full_name, 99, head_sha, action, reason_code, record_digest, record_json, ? FROM decision_records LIMIT 1")
      .bind(daysAgo(2).toISOString())
      .run();

    const verified = await verifyDecisionLedger(env);

    expect(verified.ok).toBe(false);
    expect(verified.break).toEqual({ kind: "unchained_record", atSeq: 2, recordId: "interior-orphan" });
  });

  it("INVARIANT: a fully healthy chain reports prunedRecords 0 and no break -- both new mechanisms are inert when nothing is absent", async () => {
    const env = createTestEnv();
    await persistAt(env, 1, daysAgo(2));
    await persistAt(env, 2, daysAgo(1));

    const verified = await verifyDecisionLedger(env);

    expect(verified).toMatchObject({ ok: true, checked: 2, prunedRecords: 0 });
    expect(verified.break).toBeUndefined();
  });
});

// #9850: a content mismatch used to ABORT verification, so one unreconcilable row was a denial-of-
// verification for every row after it. Found live: 83 rows (seq 5-257) left by the record-overwriting UPDATE
// that #9123 replaced, with verification stopping at seq 5 and never examining the remaining 1,649 rows --
// real tampering at seq 900 would have been invisible behind permanent historical damage at seq 5.
describe("content mismatches do not mask later rows (#9850)", () => {
  const seedChained = async (env: Env, count: number) => {
    for (let i = 1; i <= count; i += 1) {
      const { record, recordDigest } = await buildDecisionRecord(recordInput({ pullNumber: i }));
      await persistDecisionRecord(env, record, recordDigest);
    }
  };
  /** Rewrite one record's stored body so its digest no longer matches what the chain committed to -- exactly
   *  the state the pre-#9123 UPDATE left behind. */
  const corruptRecordAt = async (env: Env, seq: number) => {
    const row = await env.DB.prepare("SELECT record_id AS recordId FROM decision_ledger WHERE seq = ?").bind(seq).first<{ recordId: string }>();
    await env.DB.prepare("UPDATE decision_records SET record_json = ? WHERE id = ?").bind('{"tampered":true}', row!.recordId).run();
  };

  it("REGRESSION: keeps verifying past a content mismatch instead of stopping at it", async () => {
    const env = createTestEnv();
    await seedChained(env, 6);
    await corruptRecordAt(env, 2);

    const verified = await verifyDecisionLedger(env);

    expect(verified.ok).toBe(false);
    expect(verified.break).toMatchObject({ kind: "content_mismatch", atSeq: 2 });
    // The whole window was examined, not just the two rows before the break.
    expect(verified.checked).toBe(6);
  });

  it("REGRESSION: a STRUCTURAL break after a content mismatch is still found -- it used to be unreachable", async () => {
    // This is the security consequence, not just a cosmetic one: a historical unreconcilable row at seq 2 hid
    // a genuinely broken chain further along.
    const env = createTestEnv();
    await seedChained(env, 6);
    await corruptRecordAt(env, 2);
    await env.DB.prepare("UPDATE decision_ledger SET row_hash = ? WHERE seq = 5").bind("f".repeat(64)).run();

    const verified = await verifyDecisionLedger(env);

    // The structural break wins the `break` slot: everything after it is unverifiable, so it is the more
    // serious finding and the scan stops there.
    expect(verified.break).toMatchObject({ kind: "row_hash_mismatch", atSeq: 5 });
    expect(verified.contentMismatches).toBe(1); // ...and the earlier content mismatch is still counted
  });

  it("counts EVERY content mismatch, not just the first", async () => {
    const env = createTestEnv();
    await seedChained(env, 6);
    for (const seq of [2, 4, 5]) await corruptRecordAt(env, seq);

    const verified = await verifyDecisionLedger(env);

    expect(verified.contentMismatches).toBe(3);
    expect(verified.break).toMatchObject({ atSeq: 2 }); // the first is still what `break` names
  });

  it("INVARIANT: the verdict is not softened -- any mismatch still means ok:false", async () => {
    const env = createTestEnv();
    await seedChained(env, 3);
    await corruptRecordAt(env, 3);
    expect((await verifyDecisionLedger(env)).ok).toBe(false);
  });

  it("reports contentMismatches: 0 on a clean chain, so the field is a fact and not only an error signal", async () => {
    const env = createTestEnv();
    await seedChained(env, 4);
    const verified = await verifyDecisionLedger(env);
    expect(verified).toMatchObject({ ok: true, contentMismatches: 0 });
  });
});

// #9850: rows whose preimage is genuinely unrecoverable -- the pre-#9123 record-overwriting UPDATE -- can
// never be reconciled. Rewriting them to match would be the tampering this ledger exists to detect, so the
// only honest options are to fail forever or to DECLARE the damage. These pin that the declaration is a
// disclosure and not a blanket exemption.
describe("parseLedgerContentWaiver (#9850)", () => {
  it("parses a bounded range with a reason", () => {
    expect(parseLedgerContentWaiver("5-257:pre-9123 record overwrite")).toEqual({ fromSeq: 5, toSeq: 257, reason: "pre-9123 record overwrite" });
  });

  it("tolerates surrounding whitespace in the range", () => {
    expect(parseLedgerContentWaiver(" 5 - 257 : why ")).toMatchObject({ fromSeq: 5, toSeq: 257, reason: "why" });
  });

  it("REQUIRES a reason -- you cannot waive silently", () => {
    expect(parseLedgerContentWaiver("5-257:")).toBeNull();
    expect(parseLedgerContentWaiver("5-257:   ")).toBeNull();
    expect(parseLedgerContentWaiver("5-257")).toBeNull();
  });

  it("REQUIRES both bounds -- an open-ended waiver is a blanket exemption wearing a range's clothes", () => {
    for (const bad of ["5-:r", "-257:r", "5:r", "-:r"]) expect(parseLedgerContentWaiver(bad)).toBeNull();
  });

  it("rejects a descending or zero-based range, which is a mistake rather than an intent", () => {
    expect(parseLedgerContentWaiver("257-5:r")).toBeNull();
    expect(parseLedgerContentWaiver("0-10:r")).toBeNull();
  });

  it("fails CLOSED on anything malformed, so a typo can never widen an exclusion", () => {
    for (const bad of [undefined, "", "   ", "all:r", "5..257:r", "1e3-2e3:r", "-5--1:r"]) {
      expect(parseLedgerContentWaiver(bad)).toBeNull();
    }
  });
});

describe("content waiver applied by verifyDecisionLedger (#9850)", () => {
  const seedChained = async (env: Env, count: number) => {
    for (let i = 1; i <= count; i += 1) {
      const { record, recordDigest } = await buildDecisionRecord(recordInput({ pullNumber: i }));
      await persistDecisionRecord(env, record, recordDigest);
    }
  };
  const corruptRecordAt = async (env: Env, seq: number) => {
    const row = await env.DB.prepare("SELECT record_id AS recordId FROM decision_ledger WHERE seq = ?").bind(seq).first<{ recordId: string }>();
    await env.DB.prepare("UPDATE decision_records SET record_json = ? WHERE id = ?").bind('{"tampered":true}', row!.recordId).run();
  };

  it("reports ok:true with the mismatch counted SEPARATELY when it falls inside the declared range", async () => {
    const env = createTestEnv({ LOOPOVER_LEDGER_CONTENT_WAIVER: "2-3:pre-9123 record overwrite" });
    await seedChained(env, 5);
    await corruptRecordAt(env, 2);

    const verified = await verifyDecisionLedger(env);

    expect(verified.ok).toBe(true);
    expect(verified.waivedContentMismatches).toBe(1);
    expect(verified.contentMismatches).toBe(0); // never folded together -- "excused" must not read as "fine"
    expect(verified.contentWaiver).toEqual({ fromSeq: 2, toSeq: 3, reason: "pre-9123 record overwrite" });
    expect(verified.break).toBeUndefined();
  });

  it("INVARIANT: a mismatch OUTSIDE the range still fails, so the waiver is bounded in practice not just on paper", async () => {
    const env = createTestEnv({ LOOPOVER_LEDGER_CONTENT_WAIVER: "2-3:declared" });
    await seedChained(env, 6);
    await corruptRecordAt(env, 2); // inside
    await corruptRecordAt(env, 5); // outside

    const verified = await verifyDecisionLedger(env);

    expect(verified.ok).toBe(false);
    expect(verified.break).toMatchObject({ kind: "content_mismatch", atSeq: 5 });
    expect(verified.waivedContentMismatches).toBe(1);
    expect(verified.contentMismatches).toBe(1);
  });

  it("INVARIANT: a waiver NEVER excuses a structural break inside its own range", async () => {
    // The whole safety argument: the content check runs only after sequence/predecessor/row_hash pass, so a
    // waived row still has to be chained correctly. Tampering with a waived row's CHAIN position must fail.
    const env = createTestEnv({ LOOPOVER_LEDGER_CONTENT_WAIVER: "1-99:declared" });
    await seedChained(env, 5);
    await env.DB.prepare("UPDATE decision_ledger SET row_hash = ? WHERE seq = 3").bind("f".repeat(64)).run();

    const verified = await verifyDecisionLedger(env);

    expect(verified.ok).toBe(false);
    expect(verified.break).toMatchObject({ kind: "row_hash_mismatch", atSeq: 3 });
  });

  it("waives nothing when the value is malformed -- fail closed, and the failure is still reported", async () => {
    const env = createTestEnv({ LOOPOVER_LEDGER_CONTENT_WAIVER: "not-a-range" });
    await seedChained(env, 4);
    await corruptRecordAt(env, 2);

    const verified = await verifyDecisionLedger(env);

    expect(verified.ok).toBe(false);
    expect(verified.contentWaiver).toBeNull();
    expect(verified.waivedContentMismatches).toBe(0);
    expect(verified.contentMismatches).toBe(1);
  });

  it("publishes the waiver on a CLEAN chain too, so the declaration is visible without needing a failure to reveal it", async () => {
    const env = createTestEnv({ LOOPOVER_LEDGER_CONTENT_WAIVER: "2-3:declared" });
    await seedChained(env, 4);
    const verified = await verifyDecisionLedger(env);
    expect(verified).toMatchObject({ ok: true, waivedContentMismatches: 0, contentWaiver: { fromSeq: 2, toSeq: 3 } });
  });
});

// #9742: a verdict's integrity was provable, its UNIQUENESS was not -- nothing distinguished "evaluated
// once" from "evaluated three times and one result was kept". The enforcement lives at the ledger-write
// layer so no caller can bypass it by writing the row itself.
describe("verdict immutability per head SHA (#9742)", () => {
  const target = (over: Record<string, unknown> = {}) => recordInput({ action: "merge", reasonCode: "success", ...over } as never);

  it("REFUSES a repeat evaluation of the same head SHA that does not say why", async () => {
    const env = createTestEnv();
    const first = await buildDecisionRecord(target({ decidedAt: "2026-07-29T00:00:00Z" }));
    await persistDecisionRecord(env, first.record, first.recordDigest);

    const repeat = await buildDecisionRecord(target({ action: "close", decidedAt: "2026-07-29T01:00:00Z" }));
    await expect(persistDecisionRecord(env, repeat.record, repeat.recordDigest)).rejects.toThrow(UndeclaredReevaluationError);
    // And nothing was written: a refused re-evaluation must not leave a partial row behind.
    const rows = (await env.DB.prepare("SELECT id FROM decision_records").all<{ id: string }>()).results!;
    expect(rows).toHaveLength(1);
  });

  it("rejects a reason outside the closed set, so the dimension cannot be widened by free text", async () => {
    const env = createTestEnv();
    const first = await buildDecisionRecord(target({ decidedAt: "2026-07-29T00:00:00Z" }));
    await persistDecisionRecord(env, first.record, first.recordDigest);
    const repeat = await buildDecisionRecord(target({ action: "close", decidedAt: "2026-07-29T01:00:00Z" }));
    await expect(
      persistDecisionRecord(env, repeat.record, repeat.recordDigest, 3, { reason: "because i said so" as never }),
    ).rejects.toThrow(UndeclaredReevaluationError);
  });

  it("records a reason-coded re-run as a LINKED chain: both retained, the later naming what it supersedes", async () => {
    const env = createTestEnv();
    const first = await buildDecisionRecord(target({ decidedAt: "2026-07-29T00:00:00Z" }));
    const firstId = await persistDecisionRecord(env, first.record, first.recordDigest);
    const second = await buildDecisionRecord(target({ action: "close", decidedAt: "2026-07-29T01:00:00Z" }));
    const secondId = await persistDecisionRecord(env, second.record, second.recordDigest, 3, { reason: "pipeline_error" });

    const rows = (
      await env.DB.prepare(
        "SELECT id, reevaluation_reason AS reason, supersedes_record_id AS supersedes FROM decision_records ORDER BY id",
      ).all<{ id: string; reason: string | null; supersedes: string | null }>()
    ).results!;
    expect(rows).toHaveLength(2);
    // The FIRST evaluation carries neither -- it superseded nothing and needed no reason.
    expect(rows.find((row) => row.id === firstId)).toMatchObject({ reason: null, supersedes: null });
    expect(rows.find((row) => row.id === secondId)).toMatchObject({ reason: "pipeline_error", supersedes: firstId });
  });

  it("chains a THIRD evaluation to the second, not back to the first", async () => {
    const env = createTestEnv();
    const first = await buildDecisionRecord(target({ decidedAt: "2026-07-29T00:00:00Z" }));
    await persistDecisionRecord(env, first.record, first.recordDigest);
    const second = await buildDecisionRecord(target({ action: "close", decidedAt: "2026-07-29T01:00:00Z" }));
    const secondId = await persistDecisionRecord(env, second.record, second.recordDigest, 3, { reason: "pipeline_error" });
    const third = await buildDecisionRecord(target({ action: "hold", decidedAt: "2026-07-29T02:00:00Z" }));
    const thirdId = await persistDecisionRecord(env, third.record, third.recordDigest, 3, { reason: "config_change" });

    const row = await env.DB.prepare("SELECT supersedes_record_id AS supersedes FROM decision_records WHERE id = ?")
      .bind(thirdId)
      .first<{ supersedes: string }>();
    expect(row?.supersedes).toBe(secondId);
  });

  it("honours an explicitly-named superseded record over the derived one", async () => {
    const env = createTestEnv();
    const first = await buildDecisionRecord(target({ decidedAt: "2026-07-29T00:00:00Z" }));
    const firstId = await persistDecisionRecord(env, first.record, first.recordDigest);
    const second = await buildDecisionRecord(target({ action: "close", decidedAt: "2026-07-29T01:00:00Z" }));
    await persistDecisionRecord(env, second.record, second.recordDigest, 3, { reason: "maintainer_request" });
    const third = await buildDecisionRecord(target({ action: "hold", decidedAt: "2026-07-29T02:00:00Z" }));
    const thirdId = await persistDecisionRecord(env, third.record, third.recordDigest, 3, {
      reason: "upstream_state_change",
      supersedesRecordId: firstId!,
    });

    const row = await env.DB.prepare("SELECT supersedes_record_id AS supersedes FROM decision_records WHERE id = ?")
      .bind(thirdId)
      .first<{ supersedes: string }>();
    expect(row?.supersedes).toBe(firstId);
  });

  it("leaves a NEW head SHA completely unaffected — that is a fresh verdict, not a re-evaluation", async () => {
    const env = createTestEnv();
    const first = await buildDecisionRecord(target({ decidedAt: "2026-07-29T00:00:00Z" }));
    await persistDecisionRecord(env, first.record, first.recordDigest);
    // A force-push moves the head; no reason code is required or recorded.
    const pushed = await buildDecisionRecord(target({ headSha: "def5678abc", decidedAt: "2026-07-29T01:00:00Z" }));
    const pushedId = await persistDecisionRecord(env, pushed.record, pushed.recordDigest);
    expect(pushedId).toBe("record:o/r#7@def5678abc");

    const row = await env.DB.prepare("SELECT reevaluation_reason AS reason, supersedes_record_id AS supersedes FROM decision_records WHERE id = ?")
      .bind(pushedId)
      .first<{ reason: string | null; supersedes: string | null }>();
    expect(row).toMatchObject({ reason: null, supersedes: null });
  });

  it("keeps the reason vocabulary closed and machine-readable", async () => {
    // The point of recording it is that an outsider can count re-evaluations BY CAUSE without interpreting
    // prose, so the set is closed and each member is a code rather than a sentence.
    expect(REEVALUATION_REASONS).toContain("pipeline_error");
    expect(REEVALUATION_REASONS).toContain("config_change");
    for (const reason of REEVALUATION_REASONS) expect(reason).toMatch(/^[a-z][a-z_]*$/);
    expect(isReevaluationReason("pipeline_error")).toBe(true);
    expect(isReevaluationReason("nope")).toBe(false);
    expect(isReevaluationReason(undefined)).toBe(false);
  });

  it("records WHO asked, when a person did, and nothing when a schedule did", async () => {
    const env = createTestEnv();
    const first = await buildDecisionRecord(target({ decidedAt: "2026-07-29T00:00:00Z" }));
    await persistDecisionRecord(env, first.record, first.recordDigest);

    const second = await buildDecisionRecord(target({ decidedAt: "2026-07-29T00:05:00Z" }));
    await persistDecisionRecord(env, second.record, second.recordDigest, 3, {
      reason: "maintainer_request",
      actor: "  JSONbored  ",
    });
    const third = await buildDecisionRecord(target({ decidedAt: "2026-07-29T00:10:00Z" }));
    await persistDecisionRecord(env, third.record, third.recordDigest, 3, { reason: "scheduled_recheck" });

    const rows = await env.DB.prepare(
      "SELECT reevaluation_actor AS actor FROM decision_records WHERE reevaluation_reason IS NOT NULL ORDER BY created_at",
    ).all<{ actor: string | null }>();
    // Trimmed, and a machine-paced cause never invents a "system" actor to sit beside a real name.
    expect(rows.results.map((row) => row.actor)).toEqual(["JSONbored", null]);
  });

  it("treats a blank or absent actor as no actor rather than as an empty name", async () => {
    const env = createTestEnv();
    const first = await buildDecisionRecord(target({ decidedAt: "2026-07-29T00:00:00Z" }));
    await persistDecisionRecord(env, first.record, first.recordDigest);
    const second = await buildDecisionRecord(target({ decidedAt: "2026-07-29T00:05:00Z" }));
    const id = await persistDecisionRecord(env, second.record, second.recordDigest, 3, {
      reason: "maintainer_request",
      actor: "   ",
    });

    const row = await env.DB.prepare("SELECT reevaluation_actor AS actor FROM decision_records WHERE id = ?")
      .bind(id)
      .first<{ actor: string | null }>();
    expect(row?.actor).toBeNull();
  });
});

// The cause is DERIVED from the job's delivery id rather than judged at each call site (#9742) -- these
// pin the mapping that makes that mechanical.
describe("deriveReevaluationReason", () => {
  it("names the routine scheduled sweep as such", () => {
    // By volume this is the dominant cause. If it were not its own reason, every sweep tick past the
    // first would have to borrow one of the incident-shaped codes and drown them.
    expect(deriveReevaluationReason(deliveryIdFor("regateSweep", "o/r#7"))).toBe("scheduled_recheck");
  });

  it("treats a repair fan-out as a pipeline error, not routine", () => {
    for (const origin of ["regateRepair", "backlogConvergence", "reconcile", "surfaceWithoutDisposition"] as const) {
      expect(deriveReevaluationReason(deliveryIdFor(origin, "o/r#7")), origin).toBe("pipeline_error");
    }
  });

  it("attributes an operator-driven re-gate to a maintainer request", () => {
    expect(deriveReevaluationReason(deliveryIdFor("manualRegate", "uuid"))).toBe("maintainer_request");
    expect(deriveReevaluationReason(deliveryIdFor("panelRetriggerRecovery", "o/r#7"))).toBe("maintainer_request");
  });

  it("reads a RAW GitHub delivery id as external state having moved", () => {
    // No synthetic prefix means a real event on the PR -- CI settling, a label changing, a sibling merging.
    expect(deriveReevaluationReason("f7a1c4e0-1234-4321-9876-0badc0ffee00")).toBe("upstream_state_change");
    expect(deriveReevaluationReason(null)).toBe("upstream_state_change");
    expect(deriveReevaluationReason(undefined)).toBe("upstream_state_change");
    expect(deriveReevaluationReason("")).toBe("upstream_state_change");
  });

  it("assigns a reason to EVERY origin, and only valid ones", () => {
    // The map is `Record<DeliveryIdOrigin, ReevaluationReason>`, so a new prefix without a reason is a
    // build failure -- this asserts the runtime side of that same guarantee.
    for (const origin of DELIVERY_ID_ORIGINS) {
      const reason = REEVALUATION_REASON_BY_ORIGIN[origin];
      expect(isReevaluationReason(reason), origin).toBe(true);
      expect(deriveReevaluationReason(deliveryIdFor(origin, "o/r#7")), origin).toBe(reason);
    }
    expect(DELIVERY_ID_ORIGINS.length).toBeGreaterThan(0);
  });

  it("keeps every origin distinguishable: no prefix may be a prefix of another", () => {
    // This is what makes a first-match scan unambiguous. If it ever fails, two producers have become
    // indistinguishable and one would silently inherit the other's reason -- `regate-sweep:` read as
    // `regate-repair:` would file a repair as routine maintenance, the exact distinction this preserves.
    for (const a of DELIVERY_ID_ORIGINS) {
      for (const b of DELIVERY_ID_ORIGINS) {
        if (a === b) continue;
        expect(DELIVERY_ID_PREFIXES[a].startsWith(DELIVERY_ID_PREFIXES[b]), `${a} vs ${b}`).toBe(false);
      }
    }
    expect(deliveryIdOrigin(deliveryIdFor("regateRepair", "o/r#7"))).toBe("regateRepair");
    expect(deliveryIdOrigin(deliveryIdFor("regateSweep", "o/r#7"))).toBe("regateSweep");
    expect(deliveryIdOrigin("not-a-known-prefix:o/r#7")).toBeNull();
    expect(deliveryIdOrigin(null)).toBeNull();
  });
});
