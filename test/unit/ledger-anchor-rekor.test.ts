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

const REKOR_RESPONSE = { "24296fb24b8ad77a": { logIndex: 42, uuid: "24296fb24b8ad77a", logId: { keyId: "c2iga0d1" } } };

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
  it("parses a real-shaped Rekor v2 response, reading the entry under its dynamic uuid key", () => {
    expect(parseRekorResponse(REKOR_RESPONSE)).toEqual({ logIndex: 42, uuid: "24296fb24b8ad77a", logId: { keyId: "c2iga0d1" } });
  });

  it("returns null (never throws) for any response shape it does not recognize", () => {
    expect(parseRekorResponse(null)).toBeNull();
    expect(parseRekorResponse("a string")).toBeNull();
    expect(parseRekorResponse({})).toBeNull();
    expect(parseRekorResponse({ x: {} })).toBeNull();
    expect(parseRekorResponse({ x: { logIndex: "not-a-number", uuid: "u", logId: { keyId: "k" } } })).toBeNull();
    expect(parseRekorResponse({ x: { logIndex: 1, uuid: "u", logId: null } })).toBeNull();
    expect(parseRekorResponse({ x: { logIndex: 1, uuid: "u" } })).toBeNull();
    expect(parseRekorResponse({ x: { logIndex: 1, uuid: "u", logId: { keyId: 7 } } })).toBeNull();
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
      backendRef: { shardBaseUrl: "https://log2026-1.rekor.sigstore.dev", logIndex: 42, logIdKeyId: "c2iga0d1", uuid: "24296fb24b8ad77a" },
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
