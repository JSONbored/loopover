/** PURE — no IO, no Date, no random (#4827). Mirror of claim-ledger-expiry.js for the portfolio-queue store: a
 *  crashed/killed process leaves its item stuck 'in_progress' forever, so sweep leases older than a bound back to
 *  'queued'. */
import type { QueueEntry, QueueLeaseEntry } from "./portfolio-queue.js";
export declare const DEFAULT_MAX_LEASE_MS: number;
export type PortfolioQueueExpiryStore = {
    listInProgress(): QueueLeaseEntry[];
    reclaimStuckItem(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueEntry | null;
};
/**
 * Return in-flight items whose lease age is strictly greater than `maxLeaseMs`. An item whose age equals
 * `maxLeaseMs` exactly is still within the window (not stuck). Items that are not 'in_progress', or whose
 * `leasedAt` is missing/unparseable, are never returned.
 */
export declare function findStuckItems(items: QueueLeaseEntry[], nowMs: number, maxLeaseMs: number): QueueLeaseEntry[];
/**
 * Reclaim every stuck in-flight item back to 'queued', returning the reclaimed entries. `store.listInProgress()`
 * supplies the lease-annotated rows and `store.reclaimStuckItem()` performs the atomic per-item flip — the same
 * store/sweep split sweepExpiredClaims uses.
 */
export declare function sweepStuckItems(store: PortfolioQueueExpiryStore, nowMs: number, maxLeaseMs?: number): QueueEntry[];
