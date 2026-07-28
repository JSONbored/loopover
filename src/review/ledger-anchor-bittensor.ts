// Bittensor on-chain commitment backend, repo-side glue (#9277, epic #9267).
//
// Unlike the Rekor (#9272) and git-commit (#9273) backends, the SUBMISSION never runs here: a small process
// on the operator's own node infrastructure fetches the current signed checkpoint from
// `GET /v1/public/decision-ledger/anchor-payload`, commits sha256(signingInput) on-chain via the commitments
// pallet's `set_commitment(netuid, Data::Sha256)` using a dedicated hotkey (an operational secret on that
// infrastructure, never in this repo), and then reports the outcome back through
// `POST /v1/decision-ledger/anchor-attempts`. This module is the validation boundary for that report.
//
// Why the report must be VERIFIED and not merely authenticated: the bearer token proves "the operator's
// submitter", but the attempt log is a PUBLIC trust surface (#9271's whole point). A buggy or compromised
// submitter must not be able to inject an anchor row for a payload this engine never signed, nor for a
// (seq, rowHash) pair that is not this live chain's — either would let the log claim corroboration that
// does not exist. So a report is accepted only when:
//   1. its signed payload verifies against a PUBLISHED anchor key (the same check any third party runs), and
//   2. its (seq, rowHash) matches the live ledger row at that seq (the same bind-to-chain step #9269 exists
//      for) — with the one honest exception that a FAILED attempt is recorded even when signature/row checks
//      would fail, because "the submitter is broken" is exactly what the public attempt log must show.
//
// Scope (#9277's own framing): optional, Gittensor/SN74-audience corroboration. Rekor + git remain the
// default every verifier is told to check; nothing here is a required verification step.
import type { LedgerAnchorPayload, SignedLedgerAnchor } from "./ledger-anchor";
import { anchorKeyById, parseAnchorPublicKeys, verifyLedgerAnchorSignature } from "./ledger-anchor";
import { LEDGER_ANCHOR_LEDGER_ID, LEDGER_ANCHOR_PAYLOAD_VERSION } from "./ledger-anchor";
import { loadPublicLedgerRow } from "./decision-record";
import { recordLedgerAnchorAttempt } from "./ledger-anchor-persistence";

/** The on-chain reference an `ok` report must carry — the full set a Gittensor-audience verifier needs to
 *  find the commitment WITHOUT trusting current chain state: `CommitmentOf` is overwritten in place, so a
 *  historical commitment is only reachable by querying archive state at (or the events of) this block. */
export type BittensorAnchorRef = {
  netuid: number;
  blockNumber: number;
  /** 0x-prefixed 32-byte block hash — the archive-state query key for historical retrieval. */
  blockHash: string;
  /** ss58 account of the dedicated anchor hotkey (public on-chain identity, never key material). */
  hotkey: string;
};

export type BittensorAnchorReport = {
  signed: SignedLedgerAnchor;
} & ({ status: "ok"; backendRef: BittensorAnchorRef } | { status: "failed"; error: string });

const HEX_32_BYTES = /^0x[0-9a-f]{64}$/i;
const ROW_HASH = /^[0-9a-f]{64}$/i;

/** Parse + bound one submitter report. Returns a typed report or a NAMED rejection reason — every arm names
 *  the exact field it refused so a submitter bug is diagnosable from the 400 body alone. PURE. */
export function parseBittensorAnchorReport(raw: unknown): { report: BittensorAnchorReport } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body must be a JSON object" };
  const o = raw as Record<string, unknown>;

  const signedRaw = o.signed;
  if (!signedRaw || typeof signedRaw !== "object") return { error: "signed: missing — fetch it from /v1/public/decision-ledger/anchor-payload" };
  const s = signedRaw as Record<string, unknown>;
  const payloadRaw = s.payload;
  if (!payloadRaw || typeof payloadRaw !== "object") return { error: "signed.payload: missing" };
  const p = payloadRaw as Record<string, unknown>;
  if (p.v !== LEDGER_ANCHOR_PAYLOAD_VERSION) return { error: `signed.payload.v: expected ${LEDGER_ANCHOR_PAYLOAD_VERSION}` };
  if (p.ledger !== LEDGER_ANCHOR_LEDGER_ID) return { error: `signed.payload.ledger: expected ${LEDGER_ANCHOR_LEDGER_ID}` };
  if (typeof p.seq !== "number" || !Number.isInteger(p.seq) || p.seq <= 0) return { error: "signed.payload.seq: expected a positive integer" };
  if (typeof p.rowHash !== "string" || !ROW_HASH.test(p.rowHash)) return { error: "signed.payload.rowHash: expected 64 hex chars" };
  if (typeof p.totalCount !== "number" || !Number.isInteger(p.totalCount) || p.totalCount <= 0) return { error: "signed.payload.totalCount: expected a positive integer" };
  if (typeof p.at !== "string" || !p.at || p.at.length > 40) return { error: "signed.payload.at: expected a timestamp string" };
  const payload: LedgerAnchorPayload = { v: LEDGER_ANCHOR_PAYLOAD_VERSION, ledger: LEDGER_ANCHOR_LEDGER_ID, seq: p.seq, rowHash: p.rowHash, totalCount: p.totalCount, at: p.at };

  if (typeof s.keyId !== "string" || !s.keyId || s.keyId.length > 64) return { error: "signed.keyId: expected a short key id" };
  if (typeof s.signature !== "string" || !s.signature || s.signature.length > 512) return { error: "signed.signature: expected base64 (<=512 chars)" };
  const signed: SignedLedgerAnchor = { payload, keyId: s.keyId, signature: s.signature };

  if (o.status === "failed") {
    if (typeof o.error !== "string" || !o.error.trim()) return { error: "error: required on a failed report" };
    return { report: { signed, status: "failed", error: o.error.trim().slice(0, 500) } };
  }
  if (o.status !== "ok") return { error: 'status: expected "ok" or "failed"' };

  const refRaw = o.backendRef;
  if (!refRaw || typeof refRaw !== "object") return { error: "backendRef: required on an ok report" };
  const r = refRaw as Record<string, unknown>;
  if (typeof r.netuid !== "number" || !Number.isInteger(r.netuid) || r.netuid < 0 || r.netuid > 65535) return { error: "backendRef.netuid: expected an integer in [0, 65535]" };
  if (typeof r.blockNumber !== "number" || !Number.isInteger(r.blockNumber) || r.blockNumber <= 0) return { error: "backendRef.blockNumber: expected a positive integer" };
  if (typeof r.blockHash !== "string" || !HEX_32_BYTES.test(r.blockHash)) return { error: "backendRef.blockHash: expected 0x + 64 hex chars" };
  if (typeof r.hotkey !== "string" || !r.hotkey.trim() || r.hotkey.length > 64) return { error: "backendRef.hotkey: expected an ss58 address (<=64 chars)" };
  return {
    report: {
      signed,
      status: "ok",
      backendRef: { netuid: r.netuid, blockNumber: r.blockNumber, blockHash: r.blockHash.toLowerCase(), hotkey: r.hotkey.trim() },
    },
  };
}

export type BittensorReportOutcome =
  | { recorded: true; status: "ok" | "failed" }
  | { recorded: false; reason: "unknown_key" | "bad_signature" | "row_not_found" | "row_hash_mismatch" };

/**
 * Verify one parsed report against the published keys and the LIVE chain, then record it in #9271's public
 * attempt log with backend `bittensor` — the exact same row shape Rekor/git attempts get.
 *
 * A FAILED report skips the signature/row checks deliberately: it records that the submitter could not
 * anchor (chain down, rate-limited, hotkey deregistered), and the payload it carries is what the submitter
 * ATTEMPTED — refusing to log a failure because its evidence is imperfect would recreate exactly the
 * silent-failure hole the public attempt log exists to close. An OK report asserts a public corroboration
 * claim, so it must clear every check before the log will say so.
 */
export async function ingestBittensorAnchorReport(env: Env, report: BittensorAnchorReport): Promise<BittensorReportOutcome> {
  if (report.status === "ok") {
    const keys = parseAnchorPublicKeys(env.LOOPOVER_LEDGER_ANCHOR_KEYS);
    const key = anchorKeyById(keys, report.signed.keyId);
    if (!key) return { recorded: false, reason: "unknown_key" };
    if (!(await verifyLedgerAnchorSignature(report.signed, key.publicKeySpki))) return { recorded: false, reason: "bad_signature" };
    const row = await loadPublicLedgerRow(env, report.signed.payload.seq);
    if (!row) return { recorded: false, reason: "row_not_found" };
    if (row.rowHash !== report.signed.payload.rowHash) return { recorded: false, reason: "row_hash_mismatch" };
    await recordLedgerAnchorAttempt(env, {
      payload: report.signed.payload,
      signature: report.signed.signature,
      keyId: report.signed.keyId,
      backend: "bittensor",
      status: "ok",
      backendRef: report.backendRef,
      // The on-chain commitment IS the proof; there is no separate blob to store (same as git's null).
      proofR2Key: null,
    });
    return { recorded: true, status: "ok" };
  }
  await recordLedgerAnchorAttempt(env, {
    payload: report.signed.payload,
    signature: report.signed.signature,
    keyId: report.signed.keyId,
    backend: "bittensor",
    status: "failed",
    error: report.error,
  });
  return { recorded: true, status: "failed" };
}
