import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initPortfolioQueueStore } from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import type { QueueLeaseEntry } from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import {
  DEFAULT_MAX_LEASE_MS,
  findStuckItems,
  sweepStuckItems,
} from "../../packages/gittensory-miner/lib/portfolio-queue-expiry.js";
import { initPortfolioQueueManager } from "../../packages/gittensory-miner/lib/portfolio-queue-manager.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-expiry-"));
  roots.push(root);
  const store = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const leaseItem = (overrides: Partial<QueueLeaseEntry> = {}): QueueLeaseEntry => ({
  apiBaseUrl: "https://api.github.com",
  repoFullName: "o/a",
  identifier: "x",
  status: "in_progress",
  leasedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("portfolio-queue lease bookkeeping (#4827)", () => {
  it("stamps leased_at when an item is claimed and exposes it via listInProgress", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T10:00:00.000Z"));
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "x" });
    expect(store.listInProgress()).toEqual([]); // queued item carries no lease

    const claimed = store.dequeueNext();
    expect(claimed).toMatchObject({ identifier: "x", status: "in_progress" });
    expect(store.listInProgress()).toEqual([
      {
        apiBaseUrl: "https://api.github.com",
        repoFullName: "o/a",
        identifier: "x",
        status: "in_progress",
        leasedAt: "2026-07-12T10:00:00.000Z",
      },
    ]);
  });

  it("clears the lease when an item leaves in_progress (done, failed, reclaimed)", () => {
    const store = tempStore();
    for (const id of ["done", "failed", "reclaimed"]) {
      store.enqueue({ repoFullName: "o/a", identifier: id });
    }
    // Claim all three, then release each a different way.
    store.dequeueNext();
    store.dequeueNext();
    store.dequeueNext();
    expect(store.listInProgress()).toHaveLength(3);

    store.markDone("o/a", "done");
    store.markFailed("o/a", "failed");
    const reclaimed = store.reclaimStuckItem("o/a", "reclaimed");

    expect(reclaimed).toMatchObject({ identifier: "reclaimed", status: "queued" });
    expect(store.listInProgress()).toEqual([]); // every lease cleared
  });

  it("reclaimStuckItem is a no-op (null) for an item that is not in_progress", () => {
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "x" }); // still 'queued'
    expect(store.reclaimStuckItem("o/a", "x")).toBeNull();
    expect(store.reclaimStuckItem("o/a", "missing")).toBeNull();
  });

  it("batchClaim stamps a lease on every claimed row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T11:30:00.000Z"));
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "1" });
    store.enqueue({ repoFullName: "o/b", identifier: "2" });
    store.batchClaim((entries) => entries.map((e) => ({ repoFullName: e.repoFullName, identifier: e.identifier })));
    expect(store.listInProgress().map((e) => e.leasedAt)).toEqual([
      "2026-07-12T11:30:00.000Z",
      "2026-07-12T11:30:00.000Z",
    ]);
  });
});

describe("findStuckItems (#4827)", () => {
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const max = 30 * 60 * 1000;

  it("returns an in-flight item whose lease age strictly exceeds the bound", () => {
    const stuck = leaseItem({ leasedAt: new Date(now - max - 1).toISOString() });
    expect(findStuckItems([stuck], now, max)).toEqual([stuck]);
  });

  it("treats an item exactly at the bound as still within the window", () => {
    const atBound = leaseItem({ leasedAt: new Date(now - max).toISOString() });
    expect(findStuckItems([atBound], now, max)).toEqual([]);
  });

  it("ignores fresh, non-in_progress, and unparseable-lease items", () => {
    const fresh = leaseItem({ identifier: "fresh", leasedAt: new Date(now - 1).toISOString() });
    const queued = leaseItem({ identifier: "queued", status: "queued", leasedAt: new Date(now - max - 5).toISOString() });
    const noLease = leaseItem({ identifier: "nolease", leasedAt: null });
    const bogus = leaseItem({ identifier: "bogus", leasedAt: "not-a-date" });
    expect(findStuckItems([fresh, queued, noLease, bogus], now, max)).toEqual([]);
  });

  it("validates its arguments", () => {
    expect(() => findStuckItems([], Number.NaN, max)).toThrow("invalid_now_ms");
    expect(() => findStuckItems([], -1, max)).toThrow("invalid_now_ms");
    expect(() => findStuckItems([], now, Number.NaN)).toThrow("invalid_max_lease_ms");
    expect(() => findStuckItems([], now, -1)).toThrow("invalid_max_lease_ms");
    expect(() => findStuckItems("nope" as unknown as [], now, max)).toThrow("invalid_items");
  });
});

describe("sweepStuckItems (#4827)", () => {
  it("reclaims only the stuck in-flight items back to queued against a real store", () => {
    vi.useFakeTimers();
    const store = tempStore();

    // Claim `old` long ago, `recent` just now.
    vi.setSystemTime(new Date("2026-07-12T09:00:00.000Z"));
    store.enqueue({ repoFullName: "o/a", identifier: "old" });
    store.dequeueNext();
    vi.setSystemTime(new Date("2026-07-12T09:59:59.000Z"));
    store.enqueue({ repoFullName: "o/a", identifier: "recent" });
    store.dequeueNext();

    const nowMs = Date.parse("2026-07-12T10:00:00.000Z");
    const reclaimed = sweepStuckItems(store, nowMs, 30 * 60 * 1000);

    expect(reclaimed.map((e) => e.identifier)).toEqual(["old"]);
    expect(store.listInProgress().map((e) => e.identifier)).toEqual(["recent"]);
    // The reclaimed item is back in the queue for another attempt.
    expect(store.listQueue("o/a").find((e) => e.identifier === "old")?.status).toBe("queued");
  });

  it("REGRESSION: echoes each item's own apiBaseUrl to reclaimStuckItem, so it can't reclaim the wrong host's row (#5563)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const store = tempStore();
    const maxLeaseMs = 30 * 60 * 1000;

    // Two forge hosts each hold an in-flight lease on the SAME owner/repo+identifier -- only possible post-#5563's
    // scoped uniqueness.
    store.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", apiBaseUrl: "https://ghe.example.com/api/v3" });
    store.dequeueNext();
    vi.setSystemTime(new Date("2026-06-01T00:29:00.000Z")); // still within the lease bound
    store.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", apiBaseUrl: "https://api.github.com" });
    store.dequeueNext();

    const nowMs = Date.parse("2026-06-01T00:31:00.000Z"); // GHE lease (31min old) exceeds the bound; github.com (2min) doesn't
    const reclaimed = sweepStuckItems(store, nowMs, maxLeaseMs);
    expect(reclaimed).toEqual([expect.objectContaining({ apiBaseUrl: "https://ghe.example.com/api/v3", status: "queued" })]);

    const stillInProgress = store.listInProgress();
    expect(stillInProgress).toEqual([expect.objectContaining({ apiBaseUrl: "https://api.github.com" })]);
  });

  it("defaults the bound to DEFAULT_MAX_LEASE_MS and reclaims nothing when all leases are fresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T10:00:00.000Z"));
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "fresh" });
    store.dequeueNext();
    const nowMs = Date.parse("2026-07-12T10:00:01.000Z"); // 1s old, well under the default
    expect(sweepStuckItems(store, nowMs)).toEqual([]);
    expect(DEFAULT_MAX_LEASE_MS).toBe(30 * 60 * 1000);
  });
});

describe("PortfolioQueueManager stuck-lease reclaim wiring (#4827)", () => {
  it("claimNextBatch sweeps an orphaned lease back to queued before selecting, so it is claimable again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T09:00:00.000Z"));
    const store = tempStore();
    const manager = initPortfolioQueueManager({ store, caps: { globalWipCap: 1, perRepoWipCap: 1 } });
    manager.enqueue({ repoFullName: "acme/alpha", identifier: "work" });

    expect(manager.claimNextBatch().map((e) => e.identifier)).toEqual(["work"]);
    // The owning process "dies": the item stays in_progress and keeps the only WIP slot, so nothing else claims.
    expect(manager.claimNextBatch()).toEqual([]);

    vi.setSystemTime(new Date("2026-07-12T10:00:00.000Z")); // +1h, past the 30m default lease bound
    // The next claim sweeps the orphaned lease back to queued, then re-claims the now-eligible item.
    expect(manager.claimNextBatch().map((e) => e.identifier)).toEqual(["work"]);
  });

  it("reclaimStuckItems() returns the swept items and leaves fresh leases alone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T09:00:00.000Z"));
    const store = tempStore();
    const manager = initPortfolioQueueManager({ store, caps: { globalWipCap: 5, perRepoWipCap: 5 } });
    manager.enqueue({ repoFullName: "acme/alpha", identifier: "work" });
    manager.claimNextBatch();

    expect(manager.reclaimStuckItems()).toEqual([]); // fresh lease → nothing stuck
    vi.setSystemTime(new Date("2026-07-12T10:00:00.000Z"));
    const reclaimed = manager.reclaimStuckItems();
    expect(reclaimed.map((e) => e.identifier)).toEqual(["work"]);
    expect(reclaimed[0]?.status).toBe("queued");
  });
});
