/** At or below this remaining budget, serialize discovery to a single in-flight request. */
export declare const DEFAULT_RATE_LIMIT_LOW_WATER_MARK = 50;
/** At or above this remaining budget, run at the full configured concurrency. */
export declare const DEFAULT_RATE_LIMIT_HIGH_WATER_MARK = 250;
/**
 * Resolve the concurrency the fanout may run at for the currently-recorded rate-limit budget. Returns an integer
 * in `[1, baseConcurrency]`:
 *  - an unknown budget (`null`/non-finite — nothing recorded yet) runs at full `baseConcurrency`;
 *  - at or below `lowWaterMark` it clamps to a single in-flight request;
 *  - at or above `highWaterMark` it runs at full `baseConcurrency`;
 *  - in between it scales linearly with the remaining fraction of the low→high band.
 */
export declare function resolveThrottledConcurrency(baseConcurrency: number, rateLimitRemaining: number | null, lowWaterMark: number, highWaterMark: number): number;
