// Bounded retry-with-backoff around a single HTTP call (#4829). The miner's pollers (ci-poller and others)
// previously let a single brief 5xx from GitHub kill the whole poll loop, because their own attempt loop
// only re-polls while a conclusion is genuinely "pending", never after a server error. This wraps ONE fetch so a
// transient SERVER error (a 5xx RESPONSE) is retried a bounded number of times, DISTINCT from that pending-
// polling, sleeping an exponential backoff between attempts and giving up after `maxAttempts`. A 2xx/3xx/4xx
// response is returned immediately, and a THROWN error (a network-level failure) propagates unchanged rather than
// being retried — the pollers' existing failure-mode contract (#4281) deliberately bubbles those to the caller.
// Pure control flow over injected `fetchFn`/`sleepFn`/`backoffMs` — no real network or timers in tests.

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/** Clamp `maxAttempts` to a positive integer, flooring BEFORE the positivity test so a fractional value below 1
 *  falls back to the default rather than becoming a 0 that would skip every attempt. */
function normalizeMaxAttempts(raw) {
  const numeric = Math.floor(Number(raw));
  return Number.isFinite(numeric) && numeric >= 1 ? numeric : DEFAULT_MAX_ATTEMPTS;
}

/** Exponential backoff from a base delay, capped: attempt 1 → base, 2 → 2×base, 3 → 4×base, … ≤ MAX_BACKOFF_MS. */
export function defaultRetryBackoffMs(attempt) {
  return Math.min(MAX_BACKOFF_MS, DEFAULT_BASE_BACKOFF_MS * 2 ** (Math.max(1, attempt) - 1));
}

const defaultSleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

/**
 * Perform `fetchFn(url, init)` with bounded retry on a transient 5xx response. A 5xx is retried (sleeping
 * `backoffMs(attempt)` between attempts) up to `maxAttempts`; a 2xx/3xx/4xx response is returned immediately, and
 * after the last attempt a lingering 5xx is returned as-is (the caller's own error handling still runs). A THROWN
 * error is NOT retried — it propagates to the caller (the pollers' #4281 failure-mode contract).
 *
 * @param {(url: any, init?: any) => Promise<any>} fetchFn
 * @param {any} url
 * @param {any} [init]
 * @param {{ maxAttempts?: number, sleepFn?: (ms: number) => Promise<unknown>, backoffMs?: (attempt: number) => number }} [options]
 * @returns {Promise<any>} the fetch response
 */
export async function fetchWithRetry(fetchFn, url, init, options = {}) {
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
  const sleepFn = typeof options.sleepFn === "function" ? options.sleepFn : defaultSleep;
  const backoffMs = typeof options.backoffMs === "function" ? options.backoffMs : defaultRetryBackoffMs;
  for (let attempt = 1; ; attempt += 1) {
    // A thrown error is intentionally NOT caught here — it propagates to the caller unchanged.
    const response = await fetchFn(url, init);
    // Retry only transient SERVER errors (5xx). Return 2xx/3xx/4xx immediately; on the final attempt a lingering
    // 5xx is returned as-is.
    if (response.status < 500 || attempt >= maxAttempts) return response;
    await sleepFn(backoffMs(attempt));
  }
}
