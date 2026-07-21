/** PURE — no IO, no Date, no random (#2316). */

import type { ClaimEntry } from "./claim-ledger.js";

export const DEFAULT_MAX_CLAIM_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export type ClaimLedgerExpiryStore = {
  listClaims(filter?: { status?: "active" }): ClaimEntry[];
  expireClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null;
};

function claimAgeMs(claim: ClaimEntry, nowMs: number): number | null {
  const claimedAtMs = Date.parse(claim.claimedAt);
  if (!Number.isFinite(claimedAtMs)) return null;
  return nowMs - claimedAtMs;
}

/**
 * Return active claims whose age is strictly greater than `maxAgeMs`. A claim whose age equals `maxAgeMs` exactly
 * is still considered within the window (not expired).
 */
export function findExpiredClaims(claims: ClaimEntry[], nowMs: number, maxAgeMs: number): ClaimEntry[] {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error("invalid_now_ms");
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error("invalid_max_age_ms");
  if (!Array.isArray(claims)) throw new Error("invalid_claims");

  const expired: ClaimEntry[] = [];
  for (const claim of claims) {
    if (claim?.status !== "active") continue;
    const ageMs = claimAgeMs(claim, nowMs);
    // Fail closed on an unparseable claimedAt (#7732): a corrupted/hand-edited row whose age can't be computed
    // is swept rather than left permanently un-expirable -- matching this module's own fail-closed posture and
    // avoiding a claim that stays stuck active forever.
    if (ageMs === null || ageMs > maxAgeMs) expired.push(claim);
  }
  return expired;
}

export function sweepExpiredClaims(
  store: ClaimLedgerExpiryStore,
  nowMs: number,
  maxAgeMs: number = DEFAULT_MAX_CLAIM_AGE_MS,
): ClaimEntry[] {
  const activeClaims = store.listClaims({ status: "active" });
  const expired = findExpiredClaims(activeClaims, nowMs, maxAgeMs);
  const transitioned: ClaimEntry[] = [];
  for (const claim of expired) {
    // Echo the row's OWN apiBaseUrl back (#5563) rather than defaulting: two forge hosts can each have an
    // active claim on the same owner/repo#issue, and defaulting here would expire the wrong host's row.
    const updated = store.expireClaim(claim.repoFullName, claim.issueNumber, claim.apiBaseUrl);
    if (updated) transitioned.push(updated);
  }
  return transitioned;
}
