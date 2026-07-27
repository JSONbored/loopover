// #9157: the floor below which CRON_INTERVAL_MS is rejected rather than honored. A malformed value (a unit
// suffix like "2m"/"120s", a numeric separator like "120_000", or outright garbage) parses to NaN, and Node
// coerces BOTH `setTimeout(fn, NaN)` and `setInterval(fn, NaN)` to a 1ms delay — turning a single operator typo
// into ~1000 scheduled ticks/second instead of one every two minutes, each running the full worker.scheduled()
// fan-out. 0 takes the identical path (`x % 0` is NaN) and is NOT treated as "disable the cron" — there is no
// supported way to run this entrypoint without its maintenance cron, so 0 is just another invalid value, not a
// meaningful opt-out. Shared by preflight.ts (boot-time hard failure) and server.ts (runtime defense-in-depth
// clamp via parsePositiveIntEnv) so the two enforce the exact same floor.
export const CRON_INTERVAL_MIN_MS = 10_000; // 10s — comfortably above any accidental near-zero value, well under the 120s default

/** Milliseconds from `nowMs` until the next wall-clock boundary of `intervalMs`, so a self-host `setTimeout`
 *  can phase-align its first tick to the same instants Cloudflare's own cron trigger would fire on (e.g. the
 *  every-2-minutes trigger fires exactly at :00, :02, :04, … UTC). Computed against epoch -- itself minute-aligned --
 *  rather than the caller's own boot time, since `nowMs % intervalMs` only lands on true minute boundaries
 *  (matching what `enqueueScheduledJobs`'s `getUTCMinutes()`-based gates check) when measured from a fixed,
 *  minute-aligned origin; measuring from an arbitrary boot moment would just reproduce the exact bug this
 *  exists to fix (see server.ts's cron setup). Exactly on a boundary already (`nowMs % intervalMs === 0`)
 *  waits a FULL intervalMs rather than firing immediately, matching `setInterval`'s own "no immediate first
 *  fire" semantics the caller is replacing. */
export function delayToNextWallClockBoundaryMs(nowMs: number, intervalMs: number): number {
  const msIntoCycle = nowMs % intervalMs;
  return msIntoCycle === 0 ? intervalMs : intervalMs - msIntoCycle;
}
