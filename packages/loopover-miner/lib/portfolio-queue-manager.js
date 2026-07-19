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
  const lastSeparatorIndex = id.lastIndexOf(ITEM_ID_SEPARATOR);
  if (lastSeparatorIndex <= 0) throw new Error("invalid_queue_item_id");
  const identifier = id.slice(lastSeparatorIndex + ITEM_ID_SEPARATOR.length);
  if (!identifier) throw new Error("invalid_queue_item_id");
  const beforeIdentifier = id.slice(0, lastSeparatorIndex);
  const secondLastSeparatorIndex = beforeIdentifier.lastIndexOf(ITEM_ID_SEPARATOR);
  if (secondLastSeparatorIndex <= 0) throw new Error("invalid_queue_item_id");
  const repoFullName = beforeIdentifier.slice(secondLastSeparatorIndex + ITEM_ID_SEPARATOR.length);
  if (!repoFullName) throw new Error("invalid_queue_item_id");
  const apiBaseUrl = beforeIdentifier.slice(0, secondLastSeparatorIndex);
  if (!apiBaseUrl) throw new Error("invalid_queue_item_id");
  return { apiBaseUrl, repoFullName, identifier };
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
    // Host-qualify the engine's per-repo WIP grouping key (#7224). nextEligibleItems groups its per-repo cap by each
    // item's `repoFullName`, which it treats as an OPAQUE string -- the engine has no apiBaseUrl concept, the host is
    // smuggled through the opaque `id` (queueItemId, #5563). The store keys rows by apiBaseUrl too, so two forge
    // hosts' same-named repos are distinct backlogs; without qualifying the grouping key by host here, a per-repo cap
    // was shared across them (e.g. perRepoWipCap: 1 let only ONE host's backlog advance). The `id` still carries the
    // TRUE repoFullName and selectEligibleBatch maps results back via parseQueueItemId(id), so the real repo/host
    // survive to the caller. Single-host behavior is unchanged: one apiBaseUrl means one grouping key per repo.
    const repoLower = repoFullName.toLowerCase();
    const repoKey = `${apiBaseUrl}\n${repoLower}`;
    if (!bucketsByRepo.has(repoKey)) {
      // The bucket's own repoFullName stays the plain repo (display/diversification), while each ITEM carries the
      // host-qualified key the engine groups on -- so the returned bucket shape is unchanged for single-host.
      bucketsByRepo.set(repoKey, { repoFullName: repoLower, items: [] });
      bucketOrder.push(repoKey);
    }
    bucketsByRepo.get(repoKey).items.push({
      id: queueItemId(apiBaseUrl, repoFullName, identifier),
      repoFullName: repoKey,
      state: entry.status === "in_progress" ? "in_progress" : "queued",
    });
  }
  return {
    buckets: bucketOrder.map((repoKey) => {
      const bucket = bucketsByRepo.get(repoKey);
      return { repoFullName: bucket.repoFullName, items: bucket.items };
    }),
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
