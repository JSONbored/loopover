import type { QueueEntry, QueueLeaseEntry } from "./portfolio-queue.js";

/** PURE — no IO, no Date, no random (#4827). Mirror of claim-ledger-expiry.js for the portfolio-queue store: a
 *  crashed/killed process leaves its item stuck 'in_progress' forever, so sweep leases older than a bound back to
 *  'queued'. */

// A generous default: a real attempt rarely holds a single portfolio item for long, so 30 minutes without the row
// leaving 'in_progress' strongly implies the owning process died rather than that it is still working.
export const DEFAULT_MAX_LEASE_MS = 30 * 60 * 1000;

export type PortfolioQueueExpiryStore = {
  listInProgress(): QueueLeaseEntry[];
  reclaimStuckItem(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueEntry | null;
};

function leaseAgeMs(item: QueueLeaseEntry, nowMs: number): number | null {
  // A null leasedAt parses to NaN here (Date.parse coerces it) and is caught by the finite check below, exactly
  // as the .js relied on — the cast avoids adding a separate null branch the tests don't exercise.
  const leasedAtMs = Date.parse(item.leasedAt as string);
  if (!Number.isFinite(leasedAtMs)) return null;
  return nowMs - leasedAtMs;
}

/**
 * Return in-flight items whose lease age is strictly greater than `maxLeaseMs`. An item whose age equals
 * `maxLeaseMs` exactly is still within the window (not stuck). Items that are not 'in_progress', or whose
 * `leasedAt` is missing/unparseable, are never returned.
 */
export function findStuckItems(items: QueueLeaseEntry[], nowMs: number, maxLeaseMs: number): QueueLeaseEntry[] {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error("invalid_now_ms");
  if (!Number.isFinite(maxLeaseMs) || maxLeaseMs < 0) throw new Error("invalid_max_lease_ms");
  if (!Array.isArray(items)) throw new Error("invalid_items");

  const stuck: QueueLeaseEntry[] = [];
  for (const item of items) {
    if (item?.status !== "in_progress") continue;
    const ageMs = leaseAgeMs(item, nowMs);
    if (ageMs === null) continue;
    if (ageMs > maxLeaseMs) stuck.push(item);
  }
  return stuck;
}

/**
 * Reclaim every stuck in-flight item back to 'queued', returning the reclaimed entries. `store.listInProgress()`
 * supplies the lease-annotated rows and `store.reclaimStuckItem()` performs the atomic per-item flip — the same
 * store/sweep split sweepExpiredClaims uses.
 */
export function sweepStuckItems(store: PortfolioQueueExpiryStore, nowMs: number, maxLeaseMs = DEFAULT_MAX_LEASE_MS): QueueEntry[] {
  const inProgress = store.listInProgress();
  const stuck = findStuckItems(inProgress, nowMs, maxLeaseMs);
  const reclaimed: QueueEntry[] = [];
  for (const item of stuck) {
    // Echo the item's OWN apiBaseUrl back (#5563) rather than defaulting: two forge hosts can each have an
    // in-flight item with the same owner/repo+identifier, and defaulting here would reclaim the wrong host's row.
    const updated = store.reclaimStuckItem(item.repoFullName, item.identifier, item.apiBaseUrl);
    if (updated) reclaimed.push(updated);
  }
  return reclaimed;
}
