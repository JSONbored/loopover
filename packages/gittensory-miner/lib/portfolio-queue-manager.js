// Stateful PortfolioQueueManager (#4285): compose the persisted SQLite portfolio/queue store
// (portfolio-queue.js, #2292) with the pure engine selector (nextEligibleItems, queue.ts, #2326) so batch
// claiming respects global/per-repo WIP caps and cross-repo diversification instead of a naive priority-only
// single-row dequeue. Caps are plain constructor arguments — not wired to .gittensory-miner.yml here.
import { nextEligibleItems } from "@jsonbored/gittensory-engine";
import { initPortfolioQueueStore } from "./portfolio-queue.js";

const ITEM_ID_SEPARATOR = "::";

/** Stable composite id for projecting SQLite rows into the engine's PortfolioQueueItem shape. */
export function queueItemId(repoFullName, identifier) {
  return `${repoFullName}${ITEM_ID_SEPARATOR}${identifier}`;
}

/** Reverse {@link queueItemId} after engine selection so claims can target SQLite primary keys. */
export function parseQueueItemId(id) {
  if (typeof id !== "string") throw new Error("invalid_queue_item_id");
  const separatorIndex = id.indexOf(ITEM_ID_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === id.length - ITEM_ID_SEPARATOR.length) {
    throw new Error("invalid_queue_item_id");
  }
  return {
    repoFullName: id.slice(0, separatorIndex),
    identifier: id.slice(separatorIndex + ITEM_ID_SEPARATOR.length),
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
    const repoKey = repoFullName.toLowerCase();
    if (!bucketsByRepo.has(repoKey)) {
      bucketsByRepo.set(repoKey, []);
      bucketOrder.push(repoKey);
    }
    bucketsByRepo.get(repoKey).push({
      id: queueItemId(repoFullName, identifier),
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
    markDone(repoFullName, identifier) {
      return store.markDone(repoFullName, identifier);
    },
    claimNextBatch() {
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
