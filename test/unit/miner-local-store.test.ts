import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeLocalStoreDbPath,
  openLocalStoreDb,
  resolveLocalStoreDbPath,
} from "../../packages/gittensory-miner/lib/local-store.js";
import { closeDefaultClaimLedger, openClaimLedger, resolveClaimLedgerDbPath } from "../../packages/gittensory-miner/lib/claim-ledger.js";
import { closeDefaultEventLedger, initEventLedger, resolveEventLedgerDbPath } from "../../packages/gittensory-miner/lib/event-ledger.js";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
  resolvePortfolioQueueDbPath,
} from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import { closeDefaultRunStateStore, initRunStateStore, resolveRunStateDbPath } from "../../packages/gittensory-miner/lib/run-state.js";

const roots: string[] = [];
const dbs: Array<{ close(): void }> = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-local-store-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  closeDefaultRunStateStore();
  closeDefaultClaimLedger();
  closeDefaultPortfolioQueueStore();
  closeDefaultEventLedger();
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner shared local-store helper (#4272)", () => {
  it("resolveLocalStoreDbPath prefers the explicit env var, then config dir, then XDG, then the home default", () => {
    expect(
      resolveLocalStoreDbPath("thing.sqlite3", "GITTENSORY_MINER_THING_DB", {
        GITTENSORY_MINER_THING_DB: "/custom/thing.sqlite3",
      }),
    ).toBe("/custom/thing.sqlite3");
    expect(
      resolveLocalStoreDbPath("thing.sqlite3", "GITTENSORY_MINER_THING_DB", {
        GITTENSORY_MINER_CONFIG_DIR: "/custom/config",
      }),
    ).toBe("/custom/config/thing.sqlite3");
    expect(
      resolveLocalStoreDbPath("thing.sqlite3", "GITTENSORY_MINER_THING_DB", { XDG_CONFIG_HOME: "/xdg" }),
    ).toBe("/xdg/gittensory-miner/thing.sqlite3");
    expect(resolveLocalStoreDbPath("thing.sqlite3", "GITTENSORY_MINER_THING_DB", {})).toMatch(
      /\/\.config\/gittensory-miner\/thing\.sqlite3$/,
    );
  });

  it("normalizeLocalStoreDbPath trims a valid path and rejects an empty/non-string one with the caller's error", () => {
    expect(normalizeLocalStoreDbPath(" /a/b.sqlite3 ", "/default.sqlite3", "invalid_thing_db_path")).toBe(
      "/a/b.sqlite3",
    );
    expect(normalizeLocalStoreDbPath(undefined, "/default.sqlite3", "invalid_thing_db_path")).toBe(
      "/default.sqlite3",
    );
    expect(() => normalizeLocalStoreDbPath("   ", "/default.sqlite3", "invalid_thing_db_path")).toThrow(
      "invalid_thing_db_path",
    );
    expect(() =>
      normalizeLocalStoreDbPath(42 as unknown as string, "/default.sqlite3", "invalid_thing_db_path"),
    ).toThrow("invalid_thing_db_path");
  });

  it("openLocalStoreDb creates parent dirs with 0700, the file with 0600, and applies the busy-timeout pragma", () => {
    const dbPath = join(tempRoot(), "nested", "thing.sqlite3");
    const db = openLocalStoreDb(dbPath);
    dbs.push(db);
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).mode & 0o077).toBe(0);
    const { timeout } = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(timeout).toBe(5000);
  });

  it("openLocalStoreDb accepts a custom busyTimeoutMs", () => {
    const dbPath = join(tempRoot(), "thing.sqlite3");
    const db = openLocalStoreDb(dbPath, { busyTimeoutMs: 1234 });
    dbs.push(db);
    const { timeout } = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(timeout).toBe(1234);
  });

  it("openLocalStoreDb skips mkdir/chmod for the special ':memory:' path", () => {
    const db = openLocalStoreDb(":memory:");
    dbs.push(db);
    db.exec("CREATE TABLE t (id INTEGER)");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 't'").get()).toEqual({ name: "t" });
  });

  it("regression: the four migrated stores still resolve to independent files, and each on-disk file only has its own table (#4272)", () => {
    const configDir = tempRoot();

    const runStatePath = resolveRunStateDbPath({ GITTENSORY_MINER_CONFIG_DIR: configDir });
    const claimLedgerPath = resolveClaimLedgerDbPath({ GITTENSORY_MINER_CONFIG_DIR: configDir });
    const portfolioQueuePath = resolvePortfolioQueueDbPath({ GITTENSORY_MINER_CONFIG_DIR: configDir });
    const eventLedgerPath = resolveEventLedgerDbPath({ GITTENSORY_MINER_CONFIG_DIR: configDir });

    const paths = [runStatePath, claimLedgerPath, portfolioQueuePath, eventLedgerPath];
    expect(new Set(paths).size).toBe(paths.length); // no accidental merge into one shared file

    const runStateStore = initRunStateStore(runStatePath);
    const claimLedger = openClaimLedger(claimLedgerPath);
    const portfolioQueue = initPortfolioQueueStore(portfolioQueuePath);
    const eventLedger = initEventLedger(eventLedgerPath);
    dbs.push(runStateStore, claimLedger, portfolioQueue, eventLedger);

    runStateStore.setRunState("acme/widgets", "planning");
    claimLedger.claimIssue("acme/widgets", 1);
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "pr:1" });
    eventLedger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: {} });

    const allTables = ["miner_run_state", "miner_claims", "miner_portfolio_queue", "miner_event_ledger"];
    for (const [path, table] of [
      [runStatePath, "miner_run_state"],
      [claimLedgerPath, "miner_claims"],
      [portfolioQueuePath, "miner_portfolio_queue"],
      [eventLedgerPath, "miner_event_ledger"],
    ] as const) {
      const inspect = new DatabaseSync(path, { readOnly: true });
      try {
        const tables = inspect
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => (row as { name: string }).name);
        // Its own table is present; none of the OTHER three stores' tables leaked in (no accidental merge).
        // `sqlite_sequence` may also be present -- SQLite creates it automatically for AUTOINCREMENT tables.
        expect(tables).toContain(table);
        for (const otherTable of allTables) {
          if (otherTable !== table) expect(tables).not.toContain(otherTable);
        }
      } finally {
        inspect.close();
      }
    }

    expect(runStateStore.getRunState("acme/widgets")).toBe("planning");
    expect(claimLedger.listActiveClaims("acme/widgets")).toHaveLength(1);
    expect(portfolioQueue.listQueue("acme/widgets")).toHaveLength(1);
    expect(eventLedger.readEvents({ repoFullName: "acme/widgets" })).toHaveLength(1);
  });
});
