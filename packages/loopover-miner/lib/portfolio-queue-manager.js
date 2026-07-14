// Stateful PortfolioQueueManager (#4285): compose the persisted SQLite portfolio/queue store
// (portfolio-queue.js, #2292) with the pure engine selector (nextEligibleItems, queue.ts, #2326) so batch
// claiming respects global/per-repo WIP caps and cross-repo diversification instead of a naive priority-only
// single-row dequeue. Caps are plain constructor arguments — not wired to .loopover-miner.yml here.
import { nextEligibleItems } from "@loopover/engine";
import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { DEFAULT_MAX_LEASE_MS, sweepStuckItems } from "./portfolio-queue-expiry.js";

const ITEM_ID_SEPARATOR = "::";

/**
 * Stable composite id for projecting SQLite rows into the engine's PortfolioQueueItem shape. Encodes apiBaseUrl
 * too (#5563) — the engine's own selection logic has no forge dimension, but two hosts can now enqueue an item
 * under the same repoFullName+identifier (post-#5563 scoping), and the id is the ONLY thing selectEligibleBatch's
 * output threads back to batchClaim; without the host baked in here, a selected item's host would be lost and
 * batchClaim would default to github.com, potentially claiming a DIFFERENT row than the one the engine selected.
 */
export function queueItemId(apiBaseUrl, repoFullName, identifier) {
  return `${apiBaseUrl}${ITEM_ID_SEPARATOR}${repoFullName}${ITEM_ID_SEPARATOR}${identifier}`;
}

/** Reverse {@link queueItemId} after engine selection so claims can target SQLite primary keys. */
export function parseQueueItemId(id) {
  if (typeof id !== "string") throw new Error("invalid_queue_item_id");
  const firstSeparatorIndex = id.indexOf(ITEM_ID_SEPARATOR);
  if (firstSeparatorIndex <= 0) throw new Error("invalid_queue_item_id");
  const rest = id.slice(firstSeparatorIndex + ITEM_ID_SEPARATOR.length);
  const secondSeparatorIndex = rest.indexOf(ITEM_ID_SEPARATOR);
  if (secondSeparatorIndex <= 0 || secondSeparatorIndex === rest.length - ITEM_ID_SEPARATOR.length) {
    throw new Error("invalid_queue_item_id");
  }
  return {
    apiBaseUrl: id.slice(0, firstSeparatorIndex),
    repoFullName: rest.slice(0, secondSeparatorIndex),
    identifier: rest.slice(secondSeparatorIndex + ITEM_ID_SEPARATOR.length),
  };
}

/** Coerce caps to finite non-negative integers (mirrors the engine's normalizeCaps posture). */
export function normalizePortfolioCaps(caps = {}) {
  const globalWipCap = Number.isFinite(caps.globalWipCap) ? Math.max(0, Math.trunc(caps.globalWipCap)) : 0;
  const perRepoWipCap = Number.isFinite(caps.perRepoWipCap) ? Math.max(0, Math.trunc(caps.perRepoWipCap)) : 0;
  return { globalWipCap, perRepoWipCap };
}

/** Project persisted queue rows into the engine's in-memory PortfolioQueue (done rows omitted). Pure. */
export function entriesToPortfolioQueue(entries) {
  const activeEntries = Array.isArray(entries) ? entries.filter((entry) => entry?.status !== "done") : [];
  const bucketsByRepo = new Map();
  const bucketOrder = [];
  for (const entry of activeEntries) {
    const repoFullName = typeof entry.repoFullName === "string" ? entry.repoFullName.trim() : "";
    const identifier = typeof entry.identifier === "string" ? entry.identifier.trim() : "";
    if (!repoFullName || !identifier) continue;
    // Falls back to the github.com default (matching every store's own normalizeApiBaseUrl) so a row from
    // before #5563 threaded apiBaseUrl through this fold still gets a valid, host-scoped id.
    const apiBaseUrl = typeof entry.apiBaseUrl === "string" && entry.apiBaseUrl.trim() ? entry.apiBaseUrl.trim() : DEFAULT_FORGE_CONFIG.apiBaseUrl;
    const repoKey = repoFullName.toLowerCase();
    if (!bucketsByRepo.has(repoKey)) {
      bucketsByRepo.set(repoKey, []);
      bucketOrder.push(repoKey);
    }
    bucketsByRepo.get(repoKey).push({
      id: queueItemId(apiBaseUrl, repoFullName, identifier),
      repoFullName,
      state: entry.status === "in_progress" ? "in_progress" : "queued",
    });
  }
  return {
    buckets: bucketOrder.map((repoFullName) => ({
      repoFullName,
      items: bucketsByRepo.get(repoFullName),
    })),
  };
}

/** Select the next eligible batch from active rows using the engine primitive. Pure. */
export function selectEligibleBatch(entries, caps) {
  const normalizedCaps = normalizePortfolioCaps(caps);
  const queue = entriesToPortfolioQueue(entries);
  return nextEligibleItems(queue, normalizedCaps).map((item) => parseQueueItemId(item.id));
}

/**
 * Open a caps-aware portfolio queue manager backed by the local SQLite store. The existing single-row
 * `dequeueNext()` CLI surface is untouched — this adds `claimNextBatch()` for fleet-style batch claiming.
 */
export function initPortfolioQueueManager(options = {}) {
  const caps = normalizePortfolioCaps(options.caps ?? { globalWipCap: 1, perRepoWipCap: 1 });
  const store = options.store ?? initPortfolioQueueStore(options.dbPath);
  // A lease older than this means the process that claimed the item almost certainly died; the item is swept back
  // to 'queued' so it no longer occupies WIP capacity forever (#4827).
  const staleLeaseMs = Number.isFinite(options.staleLeaseMs) ? options.staleLeaseMs : DEFAULT_MAX_LEASE_MS;

  return {
    caps,
    store,
    dbPath: store.dbPath,
    enqueue(item) {
      return store.enqueue(item);
    },
    listQueue(repoFullName) {
      return store.listQueue(repoFullName);
    },
    markDone(repoFullName, identifier, apiBaseUrl) {
      return store.markDone(repoFullName, identifier, apiBaseUrl);
    },
    markFailed(repoFullName, identifier, apiBaseUrl) {
      return store.markFailed(repoFullName, identifier, apiBaseUrl);
    },
    /** Sweep leases orphaned by a crashed/killed process back to 'queued', returning the reclaimed items (#4827). */
    reclaimStuckItems(maxLeaseMs = staleLeaseMs) {
      return sweepStuckItems(store, Date.now(), maxLeaseMs);
    },
    // The engine primitive itself (@loopover/engine's nextEligibleItems) has no apiBaseUrl concept --
    // it only ever sees the opaque `id` string. queueItemId/parseQueueItemId (#5563) smuggle the host through
    // that id round-trip, so selectFn's output below correctly carries each selected item's OWN apiBaseUrl into
    // batchClaim, instead of every claim defaulting to github.com regardless of which host's row was selected.
    claimNextBatch() {
      // Reclaim orphaned leases first, so an item stranded 'in_progress' by a dead process becomes eligible again
      // instead of permanently consuming a WIP slot and starving the queue.
      sweepStuckItems(store, Date.now(), staleLeaseMs);
      return store.batchClaim((entries) => selectEligibleBatch(entries, caps));
    },
    close() {
      store.close();
    },
  };
}

export function closeDefaultPortfolioQueueManager() {
  // Reserved for symmetry with other miner stores; managers are opened explicitly today.
}
