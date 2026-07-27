import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";
import {
  buildDecisionRecord,
  contentDigest,
  LEDGER_GENESIS_HASH,
  ledgerRowHash,
  persistDecisionRecord,
  type PublicLedgerRow,
} from "../../src/review/decision-record";

// #9269 (epic #9267): the row-lookup route is what BINDS an external anchor back to the live chain. These
// tests pin the property that actually matters -- a fetched row must be enough, on its own, to recompute the
// chained hash an anchor committed to -- not merely that the endpoint returns 200.

async function seedRecords(env: Env, count: number): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    const { record, recordDigest } = await buildDecisionRecord({
      repoFullName: "acme/widgets",
      pullNumber: i,
      headSha: `abc${i}`,
      baseSha: null,
      action: "merge",
      reasonCode: "gate_clean",
      configDigest: await contentDigest({ gatePack: "oss-anti-slop" }),
      gatePack: "oss-anti-slop",
      ciState: null,
      modelIds: null,
      promptDigest: null,
      aiConfidence: null,
      salvageability: null,
    });
    await persistDecisionRecord(env, record, recordDigest);
  }
}

describe("GET /v1/public/decision-ledger/row/:seq (#9269)", () => {
  it("answers 200 with no Authorization header and returns the row's chain fields verbatim", async () => {
    const env = createTestEnv();
    await seedRecords(env, 1);

    const response = await createApp().request("/v1/public/decision-ledger/row/1", {}, env);
    expect(response.status).toBe(200);
    const row = (await response.json()) as PublicLedgerRow;
    expect(row.seq).toBe(1);
    expect(row.prevHash).toBe(LEDGER_GENESIS_HASH); // first row links to genesis
    expect(row.recordId).toContain("acme/widgets#1");
    expect(row.recordDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof row.createdAt).toBe("string");
  });

  it("THE POINT (#9267): a fetched row alone lets a third party recompute the chained hash an anchor committed to", async () => {
    const env = createTestEnv();
    await seedRecords(env, 3);

    const response = await createApp().request("/v1/public/decision-ledger/row/2", {}, env);
    const row = (await response.json()) as PublicLedgerRow;

    // Exactly what an external verifier runs against an anchored (seq, rowHash) pair -- using only fields
    // this route returned, with no privileged access to anything.
    const recomputed = await ledgerRowHash(row.prevHash, {
      seq: row.seq,
      recordId: row.recordId,
      recordDigest: row.recordDigest,
      createdAt: row.createdAt,
    });
    expect(recomputed).toBe(row.rowHash);
  });

  it("row N's prevHash equals row N-1's rowHash, so anchors at different seqs chain together", async () => {
    const env = createTestEnv();
    await seedRecords(env, 3);

    const app = createApp();
    const [first, second] = (await Promise.all(
      [1, 2].map(async (seq) => (await app.request(`/v1/public/decision-ledger/row/${seq}`, {}, env)).json()),
    )) as PublicLedgerRow[];
    expect(second?.prevHash).toBe(first?.rowHash);
  });

  it("a re-chained ledger produces a DIFFERENT rowHash at an anchored seq -- the wholesale-rewrite detection this route exists for", async () => {
    const original = createTestEnv();
    await seedRecords(original, 2);
    const anchored = (await (await createApp().request("/v1/public/decision-ledger/row/2", {}, original)).json()) as PublicLedgerRow;

    // A fresh chain over DIFFERENT history — an operator deleting the ledger and starting again from genesis.
    const rechained = createTestEnv();
    await seedRecords(rechained, 1);
    const { record, recordDigest } = await buildDecisionRecord({
      repoFullName: "acme/widgets",
      pullNumber: 999, // the record at seq 2 is not the one that was anchored
      headSha: "rewritten",
      baseSha: null,
      action: "close",
      reasonCode: "policy_close:contributor_cap",
      configDigest: await contentDigest({ gatePack: "oss-anti-slop" }),
      gatePack: "oss-anti-slop",
      ciState: null,
      modelIds: null,
      promptDigest: null,
      aiConfidence: null,
      salvageability: null,
    });
    await persistDecisionRecord(rechained, record, recordDigest);

    const live = (await (await createApp().request("/v1/public/decision-ledger/row/2", {}, rechained)).json()) as PublicLedgerRow;
    expect(live.seq).toBe(anchored.seq); // same seq...
    expect(live.rowHash).not.toBe(anchored.rowHash); // ...different hash — the anchor comparison fails, publicly
  });

  it("answers 404 (not 401, not 200-with-nulls) for a seq that was never appended", async () => {
    const env = createTestEnv();
    await seedRecords(env, 1);
    const response = await createApp().request("/v1/public/decision-ledger/row/99", {}, env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("answers 400 for a non-integer, zero, or negative seq", async () => {
    const env = createTestEnv();
    const app = createApp();
    for (const seq of ["not-a-number", "0", "-1", "1.5"]) {
      const response = await app.request(`/v1/public/decision-ledger/row/${seq}`, {}, env);
      expect(response.status, `seq=${seq}`).toBe(400);
    }
  });

  it("never returns decision-record CONTENTS, only chain fields", async () => {
    const env = createTestEnv();
    await seedRecords(env, 1);
    const response = await createApp().request("/v1/public/decision-ledger/row/1", {}, env);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["createdAt", "prevHash", "recordDigest", "recordId", "rowHash", "seq"]);
    expect(JSON.stringify(body)).not.toMatch(/record_json|reasonCode|configDigest|promptDigest/);
  });

  it("sets the same Cache-Control posture as its public siblings", async () => {
    const env = createTestEnv();
    await seedRecords(env, 1);
    const response = await createApp().request("/v1/public/decision-ledger/row/1", {}, env);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, stale-while-revalidate=300");
  });
});
