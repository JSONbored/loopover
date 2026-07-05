import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUEUE_STATUSES,
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
  resolvePortfolioQueueDbPath,
} from "../../packages/gittensory-miner/lib/portfolio-queue.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-"));
  roots.push(root);
  const store = initPortfolioQueueStore(join(root, "nested", "portfolio-queue.sqlite3"));
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultPortfolioQueueStore();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner portfolio/queue store (#2292)", () => {
  it("exposes the frozen status vocabulary", () => {
    expect(QUEUE_STATUSES).toEqual(["queued", "in_progress", "done"]);
    expect(Object.isFrozen(QUEUE_STATUSES)).toBe(true);
  });

  it("resolves the DB path from env override, miner config dir, XDG config, then the home default", () => {
    expect(resolvePortfolioQueueDbPath({ GITTENSORY_MINER_PORTFOLIO_QUEUE_DB: "/custom/q.sqlite3" })).toBe(
      "/custom/q.sqlite3",
    );
    expect(resolvePortfolioQueueDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/custom/config" })).toBe(
      "/custom/config/portfolio-queue.sqlite3",
    );
    expect(resolvePortfolioQueueDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/gittensory-miner/portfolio-queue.sqlite3",
    );
    expect(resolvePortfolioQueueDbPath({})).toMatch(/\/\.config\/gittensory-miner\/portfolio-queue\.sqlite3$/);
  });

  it("creates the SQLite file with owner-only permissions and reads empty before any write", () => {
    const store = tempStore();
    expect(existsSync(store.dbPath)).toBe(true);
    expect(statSync(store.dbPath).mode & 0o077).toBe(0);
    expect(store.listQueue()).toEqual([]);
    expect(store.dequeueNext()).toBeNull(); // empty queue → null branch
  });

  it("defaults an omitted priority to 0 and enqueues as 'queued'", () => {
    const entry = tempStore().enqueue({ repoFullName: "o/a", identifier: "x" });
    expect(entry).toMatchObject({ repoFullName: "o/a", identifier: "x", priority: 0, status: "queued" });
    expect(typeof entry.enqueuedAt).toBe("string");
  });

  it("treats a null priority as the default 0", () => {
    const entry = tempStore().enqueue({ repoFullName: "o/a", identifier: "x", priority: null });
    expect(entry.priority).toBe(0);
  });

  it("dequeues highest-priority first, then by insertion order within a priority band", () => {
    // Freeze the clock so same-priority items share enqueued_at — proving the rowid FIFO tie-break, not a timestamp.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T00:00:00Z"));
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "1", priority: 1 });
    store.enqueue({ repoFullName: "o/a", identifier: "2", priority: 3 });
    store.enqueue({ repoFullName: "o/a", identifier: "3", priority: 2 });
    store.enqueue({ repoFullName: "o/a", identifier: "4", priority: 3 }); // ties #2 on priority + timestamp

    expect(store.dequeueNext()?.identifier).toBe("2"); // p3, enqueued first
    expect(store.dequeueNext()?.identifier).toBe("4"); // p3, enqueued second → rowid tie-break
    expect(store.dequeueNext()?.identifier).toBe("3"); // p2
    const last = store.dequeueNext();
    expect(last).toMatchObject({ identifier: "1", status: "in_progress" }); // claimed
    expect(store.dequeueNext()).toBeNull(); // nothing left queued → null branch
  });

  it("markDone excludes an item from future dequeueNext, and returns null for a missing item", () => {
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "keep", priority: 1 });
    store.enqueue({ repoFullName: "o/a", identifier: "skip", priority: 5 });
    expect(store.markDone("o/a", "skip")?.status).toBe("done");
    expect(store.dequeueNext()?.identifier).toBe("keep"); // higher-priority 'skip' is done → not returned
    expect(store.markDone("o/a", "missing")).toBeNull(); // no such row → null branch
  });

  it("markDone is a no-op when the item is already done", () => {
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "x", priority: 1 });
    expect(store.markDone("o/a", "x")?.status).toBe("done");
    expect(store.markDone("o/a", "x")).toBeNull();
  });

  it("markDone transitions in-progress items to done", () => {
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "work", priority: 1 });
    expect(store.dequeueNext()?.status).toBe("in_progress");
    expect(store.markDone("o/a", "work")?.status).toBe("done");
    expect(store.markDone("o/a", "work")).toBeNull();
  });

  it("isolates listQueue by repo and lists everything when unfiltered", () => {
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "1", priority: 1 });
    store.enqueue({ repoFullName: "o/b", identifier: "1", priority: 2 });
    store.enqueue({ repoFullName: "o/a", identifier: "2", priority: 3 });
    expect(store.listQueue("o/a").map((entry) => entry.identifier)).toEqual(["2", "1"]); // priority DESC
    expect(store.listQueue("o/b").map((entry) => entry.repoFullName)).toEqual(["o/b"]);
    expect(store.listQueue().length).toBe(3);
    expect(store.listQueue(null).length).toBe(3);
  });

  it("re-enqueue re-activates a done item and refreshes its placeholder priority", () => {
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "1", priority: 1 });
    store.markDone("o/a", "1");
    expect(store.dequeueNext()).toBeNull(); // done → nothing queued
    const requeued = store.enqueue({ repoFullName: "o/a", identifier: "1", priority: 9 });
    expect(requeued).toMatchObject({ status: "queued", priority: 9 });
    expect(store.dequeueNext()?.identifier).toBe("1"); // re-queued → dequeuable again
  });

  it("re-enqueue does not demote an in-progress item back to queued", () => {
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "work", priority: 1 });
    expect(store.dequeueNext()).toMatchObject({ identifier: "work", status: "in_progress", priority: 1 });
    expect(store.enqueue({ repoFullName: "o/a", identifier: "work", priority: 99 })).toMatchObject({
      identifier: "work",
      status: "in_progress",
      priority: 1,
    });
  });

  it("re-enqueue keeps an item's FIFO position (no queue-jumping) even when timestamps collide", () => {
    // Freeze the clock so A and B share an enqueued_at — the case where a restamp-vs-rowid inconsistency would show.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T00:00:00Z"));
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "A", priority: 1 });
    store.enqueue({ repoFullName: "o/a", identifier: "B", priority: 1 });
    store.enqueue({ repoFullName: "o/a", identifier: "A", priority: 1 }); // re-enqueue A: must stay in place, not move
    expect(store.listQueue("o/a").map((entry) => entry.identifier)).toEqual(["A", "B"]);
    expect(store.dequeueNext()?.identifier).toBe("A");
    expect(store.dequeueNext()?.identifier).toBe("B");
  });

  it("rejects malformed inputs across the shared validation contract (enqueue, listQueue, markDone)", () => {
    const store = tempStore();
    expect(() => store.enqueue({ repoFullName: "no-slash", identifier: "1" })).toThrow("invalid_repo_full_name");
    expect(() => store.enqueue({ repoFullName: "o/a", identifier: "  " })).toThrow("invalid_identifier");
    expect(() => store.enqueue({ repoFullName: "o/a", identifier: "1", priority: Number.NaN })).toThrow(
      "invalid_priority",
    );
    expect(() => store.enqueue({ repoFullName: "o/a", identifier: "1", priority: -1 })).toThrow("invalid_priority");
    // listQueue and markDone enforce the same repo/identifier validation as enqueue.
    expect(() => store.listQueue("no-slash")).toThrow("invalid_repo_full_name");
    expect(() => store.markDone("no-slash", "1")).toThrow("invalid_repo_full_name");
    expect(() => store.markDone("o/a", "  ")).toThrow("invalid_identifier");
  });
});
