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
//
// The VERIFIER half of this module -- the payload shape, its signing input, key-id derivation and signature
// verification -- moved to @loopover/contract (anchor-verify.ts) for #9723, so the public verifier CLI checks
// anchors with this exact code instead of a reimplementation that could silently diverge. Signing stays here:
// it needs the operator's private key, which nothing outside the Worker may hold. Re-exported below so every
// existing `from "./ledger-anchor"` call site is unchanged.
import {
  anchorSigningInput,
  base64ToBytes,
  computeAnchorKeyId,
  LEDGER_ANCHOR_LEDGER_ID,
  LEDGER_ANCHOR_PAYLOAD_VERSION,
  verifyLedgerAnchorSignature,
  type AnchorPublicKey,
  type LedgerAnchorPayload,
  type SignedLedgerAnchor,
} from "@loopover/contract/anchor-verify";
import { canonicalJson, sha256Hex } from "./decision-record";

export {
  anchorSigningInput,
  computeAnchorKeyId,
  LEDGER_ANCHOR_LEDGER_ID,
  LEDGER_ANCHOR_PAYLOAD_VERSION,
  verifyLedgerAnchorSignature,
  type AnchorPublicKey,
  type LedgerAnchorPayload,
  type SignedLedgerAnchor,
};

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

/**
 * Why {@link parseAnchorPublicKeys} produced what it produced (#9834).
 *
 * `parseAnchorPublicKeys` returns `[]` from four separate paths -- absent value, unparseable JSON, a non-array,
 * and a filter that drops every entry -- and {@link currentAnchorKey} folds two more together, returning null
 * both when NO key is current and when more than one is. Six causes, one `{"keys":[],"currentKeyId":null}`,
 * which reads as a healthy empty state.
 *
 * This is the same defect {@link PublicAnchorStatus} was introduced to fix for the sibling anchors listing,
 * never applied here. It matters concretely: after #9719 provisioned the keypair, whether that provisioning
 * took effect was undeterminable -- a typo in the secret is byte-identical to an unset secret, from outside
 * AND for the operator.
 */
export type AnchorKeyStatus =
  /** Exactly one key has `notAfter: null`. Anchoring can sign. */
  | "ok"
  /** The env var is absent or empty -- never provisioned. */
  | "unconfigured"
  /** Present but not parseable as a JSON array: a truncated paste, a quoting mistake, an object. */
  | "malformed"
  /** A JSON array whose every entry failed field validation -- e.g. `keyid` for `keyId`. Shape right, keys wrong. */
  | "no_valid_entries"
  /** Valid entries, but every one carries a `notAfter` -- the rotation ran off the end without a successor. */
  | "expired"
  /** More than one entry claims `notAfter: null`. currentAnchorKey fails closed here (picking one would
   *  attribute anchors to a key that did not sign them), so this is unsigned-but-configured, not ok. */
  | "ambiguous_rotation";

export type AnchorKeyDiagnosis = {
  status: AnchorKeyStatus;
  keys: AnchorPublicKey[];
  currentKeyId: string | null;
  /** Entries present in the array but rejected by validation. Reported even when `status` is "ok", so one
   *  typo'd key among three is visible rather than silently dropped into a healthy-looking response. */
  droppedEntries: number;
};

/**
 * PURE. Classify the raw env value, alongside the keys {@link parseAnchorPublicKeys} would return.
 *
 * NEVER echoes the raw value, under any status. `LOOPOVER_LEDGER_ANCHOR_KEYS` is served by an
 * unauthenticated endpoint, and an operator who mis-pastes `LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY` into it
 * would have the private half published by the very diagnostic meant to help them. A classification is
 * always safe to return; the input never is.
 */
export function diagnoseAnchorPublicKeys(raw: string | undefined): AnchorKeyDiagnosis {
  const empty = { keys: [] as AnchorPublicKey[], currentKeyId: null, droppedEntries: 0 };
  if (!raw) return { status: "unconfigured", ...empty };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed", ...empty };
  }
  if (!Array.isArray(parsed)) return { status: "malformed", ...empty };

  const keys = parseAnchorPublicKeys(raw);
  const droppedEntries = parsed.length - keys.length;
  // An empty array is "configured to publish no keys", which is operationally the same actionable state as
  // never setting it -- and distinct from "entries were present but every one was rejected".
  if (keys.length === 0) return { status: parsed.length === 0 ? "unconfigured" : "no_valid_entries", ...empty };

  const current = keys.filter((key) => key.notAfter === null);
  const status: AnchorKeyStatus = current.length === 1 ? "ok" : current.length === 0 ? "expired" : "ambiguous_rotation";
  return { status, keys, currentKeyId: currentAnchorKey(keys)?.keyId ?? null, droppedEntries };
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

/** Why the public anchor list looks the way it does. Without this, "never configured", "no ledger to anchor",
 *  and "anchoring is healthy but has not run yet" are all indistinguishable from outside — every one of them
 *  renders as `{"anchors":[]}`, which reads as a healthy empty state. The module header of
 *  ledger-anchor-persistence.ts states the goal ("an operator whose anchoring silently fails could quietly
 *  regress the ledger back to tamper-evident-only with no visible signal"); that guarantee only held AFTER
 *  both of the scheduler's guards passed, and this closes the gap before them. */
export type PublicAnchorStatus = "anchored" | "empty_ledger" | "unconfigured" | "pending";

/** PURE. Guard order deliberately mirrors runScheduledLedgerAnchor's own (tip first, then signing key), so the
 *  status a reader sees always names the same reason the scheduler would act on, never a second opinion. */
export function publicAnchorStatus(input: { anchorCount: number; tipSeq: number; hasSigningKey: boolean }): PublicAnchorStatus {
  if (input.anchorCount > 0) return "anchored";
  if (input.tipSeq === 0) return "empty_ledger";
  if (!input.hasSigningKey) return "unconfigured";
  return "pending";
}

/** Digest helpers re-exported so an anchor consumer (e.g. the git-commit backend, #9273, which commits the
 *  same canonicalized payload Rekor anchors) never needs a second import from decision-record.ts just to
 *  canonicalize or hash something alongside a signed anchor. */
export { canonicalJson, sha256Hex };
