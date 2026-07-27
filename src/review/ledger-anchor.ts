// Signed, versioned decision-ledger anchor payloads (#9270, epic #9267). An anchor is the small artifact a
// scheduled job publishes to somewhere the operator does not control (a transparency log, a public git repo)
// so that "the ledger's tip really was X at time T" becomes checkable by a stranger later. Two properties
// this module exists to provide, neither of which the original {seq, rowHash, at} shape had:
//
//   1. SELF-DESCRIBING. An anchor read cold in two years, out of whatever log it landed in, must say what it
//      is and what it commits to -- hence an explicit schema version and a ledger identifier. A bare
//      {seq, rowHash, at} triple is unattributable: it names neither the chain it came from nor the rules
//      under which it should be read.
//   2. SIGNED, so an anchor cannot be FORGED. Without a signature anyone could publish a plausible-looking
//      anchor for this ledger and then "prove" a rewrite that never happened -- a denial-of-integrity attack
//      against our own record. The signature says only "this operator published this tip claim"; it is
//      deliberately NOT the tamper-proofness itself (that comes from the anchor landing somewhere append-only
//      the operator cannot rewrite -- see #9272/#9273).
//
// ECDSA P-256 / SHA-256 via WebCrypto: native to the Workers runtime, so this adds no dependency, and it is
// exactly what Rekor's `hashedrekord` accepts as a self-managed verifier key (#9272) -- the same keypair
// serves both the local signature and the transparency-log submission.
import { canonicalJson, sha256Hex } from "./decision-record";

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

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Strip PEM armor to raw DER bytes. Accepts the `\n`-escaped single-line form too, since that is how a key
 *  survives being pasted into a Worker secret / CI variable (same normalization signRs256Jwt already does). */
function pemToBytes(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, "\n");
  const base64 = normalized
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(base64);
}

/**
 * Derive a key's id FROM the key itself -- sha256(SPKI DER), first 16 hex chars. Deliberately not an operator-
 * chosen label: a derived id cannot drift from the key it names, cannot be reused for a different key across
 * a rotation, and lets a verifier confirm that the key they fetched is the key an anchor claims was used.
 */
export async function computeAnchorKeyId(publicKeySpkiBase64: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", base64ToBytes(publicKeySpkiBase64) as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/**
 * Build the versioned, self-describing payload for a tip. PURE and synchronous -- the caller supplies `at`
 * (or accepts the default) so a scheduled job's payload is reproducible in a test.
 */
export function buildLedgerAnchorPayload(tip: { seq: number; rowHash: string; totalCount: number }, at: string): LedgerAnchorPayload {
  return {
    v: LEDGER_ANCHOR_PAYLOAD_VERSION,
    ledger: LEDGER_ANCHOR_LEDGER_ID,
    seq: tip.seq,
    rowHash: tip.rowHash,
    totalCount: tip.totalCount,
    at,
  };
}

/** The exact bytes signed and verified -- one definition both sides share, so a serialization change can
 *  never silently break verification while leaving signing "working". */
export function anchorSigningInput(payload: LedgerAnchorPayload): string {
  return canonicalJson(payload);
}

/**
 * Sign an anchor payload with the operator's ECDSA P-256 private key (PKCS8 PEM, held as a Worker secret and
 * never in the repo). `keyId` is supplied by the caller -- it is `computeAnchorKeyId` of the PUBLISHED public
 * half, which the signer knows from config. It is not derived here on purpose: WebCrypto cannot export a
 * public key from a non-extractable PKCS8 import, and importing a long-lived signing key as extractable
 * purely to relabel it would be a strictly worse posture for a key that lives in a secret.
 */
export async function signLedgerAnchorPayload(
  payload: LedgerAnchorPayload,
  privateKeyPem: string,
  keyId: string,
): Promise<SignedLedgerAnchor> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(privateKeyPem) as Uint8Array<ArrayBuffer>,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(anchorSigningInput(payload)),
  );
  return { payload, keyId, signature: bytesToBase64(new Uint8Array(signature)) };
}

/**
 * Verify a signed anchor against a published public key. Returns a boolean rather than throwing for an
 * ordinarily-invalid input (wrong key, tampered payload, malformed signature) -- those are all "not verified",
 * a fact about the anchor, not a caller bug. This is the function a third party's own verifier reimplements;
 * it is exported so our tests exercise the SAME path an outsider would, never a privileged shortcut.
 */
export async function verifyLedgerAnchorSignature(signed: SignedLedgerAnchor, publicKeySpkiBase64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      base64ToBytes(publicKeySpkiBase64) as Uint8Array<ArrayBuffer>,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
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

/**
 * Parse the published key list from its configured JSON. Never throws: malformed config yields an EMPTY list,
 * which fails closed at the route (no keys published => nothing claims to be verifiable) rather than a 500 on
 * a public endpoint. Entries missing required fields are dropped individually, so one bad entry cannot hide
 * every valid key alongside it.
 */
export function parseAnchorPublicKeys(raw: string | undefined): AnchorPublicKey[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is AnchorPublicKey => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as Record<string, unknown>;
    return (
      typeof candidate["keyId"] === "string" &&
      candidate["keyId"] !== "" &&
      typeof candidate["publicKeySpki"] === "string" &&
      candidate["publicKeySpki"] !== "" &&
      typeof candidate["notBefore"] === "string" &&
      (candidate["notAfter"] === null || typeof candidate["notAfter"] === "string")
    );
  });
}

/** The key currently signing anchors: the one entry with `notAfter: null`. Returns null when zero or MORE
 *  THAN ONE qualify -- an ambiguous rotation state must fail closed rather than silently pick one, since
 *  picking wrong would attribute anchors to a key that did not sign them. */
export function currentAnchorKey(keys: readonly AnchorPublicKey[]): AnchorPublicKey | null {
  const current = keys.filter((key) => key.notAfter === null);
  return current.length === 1 ? (current[0] as AnchorPublicKey) : null;
}

/** Find the key an anchor claims signed it, for a verifier walking a rotation history. */
export function anchorKeyById(keys: readonly AnchorPublicKey[], keyId: string): AnchorPublicKey | null {
  return keys.find((key) => key.keyId === keyId) ?? null;
}

/** Digest helpers re-exported so an anchor consumer (e.g. the git-commit backend, #9273, which commits the
 *  same canonicalized payload Rekor anchors) never needs a second import from decision-record.ts just to
 *  canonicalize or hash something alongside a signed anchor. */
export { canonicalJson, sha256Hex };
