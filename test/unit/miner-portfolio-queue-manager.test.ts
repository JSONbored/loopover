import { afterEach, describe, expect, it } from "vitest";
import {
  entriesToPortfolioQueue,
  initPortfolioQueueManager,
  normalizePortfolioCaps,
  parseQueueItemId,
  queueItemId,
  selectEligibleBatch,
} from "../../packages/gittensory-miner/lib/portfolio-queue-manager.js";
import { initPortfolioQueueStore, type QueueEntry } from "../../packages/gittensory-miner/lib/portfolio-queue.js";

const stores: Array<{ close(): void }> = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function memoryManager(caps: { globalWipCap: number; perRepoWipCap: number }) {
  const store = initPortfolioQueueStore(":memory:");
  stores.push(store);
  return initPortfolioQueueManager({ store, caps });
}

describe("normalizePortfolioCaps() (#4285)", () => {
  it("coerces caps to finite non-negative integers", () => {
    expect(normalizePortfolioCaps({ globalWipCap: 2.9, perRepoWipCap: -1 })).toEqual({
      globalWipCap: 2,
      perRepoWipCap: 0,
    });
    expect(normalizePortfolioCaps()).toEqual({ globalWipCap: 0, perRepoWipCap: 0 });
  });
});

describe("entriesToPortfolioQueue() / selectEligibleBatch() (#4285)", () => {
  it("mirrors the engine diversification scenario through persisted row shapes", () => {
    const apiBaseUrl = "https://api.github.com";
    const entries: QueueEntry[] = [
      { apiBaseUrl, repoFullName: "acme/alpha", identifier: "a-running", priority: 0, status: "in_progress", enqueuedAt: "t1" },
      { apiBaseUrl, repoFullName: "acme/alpha", identifier: "a-queued-1", priority: 0, status: "queued", enqueuedAt: "t2" },
      { apiBaseUrl, repoFullName: "acme/alpha", identifier: "a-queued-2", priority: 0, status: "queued", enqueuedAt: "t3" },
      { apiBaseUrl, repoFullName: "acme/beta", identifier: "b-queued-1", priority: 0, status: "queued", enqueuedAt: "t4" },
      { apiBaseUrl, repoFullName: "acme/gamma", identifier: "c-queued-1", priority: 0, status: "queued", enqueuedAt: "t5" },
    ];

    expect(
      selectEligibleBatch(entries, { globalWipCap: 4, perRepoWipCap: 2 }).map((target) => target.identifier),
    ).toEqual(["b-queued-1", "c-queued-1", "a-queued-1"]);
    expect(entriesToPortfolioQueue(entries).buckets.map((bucket) => bucket.repoFullName)).toEqual([
      "acme/alpha",
      "acme/beta",
      "acme/gamma",
    ]);
    expect(parseQueueItemId(queueItemId("acme/beta", "b-queued-1"))).toEqual({
      repoFullName: "acme/beta",
      identifier: "b-queued-1",
    });
  });

  it("returns nothing when either cap is zero", () => {
    const entries: QueueEntry[] = [
      { apiBaseUrl: "https://api.github.com", repoFullName: "acme/alpha", identifier: "x", priority: 0, status: "queued", enqueuedAt: "t1" },
    ];
    expect(selectEligibleBatch(entries, { globalWipCap: 0, perRepoWipCap: 1 })).toEqual([]);
    expect(selectEligibleBatch(entries, { globalWipCap: 1, perRepoWipCap: 0 })).toEqual([]);
  });
});

describe("initPortfolioQueueManager().claimNextBatch() (#4285)", () => {
  it("returns an empty batch on an empty queue", () => {
    const manager = memoryManager({ globalWipCap: 2, perRepoWipCap: 2 });
    expect(manager.claimNextBatch()).toEqual([]);
  });

  it("markDone and markFailed pass repoFullName/identifier/apiBaseUrl straight through to the store (#5563)", () => {
    const manager = memoryManager({ globalWipCap: 2, perRepoWipCap: 2 });
    manager.enqueue({ repoFullName: "acme/alpha", identifier: "x", apiBaseUrl: "https://ghe.example.com/api/v3" });
    manager.store.dequeueNext();
    expect(manager.markFailed("acme/alpha", "x", "https://ghe.example.com/api/v3")?.status).toBe("queued");
    manager.store.dequeueNext();
    expect(manager.markDone("acme/alpha", "x", "https://ghe.example.com/api/v3")?.status).toBe("done");
  });

  it("respects a saturated per-repo cap", () => {
    const manager = memoryManager({ globalWipCap: 4, perRepoWipCap: 1 });
    manager.enqueue({ repoFullName: "acme/alpha", identifier: "running", priority: 1 });
    manager.enqueue({ repoFullName: "acme/alpha", identifier: "queued-1", priority: 2 });
    manager.enqueue({ repoFullName: "acme/alpha", identifier: "queued-2", priority: 3 });
    expect(manager.store.dequeueNext()?.identifier).toBe("queued-2");

    expect(manager.claimNextBatch().map((entry) => entry.identifier)).toEqual([]);
    expect(manager.listQueue("acme/alpha").map((entry) => [entry.identifier, entry.status])).toEqual([
      ["queued-2", "in_progress"],
      ["queued-1", "queued"],
      ["running", "queued"],
    ]);
  });

  it("claims a diversified batch and leaves dequeueNext behavior unchanged for the CLI path", () => {
    const manager = memoryManager({ globalWipCap: 4, perRepoWipCap: 2 });
    manager.enqueue({ repoFullName: "acme/alpha", identifier: "a-running", priority: 5 });
    manager.enqueue({ repoFullName: "acme/alpha", identifier: "a-queued-1", priority: 4 });
    manager.enqueue({ repoFullName: "acme/alpha", identifier: "a-queued-2", priority: 3 });
    manager.enqueue({ repoFullName: "acme/beta", identifier: "b-queued-1", priority: 2 });
    manager.enqueue({ repoFullName: "acme/gamma", identifier: "c-queued-1", priority: 1 });
    manager.store.dequeueNext(); // single-row CLI path still claims highest priority only

    const claimed = manager.claimNextBatch();
    expect(claimed.map((entry) => entry.identifier)).toEqual(["b-queued-1", "c-queued-1", "a-queued-1"]);
    expect(claimed.every((entry) => entry.status === "in_progress")).toBe(true);
    expect(manager.listQueue().find((entry) => entry.identifier === "a-queued-2")?.status).toBe("queued");
  });

  it("does not claim rows another writer already took inside the same transaction window", () => {
    const store = initPortfolioQueueStore(":memory:");
    stores.push(store);
    store.enqueue({ repoFullName: "acme/alpha", identifier: "one", priority: 1 });
    store.enqueue({ repoFullName: "acme/beta", identifier: "two", priority: 1 });

    const claimed = store.batchClaim((entries) => {
      store.dequeueNext();
      return selectEligibleBatch(entries, { globalWipCap: 2, perRepoWipCap: 1 });
    });

    expect(claimed.map((entry) => entry.identifier)).toEqual(["two"]);
  });
});
