import { describe, expect, it } from "vitest";
import {
  dequeueItem,
  enqueueItem,
  nextEligibleItems,
  type PortfolioCaps,
  type PortfolioQueue,
  type PortfolioQueueItem,
} from "../../packages/gittensory-engine/src/portfolio/queue";

function item(
  id: string,
  repoFullName: string,
  state: PortfolioQueueItem["state"] = "queued",
): PortfolioQueueItem {
  return { id, repoFullName, state };
}

function queueOf(...items: PortfolioQueueItem[]): PortfolioQueue {
  return items.reduce<PortfolioQueue>((queue, entry) => enqueueItem(queue, entry), { buckets: [] });
}

describe("portfolio queue primitives", () => {
  it("enqueues by repo bucket, keeps insertion order, and ignores duplicate ids", () => {
    const queue = queueOf(
      item("a-1", "acme/alpha"),
      item("b-1", "acme/beta"),
      item("a-2", "acme/alpha"),
      item("a-1", "acme/gamma"),
    );

    expect(queue).toEqual({
      buckets: [
        { repoFullName: "acme/alpha", items: [item("a-1", "acme/alpha"), item("a-2", "acme/alpha")] },
        { repoFullName: "acme/beta", items: [item("b-1", "acme/beta")] },
      ],
    });
  });

  it("ignores blank ids and blank repo names when enqueuing", () => {
    const queue = queueOf(item("a-1", "acme/alpha"));

    expect(enqueueItem(queue, item("   ", "acme/beta"))).toBe(queue);
    expect(enqueueItem(queue, item("b-1", "   "))).toBe(queue);
  });

  it("trims identifiers and preserves an in-progress state when enqueuing", () => {
    expect(enqueueItem({ buckets: [] }, item("  a-1  ", "  acme/alpha  ", "in_progress"))).toEqual({
      buckets: [{ repoFullName: "acme/alpha", items: [item("a-1", "acme/alpha", "in_progress")] }],
    });
  });

  it("treats repo full names case-insensitively when bucketing", () => {
    expect(queueOf(item("a-1", "Owner/Repo"), item("a-2", "owner/repo"))).toEqual({
      buckets: [{ repoFullName: "owner/repo", items: [item("a-1", "owner/repo"), item("a-2", "owner/repo")] }],
    });
  });

  it("treats prebuilt queues with untrimmed ids as already containing the logical item", () => {
    const queue: PortfolioQueue = {
      buckets: [{ repoFullName: "acme/alpha", items: [{ id: "  a-1  ", repoFullName: "acme/alpha", state: "queued" }] }],
    };

    expect(enqueueItem(queue, item("a-1", "acme/alpha"))).toBe(queue);
  });

  it("dequeues one item and drops an empty repo bucket", () => {
    const queue = queueOf(item("a-1", "acme/alpha"), item("b-1", "acme/beta"));

    expect(dequeueItem(queue, "b-1")).toEqual({
      buckets: [{ repoFullName: "acme/alpha", items: [item("a-1", "acme/alpha")] }],
    });
    expect(dequeueItem(queue, "missing")).toBe(queue);
  });

  it("treats a blank dequeue target as a no-op", () => {
    const queue = queueOf(item("a-1", "acme/alpha"));

    expect(dequeueItem(queue, "   ")).toBe(queue);
  });

  it("dequeues a logical id from a prebuilt queue even when the stored id is untrimmed", () => {
    const queue: PortfolioQueue = {
      buckets: [{ repoFullName: "acme/alpha", items: [{ id: "  a-1  ", repoFullName: "acme/alpha", state: "queued" }] }],
    };

    expect(dequeueItem(queue, "a-1")).toEqual({ buckets: [] });
  });

  it("returns no eligible items for an empty queue", () => {
    expect(nextEligibleItems({ buckets: [] }, { globalWipCap: 2, perRepoWipCap: 1 })).toEqual([]);
  });

  it("returns no eligible items when a single repo is already at its WIP cap", () => {
    const queue = queueOf(
      item("a-running", "acme/alpha", "in_progress"),
      item("a-queued-1", "acme/alpha"),
      item("a-queued-2", "acme/alpha"),
    );

    expect(nextEligibleItems(queue, { globalWipCap: 3, perRepoWipCap: 1 })).toEqual([]);
  });

  it("returns no eligible items when either cap normalizes to zero", () => {
    const queue = queueOf(item("a-queued-1", "acme/alpha"));

    expect(nextEligibleItems(queue, { globalWipCap: Number.POSITIVE_INFINITY, perRepoWipCap: 1 })).toEqual([]);
    expect(nextEligibleItems(queue, { globalWipCap: 2, perRepoWipCap: -1 })).toEqual([]);
  });

  it("truncates fractional caps and treats NaN as zero", () => {
    const queue = queueOf(
      item("a-queued-1", "acme/alpha"),
      item("a-queued-2", "acme/alpha"),
      item("b-queued-1", "acme/beta"),
    );

    expect(nextEligibleItems(queue, { globalWipCap: 2.9, perRepoWipCap: 1.8 }).map((entry) => entry.id)).toEqual([
      "a-queued-1",
      "b-queued-1",
    ]);
    expect(nextEligibleItems(queue, { globalWipCap: Number.NaN, perRepoWipCap: 2 })).toEqual([]);
  });

  it("applies one per-repo cap across case-variant prebuilt buckets", () => {
    const queue: PortfolioQueue = {
      buckets: [
        { repoFullName: "Owner/Repo", items: [item("a-queued-1", "Owner/Repo")] },
        { repoFullName: "owner/repo", items: [item("a-queued-2", "owner/repo")] },
      ],
    };

    expect(nextEligibleItems(queue, { globalWipCap: 2, perRepoWipCap: 1 }).map((entry) => entry.id)).toEqual([
      "a-queued-1",
    ]);
  });

  it("enforces repo caps from each item's repo even when a prebuilt bucket label is wrong", () => {
    const queue: PortfolioQueue = {
      buckets: [
        { repoFullName: "acme/alpha", items: [item("b-running", "acme/beta", "in_progress")] },
        { repoFullName: "acme/beta", items: [item("b-queued-1", "acme/beta")] },
      ],
    };

    expect(nextEligibleItems(queue, { globalWipCap: 3, perRepoWipCap: 1 })).toEqual([]);
  });

  it("aggregates active counts across repeated prebuilt buckets for the same logical repo", () => {
    const queue: PortfolioQueue = {
      buckets: [
        { repoFullName: "acme/alpha", items: [item("a-running-1", "acme/alpha", "in_progress")] },
        {
          repoFullName: "ACME/ALPHA",
          items: [item("a-running-2", "acme/alpha", "in_progress"), item("a-queued-1", "acme/alpha")],
        },
      ],
    };

    expect(nextEligibleItems(queue, { globalWipCap: 3, perRepoWipCap: 2 })).toEqual([]);
  });

  it("diversifies multi-repo selection and prefers the least represented repos first", () => {
    const queue = queueOf(
      item("a-running", "acme/alpha", "in_progress"),
      item("a-queued-1", "acme/alpha"),
      item("a-queued-2", "acme/alpha"),
      item("b-queued-1", "acme/beta"),
      item("c-queued-1", "acme/gamma"),
    );
    const caps: PortfolioCaps = { globalWipCap: 4, perRepoWipCap: 2 };

    expect(nextEligibleItems(queue, caps).map((entry) => entry.id)).toEqual([
      "b-queued-1",
      "c-queued-1",
      "a-queued-1",
    ]);
  });

  it("reuses the same repo only after every other eligible repo is exhausted", () => {
    const queue = queueOf(
      item("a-queued-1", "acme/alpha"),
      item("a-queued-2", "acme/alpha"),
      item("b-queued-1", "acme/beta"),
    );

    expect(nextEligibleItems(queue, { globalWipCap: 3, perRepoWipCap: 3 }).map((entry) => entry.id)).toEqual([
      "a-queued-1",
      "b-queued-1",
      "a-queued-2",
    ]);
  });

  it("continues selecting from the same repo when no alternate repo is eligible", () => {
    const queue = queueOf(item("a-queued-1", "acme/alpha"), item("a-queued-2", "acme/alpha"));

    expect(nextEligibleItems(queue, { globalWipCap: 2, perRepoWipCap: 2 }).map((entry) => entry.id)).toEqual([
      "a-queued-1",
      "a-queued-2",
    ]);
  });

  it("returns no eligible items when global WIP is already full", () => {
    const queue = queueOf(
      item("a-running", "acme/alpha", "in_progress"),
      item("b-running", "acme/beta", "in_progress"),
      item("a-queued-1", "acme/alpha"),
      item("b-queued-1", "acme/beta"),
    );

    expect(nextEligibleItems(queue, { globalWipCap: 2, perRepoWipCap: 2 })).toEqual([]);
  });
});
