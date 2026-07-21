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
 * is still considered within the window (not expired). A claim with an unparseable `claimedAt` (null age) is swept
 * (fail-closed, #7732) rather than left permanently un-expirable.
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
        // An unparseable claimedAt yields a null age. Fail closed and sweep it (#7732): claimedAt is always written via
        // new Date().toISOString(), so a null age only reaches a corrupted/hand-edited row, which must not stay stuck
        // active forever — matching this file's fail-closed posture toward unusable rows.
        if (ageMs === null || ageMs > maxAgeMs)
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xhaW0tbGVkZ2VyLWV4cGlyeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNsYWltLWxlZGdlci1leHBpcnkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsZ0RBQWdEO0FBSWhELE1BQU0sQ0FBQyxNQUFNLHdCQUF3QixHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFPakUsU0FBUyxVQUFVLENBQUMsS0FBaUIsRUFBRSxLQUFhO0lBQ2xELE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ2hELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQy9DLE9BQU8sS0FBSyxHQUFHLFdBQVcsQ0FBQztBQUM3QixDQUFDO0FBRUQ7Ozs7R0FJRztBQUNILE1BQU0sVUFBVSxpQkFBaUIsQ0FBQyxNQUFvQixFQUFFLEtBQWEsRUFBRSxRQUFnQjtJQUNyRixJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUcsQ0FBQztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztJQUM1RSxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsSUFBSSxRQUFRLEdBQUcsQ0FBQztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsb0JBQW9CLENBQUMsQ0FBQztJQUN0RixJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUM7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLGdCQUFnQixDQUFDLENBQUM7SUFFOUQsTUFBTSxPQUFPLEdBQWlCLEVBQUUsQ0FBQztJQUNqQyxLQUFLLE1BQU0sS0FBSyxJQUFJLE1BQU0sRUFBRSxDQUFDO1FBQzNCLElBQUksS0FBSyxFQUFFLE1BQU0sS0FBSyxRQUFRO1lBQUUsU0FBUztRQUN6QyxNQUFNLEtBQUssR0FBRyxVQUFVLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3ZDLGdIQUFnSDtRQUNoSCw4R0FBOEc7UUFDOUcsa0ZBQWtGO1FBQ2xGLElBQUksS0FBSyxLQUFLLElBQUksSUFBSSxLQUFLLEdBQUcsUUFBUTtZQUFFLE9BQU8sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDOUQsQ0FBQztJQUNELE9BQU8sT0FBTyxDQUFDO0FBQ2pCLENBQUM7QUFFRCxNQUFNLFVBQVUsa0JBQWtCLENBQ2hDLEtBQTZCLEVBQzdCLEtBQWEsRUFDYixXQUFtQix3QkFBd0I7SUFFM0MsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLFVBQVUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsQ0FBQyxDQUFDO0lBQzVELE1BQU0sT0FBTyxHQUFHLGlCQUFpQixDQUFDLFlBQVksRUFBRSxLQUFLLEVBQUUsUUFBUSxDQUFDLENBQUM7SUFDakUsTUFBTSxZQUFZLEdBQWlCLEVBQUUsQ0FBQztJQUN0QyxLQUFLLE1BQU0sS0FBSyxJQUFJLE9BQU8sRUFBRSxDQUFDO1FBQzVCLHNHQUFzRztRQUN0RyxvR0FBb0c7UUFDcEcsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLFdBQVcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUFFLEtBQUssQ0FBQyxXQUFXLEVBQUUsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQzNGLElBQUksT0FBTztZQUFFLFlBQVksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDMUMsQ0FBQztJQUNELE9BQU8sWUFBWSxDQUFDO0FBQ3RCLENBQUMifQ==