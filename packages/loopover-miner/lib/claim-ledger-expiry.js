/** PURE — no IO, no Date, no random (#2316). */
export const DEFAULT_MAX_CLAIM_AGE_MS = 14 * 24 * 60 * 60 * 1000;
function claimAgeMs(claim, nowMs) {
    const claimedAtMs = Date.parse(claim.claimedAt);
    if (!Number.isFinite(claimedAtMs))
        return null;
    return nowMs - claimedAtMs;
}
/**
 * Return active claims whose age is strictly greater than `maxAgeMs`. A claim whose age equals `maxAgeMs` exactly
 * is still considered within the window (not expired).
 */
export function findExpiredClaims(claims, nowMs, maxAgeMs) {
    if (!Number.isFinite(nowMs) || nowMs < 0)
        throw new Error("invalid_now_ms");
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)
        throw new Error("invalid_max_age_ms");
    if (!Array.isArray(claims))
        throw new Error("invalid_claims");
    const expired = [];
    for (const claim of claims) {
        if (claim?.status !== "active")
            continue;
        const ageMs = claimAgeMs(claim, nowMs);
        if (ageMs === null)
            continue;
        if (ageMs > maxAgeMs)
            expired.push(claim);
    }
    return expired;
}
export function sweepExpiredClaims(store, nowMs, maxAgeMs = DEFAULT_MAX_CLAIM_AGE_MS) {
    const activeClaims = store.listClaims({ status: "active" });
    const expired = findExpiredClaims(activeClaims, nowMs, maxAgeMs);
    const transitioned = [];
    for (const claim of expired) {
        // Echo the row's OWN apiBaseUrl back (#5563) rather than defaulting: two forge hosts can each have an
        // active claim on the same owner/repo#issue, and defaulting here would expire the wrong host's row.
        const updated = store.expireClaim(claim.repoFullName, claim.issueNumber, claim.apiBaseUrl);
        if (updated)
            transitioned.push(updated);
    }
    return transitioned;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xhaW0tbGVkZ2VyLWV4cGlyeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNsYWltLWxlZGdlci1leHBpcnkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsZ0RBQWdEO0FBSWhELE1BQU0sQ0FBQyxNQUFNLHdCQUF3QixHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFPakUsU0FBUyxVQUFVLENBQUMsS0FBaUIsRUFBRSxLQUFhO0lBQ2xELE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ2hELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQy9DLE9BQU8sS0FBSyxHQUFHLFdBQVcsQ0FBQztBQUM3QixDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLGlCQUFpQixDQUFDLE1BQW9CLEVBQUUsS0FBYSxFQUFFLFFBQWdCO0lBQ3JGLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRyxDQUFDO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO0lBQzVFLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxJQUFJLFFBQVEsR0FBRyxDQUFDO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO0lBQ3RGLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztJQUU5RCxNQUFNLE9BQU8sR0FBaUIsRUFBRSxDQUFDO0lBQ2pDLEtBQUssTUFBTSxLQUFLLElBQUksTUFBTSxFQUFFLENBQUM7UUFDM0IsSUFBSSxLQUFLLEVBQUUsTUFBTSxLQUFLLFFBQVE7WUFBRSxTQUFTO1FBQ3pDLE1BQU0sS0FBSyxHQUFHLFVBQVUsQ0FBQyxLQUFLLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDdkMsSUFBSSxLQUFLLEtBQUssSUFBSTtZQUFFLFNBQVM7UUFDN0IsSUFBSSxLQUFLLEdBQUcsUUFBUTtZQUFFLE9BQU8sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDNUMsQ0FBQztJQUNELE9BQU8sT0FBTyxDQUFDO0FBQ2pCLENBQUM7QUFFRCxNQUFNLFVBQVUsa0JBQWtCLENBQ2hDLEtBQTZCLEVBQzdCLEtBQWEsRUFDYixXQUFtQix3QkFBd0I7SUFFM0MsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLFVBQVUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsQ0FBQyxDQUFDO0lBQzVELE1BQU0sT0FBTyxHQUFHLGlCQUFpQixDQUFDLFlBQVksRUFBRSxLQUFLLEVBQUUsUUFBUSxDQUFDLENBQUM7SUFDakUsTUFBTSxZQUFZLEdBQWlCLEVBQUUsQ0FBQztJQUN0QyxLQUFLLE1BQU0sS0FBSyxJQUFJLE9BQU8sRUFBRSxDQUFDO1FBQzVCLHNHQUFzRztRQUN0RyxvR0FBb0c7UUFDcEcsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLFdBQVcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUFFLEtBQUssQ0FBQyxXQUFXLEVBQUUsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQzNGLElBQUksT0FBTztZQUFFLFlBQVksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDMUMsQ0FBQztJQUNELE9BQU8sWUFBWSxDQUFDO0FBQ3RCLENBQUMifQ==