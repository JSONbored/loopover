import { countRecentDeadLetters } from "../db/repositories";

// Trailing window for the "is the DLQ dead-lettering right now?" gauge (#2083). Operators alert on the RATE of
// recent DLQ-consumer drops, which the cumulative `loopover_dlq_dead_lettered_total` counter and the point-in-time
// `loopover_queue_dead` depth gauge can't express on their own.
export const DLQ_RECENT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** ISO-8601 timestamp `windowMs` before `now` (default: current time). Pure given `now`; the injectable clock keeps
 *  the window math deterministic in tests, and matches the ISO-compare convention used by the queue reliability work. */
export function isoNowMinus(windowMs: number, now: number = Date.now()): string {
  return new Date(now - windowMs).toISOString();
}

/** The subset of DurableQueue (backend-contracts.ts) this gauge needs -- avoids importing the full interface
 *  (and its Queue/D1-shaped siblings) into a module whose only job is one scrape-time count. */
export type RecentDeadCountSource = { recentDeadCount(windowMs: number): Promise<number> };

/** Scrape-time sample of DLQ dead-letters within the trailing window. Swallows a query error so a transient DB
 *  hiccup degrades the sample to 0 rather than rejecting and breaking the whole `/metrics` scrape.
 *
 *  `selfHostQueue` (#9139), when provided, is used EXCLUSIVELY instead of the `audit_events`-based cloud-worker
 *  path: `github_app.dlq_dead_lettered` is written only by `processDlqBatch` (src/queue/dlq.ts), reached only
 *  from the Cloudflare `queue()` handler (src/index.ts) -- server.ts (the self-host runtime) calls
 *  `worker.fetch`/`worker.scheduled` but never `worker.queue`, so that source is a structural, permanent 0 on
 *  every self-hosted instance regardless of how many jobs actually dead-letter. The self-host queue backends
 *  (sqlite-queue.ts / pg-queue.ts) dead-letter via `UPDATE ... SET status='dead'` on their own jobs table
 *  instead (see pg-queue.ts's dead-letter path) -- `recentDeadCount` reads that directly. */
export async function sampleRecentDeadLetters(env: Env, now: number = Date.now(), selfHostQueue?: RecentDeadCountSource): Promise<number> {
  try {
    if (selfHostQueue) return await selfHostQueue.recentDeadCount(DLQ_RECENT_WINDOW_MS);
    return await countRecentDeadLetters(env, isoNowMinus(DLQ_RECENT_WINDOW_MS, now));
  } catch {
    return 0;
  }
}
