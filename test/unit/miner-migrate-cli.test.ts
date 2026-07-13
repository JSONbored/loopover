import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMigrate, runMigrateChecks } from "../../packages/gittensory-miner/lib/migrate-cli.js";
import { initPortfolioQueueStore, resolvePortfolioQueueDbPath } from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import { resolveEventLedgerDbPath } from "../../packages/gittensory-miner/lib/event-ledger.js";

const roots: string[] = [];

function tempEnv() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-migrate-"));
  roots.push(root);
  return { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
}

const STORE_NAMES = [
  "event-ledger",
  "governor-ledger",
  "prediction-ledger",
  "portfolio-queue",
  "claim-ledger",
  "run-state",
  "plan-store",
];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner migrate (#4871)", () => {
  it("covers the exact same seven stores doctor's store-integrity sweep covers, in the same order, and skips every one when nothing has been created yet", () => {
    const env = tempEnv();
    const results = runMigrateChecks(env);

    expect(results.map((result) => result.name)).toEqual(STORE_NAMES);
    for (const result of results) {
      expect(result.ok).toBe(true);
      expect(result.status).toBe("skipped");
      expect(result.detail).toBe("not created yet");
      expect(result.versionBefore).toBeNull();
      expect(result.versionAfter).toBeNull();
      // Invariant: a skip must never create the file as a side effect -- migrate brings EXISTING stores up
      // to date, it is not another way to bootstrap fresh state.
      expect(existsSync(result.dbPath)).toBe(false);
    }
  });

  it("reports 'up-to-date' for a store that was freshly initialized at its current target schema version", () => {
    const env = tempEnv();
    initPortfolioQueueStore(resolvePortfolioQueueDbPath(env)).close();

    const results = runMigrateChecks(env);
    const portfolioQueue = results.find((result) => result.name === "portfolio-queue");

    expect(portfolioQueue?.status).toBe("up-to-date");
    expect(portfolioQueue?.ok).toBe(true);
    expect(portfolioQueue?.versionBefore).toBe(portfolioQueue?.versionAfter);
    expect(portfolioQueue?.versionBefore).toBeGreaterThan(0);
  });

  it("actually migrates a pre-existing older-schema portfolio-queue file, bumping its stamped version and adding the missing column", () => {
    const env = tempEnv();
    const dbPath = resolvePortfolioQueueDbPath(env);
    mkdirSync(dirname(dbPath), { recursive: true });

    // Hand-build the PRE-#4832 baseline shape: no `leased_at` column, stamped at schema version 1 (the
    // baseline), simulating a real operator's on-disk file from before the leased_at migration existed.
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      CREATE TABLE miner_portfolio_queue (
        repo_full_name TEXT NOT NULL,
        identifier TEXT NOT NULL,
        priority REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'done')),
        enqueued_at TEXT NOT NULL,
        PRIMARY KEY (repo_full_name, identifier)
      )
    `);
    seedDb.exec("PRAGMA user_version = 1");
    seedDb.close();

    const results = runMigrateChecks(env);
    const portfolioQueue = results.find((result) => result.name === "portfolio-queue");

    // Runs BOTH post-baseline migrations in sequence: v1->v2 adds leased_at, v2->v3 adds api_base_url (#5563).
    expect(portfolioQueue).toMatchObject({ ok: true, status: "migrated", versionBefore: 1, versionAfter: 3 });

    const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const columns = verifyDb.prepare("PRAGMA table_info(miner_portfolio_queue)").all().map((column) => column.name);
      expect(columns).toContain("leased_at");
      expect(columns).toContain("api_base_url");
      expect(verifyDb.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    } finally {
      verifyDb.close();
    }
  });

  it("reports a failed store (and leaves every other store's own result untouched) when one store file is corrupted", () => {
    const env = tempEnv();
    const eventLedgerPath = resolveEventLedgerDbPath(env);
    mkdirSync(dirname(eventLedgerPath), { recursive: true });
    writeFileSync(eventLedgerPath, "this is not a sqlite database");

    const results = runMigrateChecks(env);
    const eventLedger = results.find((result) => result.name === "event-ledger");
    const others = results.filter((result) => result.name !== "event-ledger");

    expect(eventLedger?.ok).toBe(false);
    expect(eventLedger?.status).toBe("failed");
    expect(typeof eventLedger?.detail).toBe("string");
    for (const other of others) expect(other.ok).toBe(true);
  });

  it("formats a non-Error thrown value into a detail string (defensive fallback: real node:sqlite failures always throw Error, but the fallback path is still real code)", () => {
    const env = tempEnv();
    const dbPath = join(dirname(resolvePortfolioQueueDbPath(env)), "fake-store.sqlite3");
    mkdirSync(dirname(dbPath), { recursive: true });
    new DatabaseSync(dbPath).close(); // a valid, openable, empty sqlite file (schema version 0)

    const results = runMigrateChecks(env, [
      {
        name: "fake-store",
        resolveDbPath: () => dbPath,
        open: () => {
          throw "boom"; // deliberately non-Error, exercising the ternary's fallback branch
        },
      },
    ]);

    expect(results).toEqual([
      { name: "fake-store", dbPath, ok: false, status: "failed", detail: "boom", versionBefore: 0, versionAfter: 0 },
    ]);
  });

  it("runMigrate prints human-readable text (exit 0) and machine JSON with --json, and exits 1 when a store fails", () => {
    const healthyEnv = tempEnv();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runMigrate([], healthyEnv)).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("skipped");
    log.mockClear();

    expect(runMigrate(["--json"], healthyEnv)).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.ok).toBe(true);
    expect(payload.stores).toHaveLength(STORE_NAMES.length);

    const brokenEnv = tempEnv();
    const eventLedgerPath = resolveEventLedgerDbPath(brokenEnv);
    mkdirSync(dirname(eventLedgerPath), { recursive: true });
    writeFileSync(eventLedgerPath, "this is not a sqlite database");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runMigrate([], brokenEnv)).toBe(1);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("1 store(s) failed"));
  });

  it("makes no network calls", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    runMigrateChecks(tempEnv());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
