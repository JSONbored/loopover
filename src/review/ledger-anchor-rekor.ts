// Rekor v2 hashedrekord anchoring backend (#9272, epic #9267). Primary anchoring mechanism per the mechanism
// research on #9267: a plain hash + signature is exactly what `hashedrekord` is for -- Rekor never sees the
// anchor payload itself, only a digest and a signature over it, plus the self-managed verifier public key
// from #9270. No Fulcio, no OIDC, no new dependency (ECDSA P-256/SHA-256 is native WebCrypto). Free, ~200
// byte payload, 99.5% SLO.
import type { SignedLedgerAnchor } from "./ledger-anchor";
import { anchorSigningInput } from "./ledger-anchor";
import { recordLedgerAnchorAttempt } from "./ledger-anchor-persistence";

/** Rekor shards annually as `log<year>-<rev>.rekor.sigstore.dev` and the research is explicit: do not
 *  hardcode a log URL. Configurable via env, so an operator updates a variable at the next rotation rather
 *  than waiting on a release.
 *
 *  This default was previously `log2026-1`, a shard Sigstore has not deployed -- so it did not resolve, and
 *  EVERY deployment that enabled anchoring without setting the env var recorded `fetch failed` forever and
 *  published no anchor at all (#9844, found on a live self-host instance). Guessing the next shard ahead of
 *  its deployment is worse than lagging behind it: a stale-but-real default still anchors, while a
 *  not-yet-existent one silently anchors nothing.
 *
 *  So: only ever point this at a shard confirmed to be serving. When 2026-1 goes live, this moves then. */
const DEFAULT_REKOR_SHARD_BASE_URL = "https://log2025-1.rekor.sigstore.dev";

/** The exact `hashedRekordRequestV002` body Rekor v2's `POST /api/v2/log/entries` accepts. Digest and
 *  signature are both base64 per the API; `keyDetails` names the algorithm so Rekor can verify without
 *  guessing. */
export type HashedRekordRequestV002 = {
  hashedRekordRequestV002: {
    digest: string;
    signature: {
      content: string;
      verifier: {
        publicKey: { rawBytes: string };
        keyDetails: "PKIX_ECDSA_P256_SHA_256";
      };
    };
  };
};

/** The subset of Rekor's `TransparencyLogEntry` response this module reads. The full response (including the
 *  inclusion proof and signed checkpoint) is what would let a verifier check inclusion fully OFFLINE without
 *  trusting Rekor's continued availability -- storing that blob is deliberately deferred past this PR (see
 *  this module's own header on `proofR2Key`), but the fields below are enough for ONLINE verification via
 *  `rekor-cli verify --uuid ... --artifact-hash ...` today. */
export type RekorTransparencyLogEntryResponse = {
  logIndex: number;
  logId: { keyId: string };
  /** The signed checkpoint from the entry's inclusion proof -- the v2 locator. Rekor v2 has no `uuid`: an
   *  entry is identified by its log index plus the checkpoint the inclusion proof was issued against, and
   *  that pair is what a verifier needs to re-derive inclusion against the tile-backed log. Null when the
   *  log omits it (the entry is still recorded; only the offline re-check is unavailable). */
  checkpoint: string | null;
};

/**
 * Build the exact request body Rekor v2 expects, from an already-signed anchor and the matching published
 * public key. PURE and synchronous -- the digest itself needs one async hash, so this returns a Promise, but
 * makes no network call.
 */
export async function buildHashedRekordRequest(signed: SignedLedgerAnchor, publicKeySpkiBase64: string): Promise<HashedRekordRequestV002> {
  const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(anchorSigningInput(signed.payload)));
  const digest = base64Encode(new Uint8Array(digestBytes));
  return {
    hashedRekordRequestV002: {
      digest,
      signature: {
        content: signed.signature,
        verifier: {
          publicKey: { rawBytes: publicKeySpkiBase64 },
          keyDetails: "PKIX_ECDSA_P256_SHA_256",
        },
      },
    },
  };
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Parse the fields this module needs out of Rekor's raw JSON response. Rekor v2 nests the entry under a
 * dynamic key (the submitted entry's own uuid) rather than a fixed field name -- this reads the first (and
 * only, for a single-entry submission) value. Returns `null` for any response shape that doesn't match,
 * rather than throwing, so a Rekor API change degrades to a recorded failure instead of an unhandled crash.
 */
/** Rekor v2 serializes `log_index` as a proto3 int64, which JSON-encodes as a STRING ("0"), while a
 *  hand-written mock or a future revision may send a number. Both are accepted; anything non-finite is not,
 *  so a garbled value fails the parse rather than becoming NaN in a published backendRef. */
function parseLogIndex(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The checkpoint lives at `inclusionProof.checkpoint`, which the protobuf-JSON encodes as
 *  `{ envelope: "..." }`. Accepted as a bare string too, since that is the shape a plain reading of the
 *  field name suggests and costs nothing to tolerate. */
function parseCheckpoint(inclusionProof: unknown): string | null {
  if (typeof inclusionProof !== "object" || inclusionProof === null) return null;
  const checkpoint = (inclusionProof as Record<string, unknown>)["checkpoint"];
  if (typeof checkpoint === "string") return checkpoint;
  if (typeof checkpoint === "object" && checkpoint !== null) {
    const envelope = (checkpoint as Record<string, unknown>)["envelope"];
    if (typeof envelope === "string") return envelope;
  }
  return null;
}

/**
 * Parse Rekor v2's `TransparencyLogEntry`.
 *
 * This previously read the v1 shape: a wrapper object keyed by entry uuid, with a numeric `logIndex` and a
 * `uuid` field. Rekor v2 returns the entry DIRECTLY, encodes `logIndex` as a string (proto3 int64), and has
 * no `uuid` at all -- so every field the old parser required was absent or the wrong type, and this backend
 * could never record a successful anchor even when the submission itself was accepted (#9851). The request
 * side was already v2 (`hashedRekordRequestV002`, `POST /api/v2/log/entries`); only the response side lagged.
 */
export function parseRekorResponse(raw: unknown): RekorTransparencyLogEntryResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const logIndex = parseLogIndex(candidate["logIndex"]);
  const logId = candidate["logId"];
  if (logIndex === null || typeof logId !== "object" || logId === null) return null;
  const keyId = (logId as Record<string, unknown>)["keyId"];
  if (typeof keyId !== "string" || keyId === "") return null;
  return { logIndex, logId: { keyId }, checkpoint: parseCheckpoint(candidate["inclusionProof"]) };
}

/**
 * Submit a signed anchor to Rekor v2 and record the outcome via #9271's persistence -- success or failure,
 * always. Never throws: a network error, a non-2xx response, or an unparseable response body all become a
 * `status: 'failed'` row with the error, matching this backend's own issue text ("must not throw past the
 * caller", so #9273's git backend still gets attempted even if this one fails).
 *
 * `fetchImpl` is injectable so tests exercise this function's own logic against a scripted response, never a
 * real network call to Rekor.
 */
export async function submitToRekor(
  env: Env,
  signed: SignedLedgerAnchor,
  publicKeySpkiBase64: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const shardBaseUrl = env.LOOPOVER_LEDGER_ANCHOR_REKOR_SHARD_URL ?? DEFAULT_REKOR_SHARD_BASE_URL;
  try {
    const body = await buildHashedRekordRequest(signed, publicKeySpkiBase64);
    // v2 batches submissions -- a short timeout would misread a slow-but-successful submission as failure.
    const response = await fetchImpl(`${shardBaseUrl}/api/v2/log/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await recordLedgerAnchorAttempt(env, {
        payload: signed.payload,
        signature: signed.signature,
        keyId: signed.keyId,
        backend: "rekor",
        status: "failed",
        error: `Rekor responded ${response.status}: ${(await response.text()).slice(0, 200)}`,
      });
      return;
    }
    const parsed = parseRekorResponse(await response.json());
    if (!parsed) {
      await recordLedgerAnchorAttempt(env, {
        payload: signed.payload,
        signature: signed.signature,
        keyId: signed.keyId,
        backend: "rekor",
        status: "failed",
        error: "Rekor response did not match the expected TransparencyLogEntry shape",
      });
      return;
    }
    await recordLedgerAnchorAttempt(env, {
      payload: signed.payload,
      signature: signed.signature,
      keyId: signed.keyId,
      backend: "rekor",
      status: "ok",
      backendRef: { shardBaseUrl, logIndex: parsed.logIndex, logIdKeyId: parsed.logId.keyId, checkpoint: parsed.checkpoint },
      // Deferred past this PR: storing the full TransparencyLogEntry (inclusion proof + signed checkpoint) in
      // R2 for fully offline verification. Online verification (rekor-cli against shardBaseUrl + uuid) works
      // fully without it today; the offline path is a documented enhancement, not a gap in this backend.
      proofR2Key: null,
    });
  } catch (error) {
    // The raw caught value still reaches the persistence layer, which stays the single place that normalizes
    // an unknown error into text -- but it is WRAPPED so the recorded failure names the endpoint. Node's bare
    // "fetch failed" cannot distinguish a shard hostname that does not resolve from blocked egress from a log
    // that is down, and those have three different fixes. #9271 published these failures precisely so anyone
    // can see anchoring is broken; a published failure that does not say what failed only half-delivers that.
    // `cause` is preserved, so nothing a caller could previously inspect is lost.
    await recordLedgerAnchorAttempt(env, {
      payload: signed.payload,
      signature: signed.signature,
      keyId: signed.keyId,
      backend: "rekor",
      status: "failed",
      error: new Error(`Rekor submission to ${shardBaseUrl}/api/v2/log/entries failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }),
    });
  }
}
