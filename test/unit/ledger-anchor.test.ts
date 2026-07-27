import { describe, expect, it } from "vitest";
import {
  anchorKeyById,
  anchorSigningInput,
  buildLedgerAnchorPayload,
  computeAnchorKeyId,
  currentAnchorKey,
  LEDGER_ANCHOR_LEDGER_ID,
  LEDGER_ANCHOR_PAYLOAD_VERSION,
  parseAnchorPublicKeys,
  signLedgerAnchorPayload,
  verifyLedgerAnchorSignature,
  type AnchorPublicKey,
  type SignedLedgerAnchor,
} from "../../src/review/ledger-anchor";

// #9270 (epic #9267). These tests use REAL generated ECDSA P-256 keypairs and real WebCrypto signatures --
// never a stubbed signer -- because the property under test is precisely that an outsider holding only the
// published public key can verify (or refuse) an anchor. A mocked signature would prove nothing about that.

const AT = "2026-07-27T12:00:00.000Z";
const TIP = { seq: 42, rowHash: "a".repeat(64), totalCount: 42 };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toPem(base64: string, label: string): string {
  return `-----BEGIN ${label}-----\n${(base64.match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----`;
}

/** A real P-256 keypair, exported the way an operator would provision one. The two casts narrow WebCrypto's
 *  deliberately-wide lib types (`generateKey` unions CryptoKey with CryptoKeyPair for the symmetric case;
 *  `exportKey` unions ArrayBuffer with JsonWebKey for the "jwk" format) -- both are statically known here from
 *  the algorithm and format actually passed. */
async function generateKeypair(): Promise<{ privateKeyPem: string; publicKeySpki: string; keyId: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = bytesToBase64(new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer));
  const publicKeySpki = bytesToBase64(new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer));
  return { privateKeyPem: toPem(pkcs8, "PRIVATE KEY"), publicKeySpki, keyId: await computeAnchorKeyId(publicKeySpki) };
}

describe("buildLedgerAnchorPayload (#9270)", () => {
  it("is self-describing: carries a schema version and the ledger it commits to, not a bare triple", () => {
    const payload = buildLedgerAnchorPayload(TIP, AT);
    expect(payload).toEqual({
      v: LEDGER_ANCHOR_PAYLOAD_VERSION,
      ledger: LEDGER_ANCHOR_LEDGER_ID,
      seq: 42,
      rowHash: "a".repeat(64),
      totalCount: 42,
      at: AT,
    });
  });

  it("is pure — the same tip and timestamp always produce identical signing input", () => {
    expect(anchorSigningInput(buildLedgerAnchorPayload(TIP, AT))).toBe(anchorSigningInput(buildLedgerAnchorPayload(TIP, AT)));
  });
});

describe("signing and verification round-trip with real keys", () => {
  it("an anchor signed by the operator verifies against the published public key", async () => {
    const { privateKeyPem, publicKeySpki, keyId } = await generateKeypair();
    const signed = await signLedgerAnchorPayload(buildLedgerAnchorPayload(TIP, AT), privateKeyPem, keyId);

    expect(signed.keyId).toBe(keyId);
    expect(signed.signature).not.toBe("");
    expect(await verifyLedgerAnchorSignature(signed, publicKeySpki)).toBe(true);
  });

  it("REJECTS a tampered payload — changing the anchored rowHash breaks the signature", async () => {
    const { privateKeyPem, publicKeySpki, keyId } = await generateKeypair();
    const signed = await signLedgerAnchorPayload(buildLedgerAnchorPayload(TIP, AT), privateKeyPem, keyId);

    const tampered: SignedLedgerAnchor = { ...signed, payload: { ...signed.payload, rowHash: "b".repeat(64) } };
    expect(await verifyLedgerAnchorSignature(tampered, publicKeySpki)).toBe(false);
  });

  it("REJECTS a tampered seq or totalCount — a rewound tip cannot reuse an old signature", async () => {
    const { privateKeyPem, publicKeySpki, keyId } = await generateKeypair();
    const signed = await signLedgerAnchorPayload(buildLedgerAnchorPayload(TIP, AT), privateKeyPem, keyId);

    expect(await verifyLedgerAnchorSignature({ ...signed, payload: { ...signed.payload, seq: 41 } }, publicKeySpki)).toBe(false);
    expect(await verifyLedgerAnchorSignature({ ...signed, payload: { ...signed.payload, totalCount: 41 } }, publicKeySpki)).toBe(false);
  });

  it("REJECTS an anchor signed by a DIFFERENT key — forging an anchor for this ledger fails", async () => {
    const operator = await generateKeypair();
    const attacker = await generateKeypair();
    const forged = await signLedgerAnchorPayload(buildLedgerAnchorPayload(TIP, AT), attacker.privateKeyPem, operator.keyId);

    // The forger even claims the operator's keyId — verification against the real published key still fails.
    expect(await verifyLedgerAnchorSignature(forged, operator.publicKeySpki)).toBe(false);
  });

  it("returns false (never throws) on a malformed signature or malformed key", async () => {
    const { privateKeyPem, publicKeySpki, keyId } = await generateKeypair();
    const signed = await signLedgerAnchorPayload(buildLedgerAnchorPayload(TIP, AT), privateKeyPem, keyId);

    expect(await verifyLedgerAnchorSignature({ ...signed, signature: "not-base64-!!" }, publicKeySpki)).toBe(false);
    expect(await verifyLedgerAnchorSignature(signed, "not-a-key")).toBe(false);
  });
});

describe("computeAnchorKeyId", () => {
  it("derives the id FROM the key, so it cannot drift from the key it names", async () => {
    const { publicKeySpki, keyId } = await generateKeypair();
    expect(await computeAnchorKeyId(publicKeySpki)).toBe(keyId);
    expect(keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives different keys different ids", async () => {
    const [a, b] = await Promise.all([generateKeypair(), generateKeypair()]);
    expect(a.keyId).not.toBe(b.keyId);
  });
});

describe("parseAnchorPublicKeys", () => {
  const valid: AnchorPublicKey = { keyId: "abc123", publicKeySpki: "c3Bra2V5", notBefore: "2026-01-01T00:00:00.000Z", notAfter: null };

  it("parses a valid list", () => {
    expect(parseAnchorPublicKeys(JSON.stringify([valid]))).toEqual([valid]);
  });

  it("fails closed to an empty list on unset, malformed JSON, or a non-array", () => {
    expect(parseAnchorPublicKeys(undefined)).toEqual([]);
    expect(parseAnchorPublicKeys("{not json")).toEqual([]);
    expect(parseAnchorPublicKeys(JSON.stringify({ keyId: "x" }))).toEqual([]);
  });

  it("drops only the invalid entries, so one bad entry cannot hide the valid keys beside it", () => {
    const raw = JSON.stringify([valid, { keyId: "" }, { publicKeySpki: "x" }, null, "string"]);
    expect(parseAnchorPublicKeys(raw)).toEqual([valid]);
  });

  // Every required-field arm rejected independently: a half-written key entry must never be published as if
  // it were usable, and each field is a separate way for hand-edited config to be wrong.
  it("rejects an entry missing or mistyping ANY required field", () => {
    const retiredShape: AnchorPublicKey = { ...valid, keyId: "retired", notAfter: "2026-06-01T00:00:00.000Z" };
    const raw = JSON.stringify([
      valid,
      retiredShape, // notAfter as a STRING is valid (a retired key), not just null
      { ...valid, keyId: 42 }, // keyId not a string
      { ...valid, publicKeySpki: "" }, // empty key material
      { ...valid, publicKeySpki: 7 }, // key material not a string
      { ...valid, notBefore: 1234 }, // notBefore not a string
      { ...valid, notAfter: 99 }, // notAfter neither null nor a string
    ]);
    expect(parseAnchorPublicKeys(raw)).toEqual([valid, retiredShape]);
  });
});

describe("currentAnchorKey / anchorKeyById (rotation)", () => {
  const retired: AnchorPublicKey = { keyId: "old", publicKeySpki: "b2xk", notBefore: "2025-01-01T00:00:00.000Z", notAfter: "2026-01-01T00:00:00.000Z" };
  const active: AnchorPublicKey = { keyId: "new", publicKeySpki: "bmV3", notBefore: "2026-01-01T00:00:00.000Z", notAfter: null };

  it("picks the single open-ended key as current", () => {
    expect(currentAnchorKey([retired, active])).toEqual(active);
  });

  it("fails closed on an ambiguous rotation state (zero or several open-ended keys)", () => {
    expect(currentAnchorKey([retired])).toBeNull();
    expect(currentAnchorKey([active, { ...active, keyId: "other" }])).toBeNull();
    expect(currentAnchorKey([])).toBeNull();
  });

  it("still resolves a RETIRED key by id, so anchors signed before a rotation stay verifiable", () => {
    expect(anchorKeyById([retired, active], "old")).toEqual(retired);
    expect(anchorKeyById([retired, active], "missing")).toBeNull();
  });
});
