import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUEUE_STATUSES,
  closeDefaultPortfolioQueueStore,
  dequeueNext,
  enqueue,
  getAttemptHistory,
  initPortfolioQueueStore,
  markDone,
  markFailed,
  resolvePortfolioQueueDbPath,
} from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import { classifyPortfolioConvergence } from "../../packages/gittensory-engine/src/index";

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

  it("markFailed releases an in-progress item back to queued for a halted run (#2347)", () => {
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "work", priority: 1 });
    expect(store.dequeueNext()?.status).toBe("in_progress");
    expect(store.markFailed("o/a", "work")?.status).toBe("queued");
    expect(store.markFailed("o/a", "work")).toBeNull();
    expect(store.dequeueNext()?.identifier).toBe("work");
  });

  it("markFailed is a no-op for queued or done items", () => {
    const store = tempStore();
    store.enqueue({ repoFullName: "o/a", identifier: "queued", priority: 1 });
    expect(store.markFailed("o/a", "queued")).toBeNull();
    store.markDone("o/a", "queued");
    expect(store.markFailed("o/a", "queued")).toBeNull();
    expect(store.markFailed("o/a", "missing")).toBeNull();
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

  it("module-level markFailed delegates to the default portfolio-queue store (#2347)", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-default-"));
    roots.push(root);
    vi.stubEnv("GITTENSORY_MINER_PORTFOLIO_QUEUE_DB", join(root, "portfolio-queue.sqlite3"));
    enqueue({ repoFullName: "o/a", identifier: "work", priority: 1 });
    expect(dequeueNext()?.status).toBe("in_progress");
    expect(markFailed("o/a", "work")?.status).toBe("queued");
    expect(markFailed("o/a", "work")).toBeNull();
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
    expect(() => store.markFailed("no-slash", "1")).toThrow("invalid_repo_full_name");
    expect(() => store.markFailed("o/a", "  ")).toThrow("invalid_identifier");
  });

  it("module-level markDone delegates to the default portfolio-queue store", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-default-"));
    roots.push(root);
    vi.stubEnv("GITTENSORY_MINER_PORTFOLIO_QUEUE_DB", join(root, "portfolio-queue.sqlite3"));
    enqueue({ repoFullName: "o/a", identifier: "work", priority: 1 });
    expect(markDone("o/a", "work")?.status).toBe("done");
    expect(markDone("o/a", "work")).toBeNull();
  });

  describe("forge-scoping (#5563)", () => {
    it("defaults apiBaseUrl to the github.com default when omitted", () => {
      const entry = tempStore().enqueue({ repoFullName: "o/a", identifier: "x" });
      expect(entry.apiBaseUrl).toBe("https://api.github.com");
    });

    it("two forge hosts can each hold an item with the same owner/repo+identifier without colliding", () => {
      const store = tempStore();
      const gh = store.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", apiBaseUrl: "https://api.github.com" });
      const ghe = store.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", apiBaseUrl: "https://ghe.example.com/api/v3" });
      expect(gh.apiBaseUrl).not.toBe(ghe.apiBaseUrl);
      expect(store.listQueue("acme/widgets")).toHaveLength(2);

      expect(store.markDone("acme/widgets", "issue:1", "https://api.github.com")?.apiBaseUrl).toBe("https://api.github.com");
      const stillQueued = store.listQueue("acme/widgets").find((entry) => entry.status === "queued");
      expect(stillQueued?.apiBaseUrl).toBe("https://ghe.example.com/api/v3");
    });

    it("markFailed, reclaimStuckItem, and requeueItem are all scoped by apiBaseUrl too", () => {
      const store = tempStore();
      store.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", apiBaseUrl: "https://api.github.com" });
      store.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", apiBaseUrl: "https://ghe.example.com/api/v3" });

      // dequeueNext is global (no host filter): claims the github.com row first (enqueued first), then — since
      // that row is no longer 'queued' — the GHE row on the next call.
      const claimedGh = store.dequeueNext();
      expect(claimedGh?.apiBaseUrl).toBe("https://api.github.com");
      const claimedGhe = store.dequeueNext();
      expect(claimedGhe?.apiBaseUrl).toBe("https://ghe.example.com/api/v3");

      // Releasing the github.com host's in-flight row must not touch the still-in-flight GHE row.
      expect(store.markFailed("acme/widgets", "issue:1", "https://api.github.com")?.status).toBe("queued");
      const stillInProgress = store.listInProgress();
      expect(stillInProgress).toEqual([expect.objectContaining({ apiBaseUrl: "https://ghe.example.com/api/v3" })]);

      const released = store.reclaimStuckItem("acme/widgets", "issue:1", "https://ghe.example.com/api/v3");
      expect(released?.status).toBe("queued");
      expect(store.listInProgress()).toEqual([]);

      store.markDone("acme/widgets", "issue:1", "https://api.github.com");
      const requeued = store.requeueItem("acme/widgets", "issue:1", "https://api.github.com");
      expect(requeued?.status).toBe("queued");
      expect(requeued?.apiBaseUrl).toBe("https://api.github.com");
      // The GHE row (still 'queued' from its own reclaim above) is untouched by requeueItem's github.com scope.
      expect(store.listQueue("acme/widgets")).toHaveLength(2);
    });

    it("batchClaim threads target.apiBaseUrl through claimTargetStatement, scoped per host", () => {
      const store = tempStore();
      store.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", apiBaseUrl: "https://api.github.com" });
      store.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", apiBaseUrl: "https://ghe.example.com/api/v3" });
      const claimed = store.batchClaim((entries) =>
        entries.map((entry) => ({ repoFullName: entry.repoFullName, identifier: entry.identifier, apiBaseUrl: entry.apiBaseUrl })),
      );
      expect(claimed.map((entry) => entry.apiBaseUrl).sort()).toEqual([
        "https://api.github.com",
        "https://ghe.example.com/api/v3",
      ]);
    });

    it("rejects a non-string or blank apiBaseUrl", () => {
      const store = tempStore();
      expect(() => store.enqueue({ repoFullName: "o/a", identifier: "1", apiBaseUrl: "  " })).toThrow(
        "invalid_api_base_url",
      );
      expect(() => store.enqueue({ repoFullName: "o/a", identifier: "1", apiBaseUrl: 42 as never })).toThrow(
        "invalid_api_base_url",
      );
    });

    it("migrates an existing pre-#5563 file (already at the leased_at v2 shape), backfilling api_base_url and preserving every row", () => {
      const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-legacy-"));
      roots.push(root);
      const dbPath = join(root, "legacy.sqlite3");
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE miner_portfolio_queue (
          repo_full_name TEXT NOT NULL,
          identifier TEXT NOT NULL,
          priority REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'done')),
          enqueued_at TEXT NOT NULL,
          leased_at TEXT,
          PRIMARY KEY (repo_full_name, identifier)
        )
      `);
      legacy.exec("PRAGMA user_version = 2");
      legacy.exec(
        "INSERT INTO miner_portfolio_queue (repo_full_name, identifier, priority, status, enqueued_at, leased_at) VALUES ('acme/widgets', 'issue:5', 3, 'queued', '2026-01-01T00:00:00.000Z', NULL)",
      );
      legacy.close();

      const store = initPortfolioQueueStore(dbPath);
      stores.push(store);
      expect(store.listQueue("acme/widgets")).toEqual([
        {
          apiBaseUrl: "https://api.github.com",
          repoFullName: "acme/widgets",
          identifier: "issue:5",
          priority: 3,
          status: "queued",
          enqueuedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      // The old bare (repo_full_name, identifier) collision is gone: a second host can now enqueue the same pair.
      const geEntry = store.enqueue({ repoFullName: "acme/widgets", identifier: "issue:5", apiBaseUrl: "https://ghe.example.com/api/v3" });
      expect(store.listQueue("acme/widgets")).toHaveLength(2);
      expect(geEntry.apiBaseUrl).toBe("https://ghe.example.com/api/v3");
    });

    it("migrates a pre-#5654 file (leased_at+forge v3 shape) by adding the attempt-history columns and preserving rows", () => {
      // A v3-shaped file (post-forge, pre-attempt-history) gains the v4 columns without disturbing the existing
      // row (mirrors the leased_at / forge migration tests above). Covers the ADD-COLUMN (true) branch.
      const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-v3-"));
      roots.push(root);
      const dbPath = join(root, "v3.sqlite3");
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE miner_portfolio_queue (
          api_base_url TEXT NOT NULL,
          repo_full_name TEXT NOT NULL,
          identifier TEXT NOT NULL,
          priority REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'done')),
          enqueued_at TEXT NOT NULL,
          leased_at TEXT,
          PRIMARY KEY (api_base_url, repo_full_name, identifier)
        )
      `);
      legacy.exec("PRAGMA user_version = 3");
      legacy.exec(
        "INSERT INTO miner_portfolio_queue (api_base_url, repo_full_name, identifier, priority, status, enqueued_at, leased_at) VALUES ('https://api.github.com', 'acme/widgets', 'issue:5', 3, 'queued', '2026-01-01T00:00:00.000Z', NULL)",
      );
      legacy.close();

      const store = initPortfolioQueueStore(dbPath);
      stores.push(store);
      // Existing row preserved (the base entry shape is unchanged -- counters are surfaced only via getAttemptHistory).
      expect(store.listQueue("acme/widgets")).toEqual([
        {
          apiBaseUrl: "https://api.github.com",
          repoFullName: "acme/widgets",
          identifier: "issue:5",
          priority: 3,
          status: "queued",
          enqueuedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      // The migrated row starts with a fresh 0/0/0 history, and the counters work after migration.
      expect(store.getAttemptHistory("acme/widgets", "issue:5")).toEqual({
        attempts: 0,
        consecutiveFailures: 0,
        reenqueues: 0,
        reachedDone: false,
      });
      store.dequeueNext();
      expect(store.getAttemptHistory("acme/widgets", "issue:5")).toMatchObject({ attempts: 1 });
    });

    it("is defensive: a file already carrying the attempt-history columns is not re-altered (idempotent v4 migration)", () => {
      // A v3-versioned file that already ran the ADD COLUMNs (e.g. an ad-hoc ALTER) must not hit a
      // duplicate-column error -- the per-column table_info presence check skips each already-present column.
      // Covers the skip (false) branch of all three column checks.
      const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-v4-preadded-"));
      roots.push(root);
      const dbPath = join(root, "preadded.sqlite3");
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE miner_portfolio_queue (
          api_base_url TEXT NOT NULL,
          repo_full_name TEXT NOT NULL,
          identifier TEXT NOT NULL,
          priority REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'done')),
          enqueued_at TEXT NOT NULL,
          leased_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          reenqueues INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (api_base_url, repo_full_name, identifier)
        )
      `);
      // Still marked pre-v4, so the v4 migration runs and must no-op each ALTER rather than error.
      legacy.exec("PRAGMA user_version = 3");
      legacy.exec(
        "INSERT INTO miner_portfolio_queue (api_base_url, repo_full_name, identifier, priority, status, enqueued_at, attempts, consecutive_failures, reenqueues) VALUES ('https://api.github.com', 'acme/widgets', 'issue:9', 1, 'queued', '2026-01-01T00:00:00.000Z', 4, 2, 3)",
      );
      legacy.close();

      let opened: ReturnType<typeof initPortfolioQueueStore> | undefined;
      expect(() => {
        opened = initPortfolioQueueStore(dbPath);
      }).not.toThrow();
      const store = opened!;
      stores.push(store);
      // The pre-existing counter values survived: the ALTERs were skipped, not re-run with a DEFAULT-0 wipe.
      expect(store.getAttemptHistory("acme/widgets", "issue:9")).toEqual({
        attempts: 4,
        consecutiveFailures: 2,
        reenqueues: 3,
        reachedDone: false,
      });
    });

    it("REGRESSION: a legacy row violating the rebuilt table's status CHECK constraint is dropped, not a migration-aborting crash", () => {
      const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-legacy-corrupt-"));
      roots.push(root);
      const dbPath = join(root, "legacy-corrupt.sqlite3");
      const legacy = new DatabaseSync(dbPath);
      // No CHECK on status here, simulating a hand-edited or otherwise corrupted legacy file -- the real
      // baseline schema always enforces the CHECK, so this can only arise from external tampering.
      legacy.exec(`
        CREATE TABLE miner_portfolio_queue (
          repo_full_name TEXT NOT NULL,
          identifier TEXT NOT NULL,
          priority REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued',
          enqueued_at TEXT NOT NULL,
          leased_at TEXT,
          PRIMARY KEY (repo_full_name, identifier)
        )
      `);
      legacy.exec("PRAGMA user_version = 2");
      legacy.exec(
        "INSERT INTO miner_portfolio_queue (repo_full_name, identifier, priority, status, enqueued_at, leased_at) VALUES ('acme/corrupt', 'issue:1', 1, 'bogus', '2026-01-01T00:00:00.000Z', NULL)",
      );
      legacy.exec(
        "INSERT INTO miner_portfolio_queue (repo_full_name, identifier, priority, status, enqueued_at, leased_at) VALUES ('acme/widgets', 'issue:5', 3, 'queued', '2026-01-01T00:00:00.000Z', NULL)",
      );
      legacy.close();

      let opened: ReturnType<typeof initPortfolioQueueStore> | undefined;
      expect(() => {
        opened = initPortfolioQueueStore(dbPath);
      }).not.toThrow();
      const store = opened!;
      stores.push(store);
      // The corrupt row was dropped, not migrated -- only the valid row survived the rebuild.
      expect(store.listQueue().map((entry) => entry.repoFullName)).toEqual(["acme/widgets"]);
    });
  });

  describe("attempt-history for the non-convergence detector (#5654)", () => {
    it("returns an all-zero first-attempt shape for an item the queue has never seen", () => {
      // A missing row reads as a genuine first look (converging), never a fabricated history.
      expect(tempStore().getAttemptHistory("o/a", "issue:1")).toEqual({
        attempts: 0,
        consecutiveFailures: 0,
        reenqueues: 0,
        reachedDone: false,
      });
    });

    it("counts an attempt on claim and only flips reachedDone once the item is done", () => {
      const store = tempStore();
      store.enqueue({ repoFullName: "o/a", identifier: "issue:1", priority: 1 });
      expect(store.getAttemptHistory("o/a", "issue:1")).toMatchObject({ attempts: 0, reachedDone: false });
      store.dequeueNext(); // claim -> attempts 1
      expect(store.getAttemptHistory("o/a", "issue:1")).toMatchObject({ attempts: 1, reachedDone: false });
      store.markDone("o/a", "issue:1");
      expect(store.getAttemptHistory("o/a", "issue:1")).toMatchObject({
        attempts: 1,
        consecutiveFailures: 0,
        reachedDone: true,
      });
    });

    it("bumps reenqueues + the failure streak on markFailed and reclaim, and resets the streak on markDone", () => {
      const store = tempStore();
      store.enqueue({ repoFullName: "o/a", identifier: "issue:1", priority: 1 });
      // claim + markFailed (halted run): a failed attempt back to queued.
      store.dequeueNext();
      store.markFailed("o/a", "issue:1");
      expect(store.getAttemptHistory("o/a", "issue:1")).toMatchObject({
        attempts: 1,
        reenqueues: 1,
        consecutiveFailures: 1,
        reachedDone: false,
      });
      // claim + reclaim (stuck sweep): a second failed attempt, both counters climb.
      store.dequeueNext();
      store.reclaimStuckItem("o/a", "issue:1");
      expect(store.getAttemptHistory("o/a", "issue:1")).toMatchObject({
        attempts: 2,
        reenqueues: 2,
        consecutiveFailures: 2,
      });
      // claim + markDone: the failure streak resets to 0 (progress), attempts keeps climbing, reenqueues holds.
      store.dequeueNext();
      expect(store.markDone("o/a", "issue:1")?.status).toBe("done");
      expect(store.getAttemptHistory("o/a", "issue:1")).toMatchObject({
        attempts: 3,
        reenqueues: 2,
        consecutiveFailures: 0,
        reachedDone: true,
      });
    });

    it("bumps only reenqueues (not the failure streak) when a completed item is manually requeued", () => {
      const store = tempStore();
      store.enqueue({ repoFullName: "o/a", identifier: "issue:1", priority: 1 });
      store.dequeueNext();
      store.markDone("o/a", "issue:1");
      expect(store.requeueItem("o/a", "issue:1")?.status).toBe("queued");
      // Requeuing a DONE item re-enqueues it (reenqueues 1) but is not a failure (streak stays 0); reachedDone
      // flips back to false because the row is queued again.
      expect(store.getAttemptHistory("o/a", "issue:1")).toMatchObject({
        attempts: 1,
        reenqueues: 1,
        consecutiveFailures: 0,
        reachedDone: false,
      });
    });

    it("batchClaim counts an attempt on each claimed item", () => {
      const store = tempStore();
      store.enqueue({ repoFullName: "o/a", identifier: "issue:1", priority: 1 });
      const claimed = store.batchClaim((entries) =>
        entries.map((entry) => ({ repoFullName: entry.repoFullName, identifier: entry.identifier, apiBaseUrl: entry.apiBaseUrl })),
      );
      expect(claimed).toHaveLength(1);
      expect(store.getAttemptHistory("o/a", "issue:1")).toMatchObject({ attempts: 1 });
    });

    it("REGRESSION: a genuinely non-convergent item (repeated reclaim, never done) now classifies as non_convergent", () => {
      const store = tempStore();
      store.enqueue({ repoFullName: "o/a", identifier: "issue:1", priority: 1 });
      // Three claim -> reclaim cycles without ever reaching done: exactly the loop the detector is built to catch.
      for (let cycle = 0; cycle < 3; cycle += 1) {
        store.dequeueNext();
        store.reclaimStuckItem("o/a", "issue:1");
      }
      const input = store.getAttemptHistory("o/a", "issue:1");
      expect(input).toMatchObject({ attempts: 3, reenqueues: 3, consecutiveFailures: 3, reachedDone: false });
      // The first time real portfolio-queue data drives the already-built detector to a real non-convergent verdict.
      expect(classifyPortfolioConvergence(input).status).toBe("non_convergent");
    });

    it("reachedDone reflects only status === 'done', never a fabricated flag", () => {
      const store = tempStore();
      store.enqueue({ repoFullName: "o/a", identifier: "issue:1", priority: 1 });
      expect(store.getAttemptHistory("o/a", "issue:1").reachedDone).toBe(false); // queued
      store.dequeueNext();
      expect(store.getAttemptHistory("o/a", "issue:1").reachedDone).toBe(false); // in_progress
      store.markDone("o/a", "issue:1");
      expect(store.getAttemptHistory("o/a", "issue:1").reachedDone).toBe(true); // done
    });

    it("module-level getAttemptHistory delegates to the default portfolio-queue store", () => {
      const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-default-"));
      roots.push(root);
      vi.stubEnv("GITTENSORY_MINER_PORTFOLIO_QUEUE_DB", join(root, "portfolio-queue.sqlite3"));
      enqueue({ repoFullName: "o/a", identifier: "issue:1", priority: 1 });
      dequeueNext();
      expect(getAttemptHistory("o/a", "issue:1")).toMatchObject({ attempts: 1, reachedDone: false });
    });
  });
});
