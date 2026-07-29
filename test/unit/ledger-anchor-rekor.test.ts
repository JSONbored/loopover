import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import { buildHashedRekordRequest, parseRekorResponse, submitToRekor } from "../../src/review/ledger-anchor-rekor";
import { buildLedgerAnchorPayload, signLedgerAnchorPayload, type SignedLedgerAnchor } from "../../src/review/ledger-anchor";
import { loadPublicLedgerAnchors } from "../../src/review/ledger-anchor-persistence";

// #9272 (epic #9267). fetch is ALWAYS injected -- never a real network call to Rekor. The property under
// test is that this module's own request/response/persistence logic is correct; Rekor's actual API is out of
// scope for a unit test and is exercised, if at all, by hand against the real service.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function realSignedAnchor(): Promise<{ signed: SignedLedgerAnchor; publicKeySpki: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = bytesToBase64(new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer));
  const publicKeySpki = bytesToBase64(new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer));
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${(pkcs8.match(/.{1,64}/g) ?? []).join("\n")}\n-----END PRIVATE KEY-----`;
  const payload = buildLedgerAnchorPayload({ seq: 1, rowHash: "a".repeat(64), totalCount: 1 }, "2026-07-27T12:00:00.000Z");
  const signed = await signLedgerAnchorPayload(payload, privateKeyPem, "key1");
  return { signed, publicKeySpki };
}

// The real Rekor v2 TransparencyLogEntry shape: the entry DIRECTLY (no uuid-keyed wrapper), `logIndex` as a
// proto3-int64 STRING, no `uuid` field, and the checkpoint nested under inclusionProof. The old fixture here
// was the v1 shape, which is why the parser's v1 assumptions survived review -- the test agreed with the bug.
const REKOR_RESPONSE = {
  logIndex: "42",
  logId: { keyId: "c2iga0d1" },
  kindVersion: { kind: "hashedrekord", version: "0.0.2" },
  integratedTime: "0",
  inclusionPromise: null,
  inclusionProof: { logIndex: "42", rootHash: "cm9vdA==", treeSize: "43", hashes: [], checkpoint: { envelope: "log2025-1.rekor.sigstore.dev\n43\ncm9vdA==\n" } },
  canonicalizedBody: "Ym9keQ==",
};

describe("buildHashedRekordRequest (#9272)", () => {
  it("builds the exact hashedRekordRequestV002 shape Rekor v2 expects", async () => {
    const { signed, publicKeySpki } = await realSignedAnchor();
    const request = await buildHashedRekordRequest(signed, publicKeySpki);

    expect(request.hashedRekordRequestV002.signature.content).toBe(signed.signature);
    expect(request.hashedRekordRequestV002.signature.verifier.publicKey.rawBytes).toBe(publicKeySpki);
    expect(request.hashedRekordRequestV002.signature.verifier.keyDetails).toBe("PKIX_ECDSA_P256_SHA_256");
    expect(request.hashedRekordRequestV002.digest).not.toBe("");
  });

  it("is deterministic: the same signed anchor always produces the same digest", async () => {
    const { signed, publicKeySpki } = await realSignedAnchor();
    const a = await buildHashedRekordRequest(signed, publicKeySpki);
    const b = await buildHashedRekordRequest(signed, publicKeySpki);
    expect(a.hashedRekordRequestV002.digest).toBe(b.hashedRekordRequestV002.digest);
  });
});

describe("parseRekorResponse", () => {
  // #9851: this block previously asserted the v1 shape -- its own title said "reading the entry under its
  // dynamic uuid key", which was the mistaken premise, not a description of Rekor v2. Corrected rather than
  // deleted, so the change of contract is visible in history.
  it("parses a real-shaped Rekor v2 TransparencyLogEntry", () => {
    expect(parseRekorResponse(REKOR_RESPONSE)).toEqual({
      logIndex: 42,
      logId: { keyId: "c2iga0d1" },
      checkpoint: "log2025-1.rekor.sigstore.dev\n43\ncm9vdA==\n",
    });
  });

  it("returns null (never throws) for any response shape it does not recognize", () => {
    expect(parseRekorResponse(null)).toBeNull();
    expect(parseRekorResponse("a string")).toBeNull();
    expect(parseRekorResponse({})).toBeNull();
    // The old v1 wrapper is itself unrecognized now -- a log still speaking v1 must fail loudly rather than
    // half-parse into a backendRef that points nowhere.
    expect(parseRekorResponse({ "24296fb24b8ad77a": { logIndex: 42, uuid: "24296fb24b8ad77a", logId: { keyId: "c2iga0d1" } } })).toBeNull();
  });
});

describe("submitToRekor (#9272)", () => {
  it("records status:'ok' with the FULL resolvable backend_ref on a successful submission", async () => {
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_REKOR_SHARD_URL: "https://log2026-1.rekor.sigstore.dev" });
    const { signed, publicKeySpki } = await realSignedAnchor();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(REKOR_RESPONSE), { status: 201 }));

    await submitToRekor(env, signed, publicKeySpki, fetchMock);

    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      seq: 1,
      backend: "rekor",
      status: "ok",
      backendRef: { shardBaseUrl: "https://log2026-1.rekor.sigstore.dev", logIndex: 42, logIdKeyId: "c2iga0d1", checkpoint: expect.stringContaining("log2025-1.rekor.sigstore.dev") },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://log2026-1.rekor.sigstore.dev/api/v2/log/entries",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses the default shard URL when unconfigured -- pinned EXACTLY, because a shard that does not exist still matches a substring", async () => {
    // #9844: this assertion used to be `stringContaining("rekor.sigstore.dev")`, which passed happily while
    // the default pointed at log2026-1 -- a shard Sigstore never deployed. Every deployment that enabled
    // anchoring without overriding the env var recorded `fetch failed` forever and published no anchor, and
    // this test could not have caught it. The exact host is the thing under test, so it is asserted exactly.
    const env = createTestEnv();
    const { signed, publicKeySpki } = await realSignedAnchor();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(REKOR_RESPONSE), { status: 201 }));
    await submitToRekor(env, signed, publicKeySpki, fetchMock);
    expect(fetchMock).toHaveBeenCalledWith("https://log2025-1.rekor.sigstore.dev/api/v2/log/entries", expect.anything());
  });

  it("REGRESSION (#9844): a thrown fetch error records WHICH endpoint failed, not a bare 'fetch failed'", async () => {
    // Node's own message is "fetch failed" with no URL, so an operator cannot tell a shard hostname that does
    // not resolve from blocked egress from a log that is down -- three different fixes. #9271 publishes these
    // failures so anyone can see anchoring is broken; naming the endpoint is what makes that actionable.
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_REKOR_SHARD_URL: "https://log-does-not-exist.example" });
    const { signed, publicKeySpki } = await realSignedAnchor();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    await expect(submitToRekor(env, signed, publicKeySpki, fetchMock)).resolves.toBeUndefined();

    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors[0]).toMatchObject({ backend: "rekor", status: "failed" });
    expect(anchors[0]!.error).toContain("https://log-does-not-exist.example/api/v2/log/entries");
    expect(anchors[0]!.error).toContain("fetch failed"); // the original cause is still legible
  });

  it("wraps a non-Error thrown value without losing it", async () => {
    const env = createTestEnv();
    const { signed, publicKeySpki } = await realSignedAnchor();
    const fetchMock = vi.fn().mockRejectedValue("a bare string, not an Error");

    await submitToRekor(env, signed, publicKeySpki, fetchMock);

    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors[0]!.error).toContain("a bare string, not an Error");
    expect(anchors[0]!.error).toContain("log2025-1.rekor.sigstore.dev");
  });

  it("records status:'failed' on a non-2xx response, and does NOT throw", async () => {
    const env = createTestEnv();
    const { signed, publicKeySpki } = await realSignedAnchor();
    const fetchMock = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(submitToRekor(env, signed, publicKeySpki, fetchMock)).resolves.toBeUndefined();

    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors[0]).toMatchObject({ status: "failed", backend: "rekor" });
    expect(anchors[0]?.error).toContain("429");
  });

  it("records status:'failed' when the response body does not parse as a TransparencyLogEntry", async () => {
    const env = createTestEnv();
    const { signed, publicKeySpki } = await realSignedAnchor();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ unexpected: "shape" }), { status: 201 }));

    await submitToRekor(env, signed, publicKeySpki, fetchMock);

    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors[0]?.status).toBe("failed");
    expect(anchors[0]?.error).toContain("expected TransparencyLogEntry shape");
  });

  it("records status:'failed' (not a thrown error past the caller) on a network exception", async () => {
    const env = createTestEnv();
    const { signed, publicKeySpki } = await realSignedAnchor();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(submitToRekor(env, signed, publicKeySpki, fetchMock)).resolves.toBeUndefined();

    const { anchors } = await loadPublicLedgerAnchors(env);
    // #9844: the cause is still legible, now alongside the endpoint that was attempted -- "network down" on
    // its own could not tell an operator which of the backends or which URL had the problem.
    expect(anchors[0]).toMatchObject({ status: "failed" });
    expect(anchors[0]!.error).toContain("network down");
    expect(anchors[0]!.error).toContain("/api/v2/log/entries");
  });
});

// #9851: the request side was v2 from the start (hashedRekordRequestV002, POST /api/v2/log/entries) but the
// response parser expected v1 -- a uuid-keyed wrapper, a numeric logIndex, and a uuid field. Rekor v2 sends
// none of those, so this backend could never record a successful anchor even when the log accepted the
// submission. Found on a live instance: the failure moved from "fetch failed" to "did not match the expected
// TransparencyLogEntry shape" once the shard URL was corrected.
describe("parseRekorResponse against the real v2 shape (#9851)", () => {
  it("REGRESSION: parses the entry DIRECTLY, not from a uuid-keyed wrapper", () => {
    const parsed = parseRekorResponse(REKOR_RESPONSE);
    expect(parsed).toMatchObject({ logIndex: 42, logId: { keyId: "c2iga0d1" } });
  });

  it("REGRESSION: accepts logIndex as a proto3-int64 STRING, which is what v2 actually sends", () => {
    expect(parseRekorResponse({ ...REKOR_RESPONSE, logIndex: "907" })?.logIndex).toBe(907);
  });

  it("still accepts a numeric logIndex, so a future revision or a hand-built mock is not rejected", () => {
    expect(parseRekorResponse({ ...REKOR_RESPONSE, logIndex: 907 })?.logIndex).toBe(907);
  });

  it("rejects a logIndex that is not a number at all, rather than publishing NaN in a backendRef", () => {
    for (const bad of ["", "  ", "not-a-number", null, undefined, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseRekorResponse({ ...REKOR_RESPONSE, logIndex: bad })).toBeNull();
    }
  });

  it("rejects a missing or malformed logId, which is what identifies the log that signed the entry", () => {
    for (const bad of [undefined, null, "c2iga0d1", {}, { keyId: "" }, { keyId: 7 }]) {
      expect(parseRekorResponse({ ...REKOR_RESPONSE, logId: bad })).toBeNull();
    }
  });

  it("extracts the checkpoint from inclusionProof -- the v2 locator that replaced uuid", () => {
    expect(parseRekorResponse(REKOR_RESPONSE)?.checkpoint).toContain("log2025-1.rekor.sigstore.dev");
  });

  it("accepts a bare-string checkpoint as well as the { envelope } encoding", () => {
    const bare = { ...REKOR_RESPONSE, inclusionProof: { checkpoint: "a-raw-checkpoint" } };
    expect(parseRekorResponse(bare)?.checkpoint).toBe("a-raw-checkpoint");
  });

  it("records the entry with a NULL checkpoint rather than failing when the proof omits one", () => {
    // The entry is still in the log; only the offline re-check is unavailable. Dropping the whole anchor
    // because one optional field is absent would lose a real, successful submission.
    for (const proof of [undefined, null, {}, { checkpoint: 42 }, { checkpoint: {} }]) {
      const parsed = parseRekorResponse({ ...REKOR_RESPONSE, inclusionProof: proof });
      expect(parsed).toMatchObject({ logIndex: 42 });
      expect(parsed?.checkpoint).toBeNull();
    }
  });

  it("rejects a non-object body outright", () => {
    for (const bad of [null, undefined, "string", 42, []]) {
      // An array has no logIndex, so it fails the same way an unexpected object would.
      expect(parseRekorResponse(bad)).toBeNull();
    }
  });
});
