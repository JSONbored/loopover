import { useCallback, useEffect, useRef, useState } from "react";

/** Shared "live refresh" cadence for the local, offline dev-server API views (#4856) — frequent enough to feel
 *  live for a cheap local SQLite read, without polling so tightly it's wasteful. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** What {@link usePolledFetch} returns: the latest fetched value, plus an imperative `refresh` (#7230). */
export type PolledFetch<T> = {
  /** Latest fetched value, or `null` until the first fetch resolves. */
  result: T | null;
  /** Fetch once now, additively — without tearing down or re-arming the periodic timer. Skipped while a fetch
   *  is already in flight (same overlap guard as a scheduled tick). */
  refresh: () => void;
};

/**
 * Fetch once on mount, then re-fetch on a fixed interval so newly-recorded local activity appears without a
 * manual page reload (#4856). Skips overlapping ticks: if a fetch from a previous tick is still in flight when
 * the next interval fires, that tick is a no-op rather than stacking concurrent requests.
 *
 * The returned `refresh()` performs an immediate, additive fetch that does NOT reset the interval schedule
 * (#7230): a caller that wants its own action reflected right away calls `refresh()` instead of perturbing
 * `loadFn`'s identity, so the periodic cadence stays on its original clock. `loadFn` is read through a ref so a
 * changed `loadFn` identity likewise never re-arms the timer — the next scheduled tick just uses the latest one.
 */
export function usePolledFetch<T>(loadFn: () => Promise<T>, intervalMs: number): PolledFetch<T> {
  const [result, setResult] = useState<T | null>(null);
  // Latest loadFn, read by `refresh` without being an effect dependency — so a new loadFn identity never tears
  // down and re-arms the interval (the #7230 root cause when a caller changed loadFn to force an extra fetch).
  // Synced in an effect (not during render) so refresh always calls the current loadFn; refresh only ever runs
  // from an event handler or a scheduled tick, both of which happen after this sync effect has committed.
  const loadFnRef = useRef(loadFn);
  const inFlightRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    loadFnRef.current = loadFn;
  }, [loadFn]);

  const refresh = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    void loadFnRef
      .current()
      .then((loaded) => {
        if (!cancelledRef.current) setResult(loaded);
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    const id = window.setInterval(refresh, intervalMs);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(id);
    };
  }, [refresh, intervalMs]);

  return { result, refresh };
}
