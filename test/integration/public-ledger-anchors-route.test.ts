import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";
import { recordLedgerAnchorAttempt } from "../../src/review/ledger-anchor-persistence";
import { buildLedgerAnchorPayload } from "../../src/review/ledger-anchor";
import { buildDecisionRecord, contentDigest, persistDecisionRecord } from "../../src/review/decision-record";

// #9271 (epic #9267). The load-bearing behaviour: a failed attempt is served on this public listing exactly
// like a success, since that's the entire point of recording failures at all.

describe("GET /v1/public/decision-ledger/anchors (#9271)", () => {
  it("answers 200 with no Authorization header", async () => {
    const env = createTestEnv();
    const response = await createApp().request("/v1/public/decision-ledger/anchors", {}, env);
    expect(response.status).toBe(200);
    // #9719: an empty list now says WHY -- a fresh env has no ledger rows, so there is nothing to anchor yet.
    expect(await response.json()).toEqual({ anchors: [], nextBefore: null, status: "empty_ledger" });
  });

  it("REGRESSION: distinguishes an unconfigured deployment from a healthy empty one", async () => {
    // Before #9719 all of "never configured", "nothing to anchor" and "healthy but not run yet" rendered as
    // {"anchors":[]} -- indistinguishable from outside, so silent misconfiguration looked like success.
    const env = createTestEnv();
    await seedLedgerRow(env);
    const response = await createApp().request("/v1/public/decision-ledger/anchors", {}, env);
    expect(await response.json()).toMatchObject({ anchors: [], status: "unconfigured" });
  });

  it("reports pending once a ledger exists AND a signing key is published", async () => {
    const env = createTestEnv();
    await seedLedgerRow(env);
    env.LOOPOVER_LEDGER_ANCHOR_KEYS = JSON.stringify([{ keyId: "k1", publicKeySpki: "c3BraQ==", notBefore: "2026-01-01T00:00:00.000Z", notAfter: null }]);
    env.LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY = "test-private-key";
    const response = await createApp().request("/v1/public/decision-ledger/anchors", {}, env);
    expect(await response.json()).toMatchObject({ anchors: [], status: "pending" });
  });

  it("is still unconfigured when a key is published but the private half is not set", async () => {
    // Both sides of the signing-key predicate: a published public key alone cannot sign anything.
    const env = createTestEnv();
    await seedLedgerRow(env);
    env.LOOPOVER_LEDGER_ANCHOR_KEYS = JSON.stringify([{ keyId: "k1", publicKeySpki: "c3BraQ==", notBefore: "2026-01-01T00:00:00.000Z", notAfter: null }]);
    const response = await createApp().request("/v1/public/decision-ledger/anchors", {}, env);
    expect(await response.json()).toMatchObject({ anchors: [], status: "unconfigured" });
  });

  it("omits status on a filtered page, where an empty result only means nothing matched", async () => {
    const env = createTestEnv();
    const body = (await (await createApp().request("/v1/public/decision-ledger/anchors?backend=rekor", {}, env)).json()) as Record<string, unknown>;
    expect(body).toEqual({ anchors: [], nextBefore: null });
    expect("status" in body).toBe(false);
  });

  it("serves a FAILED anchor attempt on the public listing, identically shaped to a success", async () => {
    const env = createTestEnv();
    await recordLedgerAnchorAttempt(
      env,
      {
        payload: buildLedgerAnchorPayload({ seq: 7, rowHash: "e".repeat(64), totalCount: 7 }, "2026-07-27T12:00:00.000Z"),
        signature: "c2ln",
        keyId: "key1",
        backend: "git",
        status: "failed",
        error: new Error("rate limited by the git remote"),
      },
      "2026-07-27T12:00:00.000Z",
    );

    const response = await createApp().request("/v1/public/decision-ledger/anchors", {}, env);
    const body = (await response.json()) as { anchors: Array<Record<string, unknown>>; nextBefore: string | null };
    expect(body.anchors).toHaveLength(1);
    expect(body.anchors[0]).toMatchObject({ seq: 7, backend: "git", status: "failed", error: "rate limited by the git remote" });
  });

  it("filters by ?backend=", async () => {
    const env = createTestEnv();
    await recordLedgerAnchorAttempt(
      env,
      { payload: buildLedgerAnchorPayload({ seq: 1, rowHash: "a".repeat(64), totalCount: 1 }, "2026-07-27T12:00:00.000Z"), signature: "s", keyId: "k", backend: "rekor", status: "ok", backendRef: {}, proofR2Key: null },
      "2026-07-27T12:00:00.000Z",
    );
    await recordLedgerAnchorAttempt(
      env,
      { payload: buildLedgerAnchorPayload({ seq: 2, rowHash: "b".repeat(64), totalCount: 2 }, "2026-07-27T12:01:00.000Z"), signature: "s", keyId: "k", backend: "git", status: "ok", backendRef: {}, proofR2Key: null },
      "2026-07-27T12:01:00.000Z",
    );

    const response = await createApp().request("/v1/public/decision-ledger/anchors?backend=rekor", {}, env);
    const body = (await response.json()) as { anchors: Array<{ backend: string }> };
    expect(body.anchors.map((a) => a.backend)).toEqual(["rekor"]);
  });

  it("ignores an invalid ?backend= value rather than erroring (falls back to unfiltered)", async () => {
    const env = createTestEnv();
    await recordLedgerAnchorAttempt(
      env,
      { payload: buildLedgerAnchorPayload({ seq: 1, rowHash: "a".repeat(64), totalCount: 1 }, "2026-07-27T12:00:00.000Z"), signature: "s", keyId: "k", backend: "rekor", status: "ok", backendRef: {}, proofR2Key: null },
      "2026-07-27T12:00:00.000Z",
    );
    const response = await createApp().request("/v1/public/decision-ledger/anchors?backend=nonsense", {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { anchors: unknown[] };
    expect(body.anchors).toHaveLength(1);
  });

  it("supports pagination via ?limit= and ?before=", async () => {
    const env = createTestEnv();
    for (let i = 1; i <= 3; i += 1) {
      await recordLedgerAnchorAttempt(
        env,
        { payload: buildLedgerAnchorPayload({ seq: i, rowHash: `${i}`.repeat(64).slice(0, 64), totalCount: i }, `2026-07-27T12:0${i}:00.000Z`), signature: "s", keyId: "k", backend: "rekor", status: "ok", backendRef: {}, proofR2Key: null },
        `2026-07-27T12:0${i}:00.000Z`,
      );
    }
    const first = await createApp().request("/v1/public/decision-ledger/anchors?limit=2", {}, env);
    const firstBody = (await first.json()) as { anchors: Array<{ seq: number }>; nextBefore: string };
    expect(firstBody.anchors.map((a) => a.seq)).toEqual([3, 2]);

    const second = await createApp().request(`/v1/public/decision-ledger/anchors?limit=2&before=${encodeURIComponent(firstBody.nextBefore)}`, {}, env);
    const secondBody = (await second.json()) as { anchors: Array<{ seq: number }>; nextBefore: string | null };
    expect(secondBody.anchors.map((a) => a.seq)).toEqual([1]);
    expect(secondBody.nextBefore).toBeNull();
  });

  it("sets the same Cache-Control posture as its public siblings", async () => {
    const response = await createApp().request("/v1/public/decision-ledger/anchors", {}, createTestEnv());
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, stale-while-revalidate=300");
  });
});

/** One persisted decision record, so the ledger tip is non-zero — mirrors ledger-anchor-scheduler.test.ts's
 *  seedOneDecision, which every scheduler case already calls for the same reason. */
async function seedLedgerRow(env: Env): Promise<void> {
  const { record, recordDigest } = await buildDecisionRecord({
    repoFullName: "acme/widgets",
    pullNumber: 1,
    headSha: "abc1",
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
