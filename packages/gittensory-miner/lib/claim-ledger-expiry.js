/** PURE — no IO, no Date, no random (#2316). */

export const DEFAULT_MAX_CLAIM_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function claimAgeMs(claim, nowMs) {
  const claimedAtMs = Date.parse(claim.claimedAt);
  if (!Number.isFinite(claimedAtMs)) return null;
  return nowMs - claimedAtMs;
}

/**
 * Return active claims whose age is strictly greater than `maxAgeMs`. A claim whose age equals `maxAgeMs` exactly
 * is still considered within the window (not expired).
 */
export function findExpiredClaims(claims, nowMs, maxAgeMs) {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error("invalid_now_ms");
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error("invalid_max_age_ms");
  if (!Array.isArray(claims)) throw new Error("invalid_claims");

  const expired = [];
  for (const claim of claims) {
    if (claim?.status !== "active") continue;
    const ageMs = claimAgeMs(claim, nowMs);
    if (ageMs === null) continue;
    if (ageMs > maxAgeMs) expired.push(claim);
  }
  return expired;
}

export function sweepExpiredClaims(store, nowMs, maxAgeMs = DEFAULT_MAX_CLAIM_AGE_MS) {
  const activeClaims = store.listClaims({ status: "active" });
  const expired = findExpiredClaims(activeClaims, nowMs, maxAgeMs);
  const transitioned = [];
  for (const claim of expired) {
    const updated = store.expireClaim(claim.repoFullName, claim.issueNumber);
    if (updated) transitioned.push(updated);
  }
  return transitioned;
}
