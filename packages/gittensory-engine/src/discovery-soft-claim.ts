import { DISCOVERY_INDEX_CONTRACT_VERSION } from "./discovery-index-contract.js";

// Soft-claim coordination request builder (#4302). The local soft-claim ledger (claim-ledger.js) is 100%
// client-side — "never uploads, syncs, or phones home" — and duplicate-cluster adjudication
// (isDuplicateClusterWinnerByClaim, #3355) only resolves collisions AFTER the fact, by observing which PR/comment
// publicly landed first. This module closes that gap on the client side: a pure function that turns a local claim
// record into the request payload a miner would send to the optional hosted discovery-index (the contract in
// discovery-index-contract.ts, #4300) to softly announce/reserve an issue across the fleet BEFORE starting, so
// collisions are reduced rather than only detected afterward.
//
// Scoped as a "request builder", not a network client: pure input→output, no HTTP (wiring the hosted plane's
// client into the miner runtime is downstream of #4250 existing). It shares the discovery-index contract's posture:
// metadata-only and public-safe by construction — the request is built by explicitly copying a fixed set of
// known fields, never by spreading the input, so no unexpected/forbidden field can ride along.
//
// DECISION (the issue's open question — reject vs. release for non-active claims): a `released`/`expired` claim
// produces an explicit `release` request variant rather than being rejected, so the fleet learns an issue is free
// again; only an `active` claim produces a `claim` request.

/** The three local claim-ledger statuses (claim-ledger.js `CLAIM_STATUSES`). */
export type SoftClaimStatus = "active" | "released" | "expired";

/** Outbound coordination actions: announce a claim, or announce that a prior claim is released. */
export type SoftClaimAction = "claim" | "release";

/** The local claim-ledger record shape (claim-ledger.js `rowToClaim`) this builder reads from. */
export type SoftClaimRecord = {
  repoFullName: string;
  issueNumber: number;
  claimedAt: string;
  status: SoftClaimStatus;
  note?: string | null;
};

/** Optional caller context. Reserved for future public-safe, anonymized coordination metadata. */
export type SoftClaimRequestContext = {
  instanceId?: string;
};

/** The public-safe soft-claim coordination request payload targeting the discovery-index contract. */
export type SoftClaimRequest = {
  contractVersion: number;
  action: SoftClaimAction;
  repoFullName: string;
  issueNumber: number;
  claimedAt: string;
  note: string | null;
  instanceId: string | null;
};

/** `active` announces a `claim`; `released`/`expired` announce a `release`. */
export function softClaimActionForStatus(status: SoftClaimStatus): SoftClaimAction {
  return status === "active" ? "claim" : "release";
}

/** `owner/repo` with exactly one slash and non-empty halves; anything else → null (mirrors the discovery-index
 *  contract / claim-ledger repo validation). */
function normalizeRepoFullName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const [owner, repo, extra] = value.trim().split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return `${owner}/${repo}`;
}

function isSoftClaimStatus(value: unknown): value is SoftClaimStatus {
  return value === "active" || value === "released" || value === "expired";
}

/**
 * Build a public-safe soft-claim coordination request from a local claim-ledger record. Pure and network-free.
 * Returns null when the claim is missing/invalid or carries an unknown status (only the three claim-ledger
 * statuses map to a request). Only the fixed set of known fields is copied onto the request, so the payload stays
 * metadata-only by construction.
 */
export function buildSoftClaimRequest(claim: unknown, _context: SoftClaimRequestContext = {}): SoftClaimRequest | null {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return null;
  const record = claim as Record<string, unknown>;
  const repoFullName = normalizeRepoFullName(record.repoFullName);
  if (repoFullName === null) return null;
  const issueNumber = record.issueNumber;
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  if (typeof record.claimedAt !== "string" || record.claimedAt.trim() === "") return null;
  if (!isSoftClaimStatus(record.status)) return null;
  return {
    contractVersion: DISCOVERY_INDEX_CONTRACT_VERSION,
    action: softClaimActionForStatus(record.status),
    repoFullName,
    issueNumber,
    claimedAt: record.claimedAt,
    // Local claim-ledger notes and caller instance IDs may contain operator prose or private identifiers. The hosted
    // discovery plane only receives fixed public metadata, so keep both fields empty.
    note: null,
    instanceId: null,
  };
}
