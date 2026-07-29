#!/usr/bin/env node
// Generate the decision-ledger anchor signing keypair (#9719, epic #9267).
//
// Anchoring shipped with no way to provision the key it needs. Both halves of the scheduler's second guard
// (`LOOPOVER_LEDGER_ANCHOR_KEYS`, `LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY`) had to be produced by hand, in the
// exact encodings `parseAnchorPublicKeys` and `signLedgerAnchorPayload` expect, with a keyId that is
// `computeAnchorKeyId` of the public half -- and nothing in the repo said how. An operator who guessed any
// of those wrong got `ledger_anchor_skipped_unconfigured` and an empty anchor list, which until #9755 was
// indistinguishable from a healthy idle instance.
//
// This prints both values ready to paste, deriving the keyId with the SAME function the runtime uses, so
// the published key and the anchors that reference it cannot disagree.
//
//   npm run ledger:anchor-keygen
//
// PRINTS a private key to stdout. It is never written to disk, never committed, and the output is meant to
// go straight into your secret store (`wrangler secret put`, a compose env file, a vault entry). Run it on a
// machine you trust, and do not paste the private half into a shell history you keep.
import { computeAnchorKeyId } from "../src/review/ledger-anchor";

function toPem(base64: string, label: string): string {
  return `-----BEGIN ${label}-----\n${(base64.match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type GeneratedAnchorKeypair = {
  keyId: string;
  /** Exactly the string `LOOPOVER_LEDGER_ANCHOR_KEYS` takes -- a JSON array, parseable by
   *  `parseAnchorPublicKeys` without further massaging. */
  publishedKeys: string;
  /** Exactly the string `LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY` takes -- PKCS8 PEM, importable by
   *  `signLedgerAnchorPayload`. */
  privateKeyPem: string;
};

/**
 * Produce both halves in the encodings the runtime expects. Exported and returning values rather than
 * printing them, so a test can assert the OUTPUT actually round-trips -- generating a key that the runtime
 * then refuses is precisely the failure this script exists to prevent, and a print-only script could not be
 * checked for it.
 */
export async function generateAnchorKeypair(now: string = new Date().toISOString()): Promise<GeneratedAnchorKeypair> {
  // P-256 / SHA-256 -- the pair `signLedgerAnchorPayload` imports and Rekor's `PKIX_ECDSA_P256_SHA_256`
  // verifier expects. Any other curve produces anchors Rekor rejects and third parties cannot check.
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = bytesToBase64(new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer));
  const publicKeySpki = bytesToBase64(new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer));
  // Derived with the SAME function the runtime uses, so the published key and the anchors referencing it
  // cannot disagree about the id.
  const keyId = await computeAnchorKeyId(publicKeySpki);
  // `notBefore` is now: an anchor signed before its key's validity window would not verify against it.
  return {
    keyId,
    publishedKeys: JSON.stringify([{ keyId, publicKeySpki, notBefore: now, notAfter: null }]),
    privateKeyPem: toPem(pkcs8, "PRIVATE KEY"),
  };
}

async function main(): Promise<void> {
  const { keyId, publishedKeys, privateKeyPem } = await generateAnchorKeypair();

  console.log("# ── LOOPOVER_LEDGER_ANCHOR_KEYS (public, safe to publish and to commit) ──");
  console.log("# Serve this verbatim; it is what /v1/public/decision-ledger/anchor-key returns.");
  console.log(`LOOPOVER_LEDGER_ANCHOR_KEYS='${publishedKeys}'`);
  console.log("");
  console.log("# ── LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY (SECRET — never commit) ──");
  console.log("# wrangler secret put LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY   (paste the block below)");
  console.log(privateKeyPem);
  console.log("");
  console.log(`# keyId ${keyId} — derived from the public half, so it cannot drift from the key it names.`);
  console.log("# ROTATION: keep the retired entry in LOOPOVER_LEDGER_ANCHOR_KEYS with notAfter set to the");
  console.log("# rotation instant and append the new one. Anchors signed under the old key must stay");
  console.log("# verifiable forever, so a retired key is never removed -- only closed.");
}

// Only when run directly, so importing this for a test does not print a private key into the test log.
if (process.argv[1]?.endsWith("gen-ledger-anchor-keypair.ts")) await main();
