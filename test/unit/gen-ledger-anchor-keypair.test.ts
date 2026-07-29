import { describe, expect, it } from "vitest";
import { generateAnchorKeypair } from "../../scripts/gen-ledger-anchor-keypair";
import {
  anchorKeyById,
  buildLedgerAnchorPayload,
  computeAnchorKeyId,
  currentAnchorKey,
  parseAnchorPublicKeys,
  signLedgerAnchorPayload,
  verifyLedgerAnchorSignature,
} from "../../src/review/ledger-anchor";

// #9719: anchoring shipped with no way to provision the key it needs, so both halves had to be produced by
// hand in the exact encodings the runtime expects. A generator that emits a key the runtime then REFUSES
// would reproduce the original failure (`ledger_anchor_skipped_unconfigured`, empty anchor list) while
// looking like a fix — so these tests run the generated values through the real parse/sign/verify path
// rather than checking their shape.

const AT = "2026-07-29T00:00:00.000Z";

describe("gen-ledger-anchor-keypair (#9719)", () => {
  it("REGRESSION: the generated values feed the REAL runtime path end to end — parse, select, sign, verify", async () => {
    const generated = await generateAnchorKeypair(AT);

    // 1. The published half parses through the same function the anchor-key route serves from.
    const keys = parseAnchorPublicKeys(generated.publishedKeys);
    expect(keys).toHaveLength(1);
    // 2. It is SELECTABLE as the current key -- an entry the scheduler cannot pick is the exact
    //    `no_current_signing_key_published` early return that left anchors empty.
    const current = currentAnchorKey(keys);
    expect(current?.keyId).toBe(generated.keyId);

    // 3. The private half imports and signs.
    const payload = buildLedgerAnchorPayload({ seq: 7, rowHash: "a".repeat(64), totalCount: 7 }, AT);
    const signed = await signLedgerAnchorPayload(payload, generated.privateKeyPem, generated.keyId);

    // 4. And a third party holding ONLY the published half verifies it -- the whole point of the artifact.
    const resolved = anchorKeyById(keys, signed.keyId);
    expect(resolved).not.toBeNull();
    expect(await verifyLedgerAnchorSignature(signed, String(resolved?.publicKeySpki))).toBe(true);
  });

  it("the keyId is DERIVED from the public half, so the published key cannot drift from the id naming it", async () => {
    const generated = await generateAnchorKeypair(AT);
    const [published] = parseAnchorPublicKeys(generated.publishedKeys);
    expect(await computeAnchorKeyId(String(published?.publicKeySpki))).toBe(generated.keyId);
  });

  it("emits an OPEN validity window at the supplied instant — a key valid from 'now', never expired", async () => {
    const generated = await generateAnchorKeypair(AT);
    const [published] = parseAnchorPublicKeys(generated.publishedKeys);
    expect(published).toMatchObject({ notBefore: AT, notAfter: null });
  });

  it("INVARIANT: every run is a fresh key — a generator that repeated itself would be catastrophic", async () => {
    const [a, b] = await Promise.all([generateAnchorKeypair(AT), generateAnchorKeypair(AT)]);
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.privateKeyPem).not.toBe(b.privateKeyPem);
  });

  it("REGRESSION: a signature does NOT verify against a different run's key", async () => {
    // Guards the pairing itself: publishing key A while signing with key B would produce anchors that
    // silently fail every third-party check.
    const mine = await generateAnchorKeypair(AT);
    const other = await generateAnchorKeypair(AT);
    const signed = await signLedgerAnchorPayload(
      buildLedgerAnchorPayload({ seq: 1, rowHash: "b".repeat(64), totalCount: 1 }, AT),
      mine.privateKeyPem,
      mine.keyId,
    );
    const [otherPublished] = parseAnchorPublicKeys(other.publishedKeys);
    expect(await verifyLedgerAnchorSignature(signed, String(otherPublished?.publicKeySpki))).toBe(false);
  });

  it("the PEM is real PKCS8 armor, so it pastes into a secret store unmodified", async () => {
    const generated = await generateAnchorKeypair(AT);
    expect(generated.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
    expect(generated.privateKeyPem.trimEnd().endsWith("-----END PRIVATE KEY-----")).toBe(true);
    // Wrapped at 64 columns like every other PEM, so a copy-paste through a YAML block stays valid.
    const body = generated.privateKeyPem.split("\n").slice(1, -1);
    for (const line of body) expect(line.length).toBeLessThanOrEqual(64);
  });
});
