import { useEffect, useState } from "react";

/** Shared "live refresh" cadence for the local, offline dev-server API views (#4856) — frequent enough to feel
 *  live for a cheap local SQLite read, without polling so tightly it's wasteful. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

/**
 * Fetch once on mount, then re-fetch on a fixed interval so newly-recorded local activity appears without a
 * manual page reload (#4856). Skips overlapping ticks: if a fetch from a previous tick is still in flight when
 * the next interval fires, that tick is a no-op rather than stacking concurrent requests.
 */
export function usePolledFetch<T>(loadFn: () => Promise<T>, intervalMs: number): T | null {
  const [result, setResult] = useState<T | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const run = () => {
      if (inFlight) return;
      inFlight = true;
      void loadFn()
        .then((loaded) => {
          if (!cancelled) setResult(loaded);
        })
        .finally(() => {
          inFlight = false;
        });
    };

    run();
    const id = window.setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [loadFn, intervalMs]);

  return result;
}
