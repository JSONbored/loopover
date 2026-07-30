// The verifier half of LoopOver's ledger anchoring (#9723) — payload shape, signing input, key-id
// derivation, and signature verification.
//
// `src/review/ledger-anchor.ts` used to own all of this, and its own comment on the verify function said it
// "is the function a third party's own verifier reimplements". That was the bug #9723 exists to fix: a
// third party reimplementing ECDSA-over-canonical-JSON in another language is exactly where a verifier
// silently diverges from the signer and starts reporting green on anchors it never actually checked.
//
// So the VERIFYING half lives here, in the published leaf package, and an outsider imports it. The SIGNING
// half stays in the Worker, because it needs the operator's private key and nothing outside the Worker may
// hold it. That split is the point: everything a skeptic needs is published; nothing a skeptic must not
// have comes with it.
import { canonicalJson } from "./digest.js";

/** Bump when the payload's FIELD SET changes meaning. A verifier reads this FIRST and refuses shapes it does
 *  not understand, rather than silently misreading a future field set as the current one. */
export const LEDGER_ANCHOR_PAYLOAD_VERSION = 1 as const;

/** Identifies WHICH chain an anchor commits to. A fixed string today (one ledger), but present from v1 so a
 *  second anchored chain can never be confused for this one by a verifier holding both. */
export const LEDGER_ANCHOR_LEDGER_ID = "loopover.decision_ledger";

/** The exact bytes an anchor commits to. `totalCount` is included alongside `seq` deliberately: a chain
 *  truncated and re-chained to the same length would still have to match BOTH, and the pair is what lets a
 *  verifier notice "the tip moved backwards" without fetching every row. */
export type LedgerAnchorPayload = {
  v: typeof LEDGER_ANCHOR_PAYLOAD_VERSION;
  ledger: typeof LEDGER_ANCHOR_LEDGER_ID;
  seq: number;
  rowHash: string;
  totalCount: number;
  at: string;
};

/** A payload plus the operator signature over its canonical serialization, and the id of the key that signed
 *  it. `keyId` is REQUIRED: without it a verifier holding a rotation history cannot tell which published key
 *  a given anchor should be checked against, and would have to try them all -- turning a failed verification
 *  (a real signal) into an ambiguous one. */
export type SignedLedgerAnchor = {
  payload: LedgerAnchorPayload;
  keyId: string;
  /** base64 P-1363 (r||s) ECDSA signature over `canonicalJson(payload)`, as WebCrypto produces it. */
  signature: string;
};

/** One published anchor-signing public key and the window it was valid for. `notAfter: null` = still current.
 *  Rotation is why this is a LIST: an anchor signed in 2026 must stay verifiable after a 2027 rotation, so
 *  retired keys are published forever rather than replaced. */
export type AnchorPublicKey = {
  keyId: string;
  /** base64 SPKI DER -- the same encoding Rekor's `verifier.publicKey.rawBytes` takes (#9272). */
  publicKeySpki: string;
  notBefore: string;
  notAfter: string | null;
};

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Derive a key's id FROM the key itself -- sha256(SPKI DER), first 16 hex chars. Deliberately not an operator-
 * chosen label: a derived id cannot drift from the key it names, cannot be reused for a different key across
 * a rotation, and lets a verifier confirm that the key they fetched is the key an anchor claims was used.
 */
export async function computeAnchorKeyId(publicKeySpkiBase64: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", base64ToBytes(publicKeySpkiBase64) as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** The exact bytes signed and verified -- one definition both sides share, so a serialization change can
 *  never silently break verification while leaving signing "working". */
export function anchorSigningInput(payload: LedgerAnchorPayload): string {
  return canonicalJson(payload);
}

/**
 * Verify a signed anchor against a published public key. Returns a boolean rather than throwing for an
 * ordinarily-invalid input (wrong key, tampered payload, malformed signature) -- those are all "not verified",
 * a fact about the anchor, not a caller bug.
 */
export async function verifyLedgerAnchorSignature(signed: SignedLedgerAnchor, publicKeySpkiBase64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", base64ToBytes(publicKeySpkiBase64) as Uint8Array<ArrayBuffer>, { name: "ECDSA", namedCurve: "P-256" }, true, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64ToBytes(signed.signature) as Uint8Array<ArrayBuffer>,
      new TextEncoder().encode(anchorSigningInput(signed.payload)),
    );
  } catch {
    return false;
  }
}
