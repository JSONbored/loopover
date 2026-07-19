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
export function resolveThrottledConcurrency(
  baseConcurrency: number,
  rateLimitRemaining: number | null,
  lowWaterMark: number,
  highWaterMark: number,
): number {
  if (!Number.isFinite(rateLimitRemaining)) return baseConcurrency;
  // Finite past the guard above (null/NaN already returned); the cast narrows `number | null` without adding a
  // second runtime branch, keeping this byte-for-byte the single-branch shape the .js had.
  const remaining = rateLimitRemaining as number;
  if (remaining <= lowWaterMark) return 1;
  if (remaining >= highWaterMark) return baseConcurrency;
  // remaining is strictly inside the (low, high) band, so the fraction is in (0, 1) and the ceil lands in
  // [1, baseConcurrency] without any further clamping.
  const fraction = (remaining - lowWaterMark) / (highWaterMark - lowWaterMark);
  return Math.ceil(fraction * baseConcurrency);
}
