import { describe, expect, it } from "vitest";
import { createTestEnv } from "../helpers/d1";
import { loadLastLedgerAnchorAttempt, loadPublicLedgerAnchors, recordLedgerAnchorAttempt, type LedgerAnchorAttemptInput , anchorBackendsMissingForRowHash } from "../../src/review/ledger-anchor-persistence";
import { buildLedgerAnchorPayload } from "../../src/review/ledger-anchor";

// #9271 (epic #9267). The load-bearing property here is that a FAILURE is recorded and served exactly like a
// success -- no special-casing that could hide it, per the mechanism research on #9267.

function okAttempt(overrides: Partial<LedgerAnchorAttemptInput & { status: "ok" }> = {}): LedgerAnchorAttemptInput {
  return {
    payload: buildLedgerAnchorPayload({ seq: 1, rowHash: "a".repeat(64), totalCount: 1 }, "2026-07-27T12:00:00.000Z"),
    signature: "c2ln",
    keyId: "key1",
    backend: "rekor",
    status: "ok",
    backendRef: { shardBaseUrl: "https://log2026-1.rekor.sigstore.dev", logIndex: 42, logIdKeyId: "kid", uuid: "uuid-1" },
    proofR2Key: "anchors/rekor/1.json",
    ...overrides,
  };
}

function failedAttempt(overrides: Partial<LedgerAnchorAttemptInput & { status: "failed" }> = {}): LedgerAnchorAttemptInput {
  return {
    payload: buildLedgerAnchorPayload({ seq: 2, rowHash: "b".repeat(64), totalCount: 2 }, "2026-07-27T12:05:00.000Z"),
    signature: "c2ln",
    keyId: "key1",
    backend: "git",
    status: "failed",
    error: new Error("rate limited"),
    ...overrides,
  };
}

describe("recordLedgerAnchorAttempt / loadPublicLedgerAnchors (#9271)", () => {
  it("records a successful attempt with its backend reference and proof key", async () => {
    const env = createTestEnv();
    await recordLedgerAnchorAttempt(env, okAttempt());

    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      seq: 1,
      rowHash: "a".repeat(64),
      keyId: "key1",
      backend: "rekor",
      status: "ok",
      error: null,
      backendRef: { shardBaseUrl: "https://log2026-1.rekor.sigstore.dev", logIndex: 42, logIdKeyId: "kid", uuid: "uuid-1" },
    });
  });

  it("records a FAILED attempt with the SAME shape as success — not filtered out, not hidden", async () => {
    const env = createTestEnv();
    await recordLedgerAnchorAttempt(env, failedAttempt());

    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ seq: 2, backend: "git", status: "failed", error: "rate limited", backendRef: null });
    // Same field set on a failure as on a success — no special-cased shape that could hide it.
    expect(Object.keys(anchors[0]!).sort()).toEqual(["backend", "backendRef", "createdAt", "error", "id", "keyId", "rowHash", "seq", "status"]);
  });

  it("a failed attempt is queryable identically to a success — filtering by backend returns both statuses", async () => {
    const env = createTestEnv();
    await recordLedgerAnchorAttempt(env, okAttempt({ backend: "git", payload: buildLedgerAnchorPayload({ seq: 3, rowHash: "c".repeat(64), totalCount: 3 }, "2026-07-27T12:10:00.000Z") }));
    await recordLedgerAnchorAttempt(env, failedAttempt({ backend: "git" }));

    const { anchors } = await loadPublicLedgerAnchors(env, { backend: "git" });
    expect(anchors.map((a) => a.status).sort()).toEqual(["failed", "ok"]);
  });

  it("filters by backend", async () => {
    const env = createTestEnv();
    await recordLedgerAnchorAttempt(env, okAttempt({ backend: "rekor" }));
    await recordLedgerAnchorAttempt(env, failedAttempt({ backend: "git" }));

    expect((await loadPublicLedgerAnchors(env, { backend: "rekor" })).anchors).toHaveLength(1);
    expect((await loadPublicLedgerAnchors(env, { backend: "ots" })).anchors).toHaveLength(0);
  });

  it("paginates newest-first with a nextBefore cursor, and the cursor actually advances the page", async () => {
    const env = createTestEnv();
    // createdAt (the row's OWN recorded time) is passed explicitly and distinctly per row -- several inserts
    // in a tight loop would otherwise race real wall-clock resolution and could land on the same millisecond.
    for (let i = 1; i <= 5; i += 1) {
      await recordLedgerAnchorAttempt(
        env,
        okAttempt({ payload: buildLedgerAnchorPayload({ seq: i, rowHash: `${i}`.repeat(64).slice(0, 64), totalCount: i }, `2026-07-27T12:0${i}:00.000Z`) }),
        `2026-07-27T12:0${i}:00.000Z`,
      );
    }

    const first = await loadPublicLedgerAnchors(env, { limit: 2 });
    expect(first.anchors.map((a) => a.seq)).toEqual([5, 4]); // newest first
    expect(first.nextBefore).not.toBeNull();

    const second = await loadPublicLedgerAnchors(env, { limit: 2, before: first.nextBefore! });
    expect(second.anchors.map((a) => a.seq)).toEqual([3, 2]);
    expect(second.nextBefore).not.toBeNull();

    const third = await loadPublicLedgerAnchors(env, { limit: 2, before: second.nextBefore! });
    expect(third.anchors.map((a) => a.seq)).toEqual([1]);
    expect(third.nextBefore).toBeNull(); // no more pages
  });

  it("clamps limit to [1, 200] rather than trusting caller input", async () => {
    const env = createTestEnv();
    await recordLedgerAnchorAttempt(env, okAttempt());
    expect((await loadPublicLedgerAnchors(env, { limit: 0 })).anchors).toHaveLength(1); // clamped up to 1
    expect((await loadPublicLedgerAnchors(env, { limit: -5 })).anchors).toHaveLength(1);
  });

  it("degrades an unparseable backendRef to null rather than throwing a public endpoint", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO decision_ledger_anchors (id, seq, row_hash, payload_json, signature, key_id, backend, backend_ref, proof_r2_key, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind("manual-1", 9, "d".repeat(64), "{}", "sig", "key1", "rekor", "{not valid json", null, "ok", null, "2026-07-27T12:00:00.000Z")
      .run();

    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors[0]?.backendRef).toBeNull();
  });

  it("returns an empty list with no nextBefore on a fresh ledger", async () => {
    const { anchors, nextBefore } = await loadPublicLedgerAnchors(createTestEnv());
    expect(anchors).toEqual([]);
    expect(nextBefore).toBeNull();
  });
});

describe("loadLastLedgerAnchorAttempt (#9274)", () => {
  it("returns null when nothing has ever been recorded", async () => {
    expect(await loadLastLedgerAnchorAttempt(createTestEnv())).toBeNull();
  });

  it("returns the most recent attempt's seq/rowHash, regardless of backend or status -- what the scheduler compares the live tip against", async () => {
    const env = createTestEnv();
    await recordLedgerAnchorAttempt(
      env,
      { payload: buildLedgerAnchorPayload({ seq: 1, rowHash: "a".repeat(64), totalCount: 1 }, "2026-07-27T12:00:00.000Z"), signature: "s", keyId: "k", backend: "rekor", status: "ok", backendRef: {}, proofR2Key: null },
      "2026-07-27T12:00:00.000Z",
    );
    // A LATER, FAILED git attempt still becomes "the last attempt" -- this is deliberately not "last success".
    await recordLedgerAnchorAttempt(
      env,
      { payload: buildLedgerAnchorPayload({ seq: 2, rowHash: "b".repeat(64), totalCount: 2 }, "2026-07-27T12:05:00.000Z"), signature: "s", keyId: "k", backend: "git", status: "failed", error: "boom" },
      "2026-07-27T12:05:00.000Z",
    );
    expect(await loadLastLedgerAnchorAttempt(env)).toEqual({ seq: 2, rowHash: "b".repeat(64) });
  });
});

// #9489: "is this tip anchored" must be asked PER BACKEND against the exact rowHash. Asking only "what was the
// newest attempt" meant a failure at a quiet tip was never retried, and one backend's success masked another's
// failure because the newest row won regardless of which backend wrote it.
describe("anchorBackendsMissingForRowHash (#9489)", () => {
  const record = (env: Env, rowHash: string, backend: string, status: "ok" | "failed") =>
    env.DB.prepare(
      "INSERT INTO decision_ledger_anchors (id, seq, row_hash, payload_json, signature, key_id, backend, status, created_at) VALUES (?, 1, ?, '{}', 'sig', 'k1', ?, ?, ?)",
    )
      .bind(`${backend}-${status}-${rowHash}-${Math.random()}`, rowHash, backend, status, new Date().toISOString())
      .run();

  it("reports a backend with NO row at all as missing", async () => {
    const env = createTestEnv();
    expect(await anchorBackendsMissingForRowHash(env, "hash-a", ["rekor", "git"])).toEqual(["rekor", "git"]);
  });

  it("REGRESSION: a FAILED attempt does not count as anchored -- otherwise it is never retried", async () => {
    const env = createTestEnv();
    await record(env, "hash-a", "rekor", "failed");
    expect(await anchorBackendsMissingForRowHash(env, "hash-a", ["rekor"])).toEqual(["rekor"]);
  });

  it("REGRESSION: one backend's success does not mask another's failure", async () => {
    const env = createTestEnv();
    await record(env, "hash-a", "git", "ok");
    await record(env, "hash-a", "rekor", "failed");
    expect(await anchorBackendsMissingForRowHash(env, "hash-a", ["rekor", "git"])).toEqual(["rekor"]);
  });

  it("INVARIANT: a fully anchored tip reports nothing missing", async () => {
    const env = createTestEnv();
    await record(env, "hash-a", "git", "ok");
    await record(env, "hash-a", "rekor", "ok");
    expect(await anchorBackendsMissingForRowHash(env, "hash-a", ["rekor", "git"])).toEqual([]);
  });

  it("INVARIANT: a success at a DIFFERENT rowHash does not anchor this tip", async () => {
    // The whole point is per-tip, not per-ledger: an older anchored checkpoint says nothing about the tip.
    const env = createTestEnv();
    await record(env, "hash-old", "rekor", "ok");
    expect(await anchorBackendsMissingForRowHash(env, "hash-new", ["rekor"])).toEqual(["rekor"]);
  });

  it("short-circuits on an empty backend list without querying", async () => {
    const env = createTestEnv();
    const spy = vi.spyOn(env.DB, "prepare");
    expect(await anchorBackendsMissingForRowHash(env, "hash-a", [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
