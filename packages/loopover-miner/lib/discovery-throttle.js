// Dynamic discovery back-off (#4844): the fanout already records GitHub's `x-ratelimit-remaining`, but nothing
// slowed its own concurrent fetching in response — a `discover` run could sprint at full concurrency straight
// into a 403. This pure helper maps the recorded remaining budget to an allowed in-flight concurrency so the
// fanout tapers off as the budget approaches zero. It only decides *how many* requests may run; it never changes
// which docs are fetched or how a policy verdict is derived from them.
/** At or below this remaining budget, serialize discovery to a single in-flight request. */
export const DEFAULT_RATE_LIMIT_LOW_WATER_MARK = 50;
/** At or above this remaining budget, run at the full configured concurrency. */
export const DEFAULT_RATE_LIMIT_HIGH_WATER_MARK = 250;
/**
 * Resolve the concurrency the fanout may run at for the currently-recorded rate-limit budget. Returns an integer
 * in `[1, baseConcurrency]`:
 *  - an unknown budget (`null`/non-finite — nothing recorded yet) runs at full `baseConcurrency`;
 *  - at or below `lowWaterMark` it clamps to a single in-flight request;
 *  - at or above `highWaterMark` it runs at full `baseConcurrency`;
 *  - in between it scales linearly with the remaining fraction of the low→high band.
 */
export function resolveThrottledConcurrency(baseConcurrency, rateLimitRemaining, lowWaterMark, highWaterMark) {
    if (!Number.isFinite(rateLimitRemaining))
        return baseConcurrency;
    if (rateLimitRemaining <= lowWaterMark)
        return 1;
    if (rateLimitRemaining >= highWaterMark)
        return baseConcurrency;
    // remaining is strictly inside the (low, high) band, so the fraction is in (0, 1) and the ceil lands in
    // [1, baseConcurrency] without any further clamping.
    const fraction = (rateLimitRemaining - lowWaterMark) / (highWaterMark - lowWaterMark);
    return Math.ceil(fraction * baseConcurrency);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGlzY292ZXJ5LXRocm90dGxlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZGlzY292ZXJ5LXRocm90dGxlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLCtHQUErRztBQUMvRyw4R0FBOEc7QUFDOUcsNkdBQTZHO0FBQzdHLGlIQUFpSDtBQUNqSCx1RUFBdUU7QUFFdkUsNEZBQTRGO0FBQzVGLE1BQU0sQ0FBQyxNQUFNLGlDQUFpQyxHQUFHLEVBQUUsQ0FBQztBQUNwRCxpRkFBaUY7QUFDakYsTUFBTSxDQUFDLE1BQU0sa0NBQWtDLEdBQUcsR0FBRyxDQUFDO0FBRXREOzs7Ozs7O0dBT0c7QUFDSCxNQUFNLFVBQVUsMkJBQTJCLENBQ3pDLGVBQXVCLEVBQ3ZCLGtCQUFpQyxFQUNqQyxZQUFvQixFQUNwQixhQUFxQjtJQUVyQixJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxrQkFBa0IsQ0FBQztRQUFFLE9BQU8sZUFBZSxDQUFDO0lBQ2pFLElBQUksa0JBQW1CLElBQUksWUFBWTtRQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ2xELElBQUksa0JBQW1CLElBQUksYUFBYTtRQUFFLE9BQU8sZUFBZSxDQUFDO0lBQ2pFLHdHQUF3RztJQUN4RyxxREFBcUQ7SUFDckQsTUFBTSxRQUFRLEdBQUcsQ0FBQyxrQkFBbUIsR0FBRyxZQUFZLENBQUMsR0FBRyxDQUFDLGFBQWEsR0FBRyxZQUFZLENBQUMsQ0FBQztJQUN2RixPQUFPLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxHQUFHLGVBQWUsQ0FBQyxDQUFDO0FBQy9DLENBQUMifQ==