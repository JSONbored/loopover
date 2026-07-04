import { countRecentDeadLetters } from "../db/repositories";

// Trailing window for the "is the DLQ dead-lettering right now?" gauge (#2083). Operators alert on the RATE of
// recent DLQ-consumer drops, which the cumulative `gittensory_dlq_dead_lettered_total` counter and the point-in-time
// `gittensory_queue_dead` depth gauge can't express on their own.
export const DLQ_RECENT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** ISO-8601 timestamp `windowMs` before `now` (default: current time). Pure given `now`; the injectable clock keeps
 *  the window math deterministic in tests, and matches the ISO-compare convention used by the queue reliability work. */
export function isoNowMinus(windowMs: number, now: number = Date.now()): string {
  return new Date(now - windowMs).toISOString();
}

/** Scrape-time sample of DLQ dead-letters within the trailing window. Swallows a query error so a transient DB
 *  hiccup degrades the sample to 0 rather than rejecting and breaking the whole `/metrics` scrape. */
export async function sampleRecentDeadLetters(env: Env, now: number = Date.now()): Promise<number> {
  try {
    return await countRecentDeadLetters(env, isoNowMinus(DLQ_RECENT_WINDOW_MS, now));
  } catch {
    return 0;
  }
}
