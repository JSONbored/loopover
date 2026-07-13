import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBackup, runBackupChecks, runRestore, runRestoreChecks } from "../../packages/gittensory-miner/lib/backup-cli.js";
import { initPortfolioQueueStore, resolvePortfolioQueueDbPath } from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import { resolveEventLedgerDbPath } from "../../packages/gittensory-miner/lib/event-ledger.js";

const roots: string[] = [];

function tempEnv() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-backup-"));
  roots.push(root);
  return { GITTENSORY_MINER_CONFIG_DIR: join(root, "state"), root };
}

function tempDestDir() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-backup-dest-"));
  roots.push(root);
  return join(root, "backup");
}

const STORE_NAMES = [
  "laptop-state",
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

describe("gittensory-miner backup/restore (#4872)", () => {
  it("covers all eight local stores, in a stable order, and skips every one when nothing has been created yet (never creating them as a side effect)", async () => {
    const { root, ...env } = tempEnv();
    const destDir = join(root, "backup");
    const results = await runBackupChecks(destDir, env);

    expect(results.map((result) => result.name)).toEqual(STORE_NAMES);
    for (const result of results) {
      expect(result.ok).toBe(true);
      expect(result.status).toBe("skipped");
      expect(result.detail).toBe("not created yet");
      expect(existsSync(result.sourcePath)).toBe(false);
    }
  });

  it("backs up an existing store's real data via the safe online-backup API, and restore round-trips it byte-for-byte readable", async () => {
    const { root, ...env } = tempEnv();
    const store = initPortfolioQueueStore(resolvePortfolioQueueDbPath(env));
    store.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", priority: 5 });
    store.close();

    const destDir = tempDestDir();
    const backupResults = await runBackupChecks(destDir, env);
    const portfolioBackup = backupResults.find((result) => result.name === "portfolio-queue");
    expect(portfolioBackup).toMatchObject({ ok: true, status: "backed-up" });
    expect(existsSync(portfolioBackup!.destPath)).toBe(true);

    const restoreEnv = { GITTENSORY_MINER_CONFIG_DIR: join(root, "restored-state") };
    const restoreResults = runRestoreChecks(destDir, restoreEnv, false);
    const portfolioRestore = restoreResults.find((result) => result.name === "portfolio-queue");
    expect(portfolioRestore).toMatchObject({ ok: true, status: "restored" });

    const restoredStore = initPortfolioQueueStore(resolvePortfolioQueueDbPath(restoreEnv));
    try {
      expect(restoredStore.listQueue()).toEqual([
        expect.objectContaining({ repoFullName: "acme/widgets", identifier: "issue:1" }),
      ]);
    } finally {
      restoredStore.close();
    }
  });

  it("skips restoring a store with no matching backup file, without touching the real destination", () => {
    const { root, ...env } = tempEnv();
    const emptyBackupDir = mkdtempSync(join(tmpdir(), "gittensory-miner-empty-backup-"));
    roots.push(emptyBackupDir);

    const results = runRestoreChecks(emptyBackupDir, env, false);
    for (const result of results) {
      expect(result.ok).toBe(true);
      expect(result.status).toBe("skipped");
      expect(result.detail).toBe("no backup file found");
      expect(existsSync(result.destPath)).toBe(false);
    }
  });

  it("refuses to overwrite an existing destination file without --force, and succeeds once --force is passed", async () => {
    const { root, ...env } = tempEnv();
    const store = initPortfolioQueueStore(resolvePortfolioQueueDbPath(env));
    store.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", priority: 5 });
    store.close();
    const destDir = tempDestDir();
    await runBackupChecks(destDir, env);

    // Restore into the SAME env: the destination already exists (it's the store we just backed up).
    const withoutForce = runRestoreChecks(destDir, env, false);
    const portfolioWithoutForce = withoutForce.find((result) => result.name === "portfolio-queue");
    expect(portfolioWithoutForce).toMatchObject({ ok: false, status: "exists" });
    expect(portfolioWithoutForce?.detail).toContain("--force");

    const withForce = runRestoreChecks(destDir, env, true);
    const portfolioWithForce = withForce.find((result) => result.name === "portfolio-queue");
    expect(portfolioWithForce).toMatchObject({ ok: true, status: "restored" });
  });

  it("reports a failed backup (and leaves every other store's own result untouched) when one source store file is corrupted", async () => {
    const { root, ...env } = tempEnv();
    const eventLedgerPath = resolveEventLedgerDbPath(env);
    mkdirSync(join(eventLedgerPath, ".."), { recursive: true });
    writeFileSync(eventLedgerPath, "this is not a sqlite database");

    const destDir = tempDestDir();
    const results = await runBackupChecks(destDir, env);
    const eventLedger = results.find((result) => result.name === "event-ledger");
    const others = results.filter((result) => result.name !== "event-ledger");

    expect(eventLedger?.ok).toBe(false);
    expect(eventLedger?.status).toBe("failed");
    expect(typeof eventLedger?.detail).toBe("string");
    for (const other of others) expect(other.ok).toBe(true);
  });

  it("reports a failed restore (and leaves every other store's own result untouched) when copying one backup file fails", async () => {
    const { root, ...env } = tempEnv();
    const store = initPortfolioQueueStore(resolvePortfolioQueueDbPath(env));
    store.close();
    const destDir = tempDestDir();
    await runBackupChecks(destDir, env);

    // Corrupt the BACKUP FILE itself so the restore copy has something real to fail on, without needing a
    // permissions trick that may behave differently across CI runners.
    const backupFilePath = join(destDir, "portfolio-queue.sqlite3");
    rmSync(backupFilePath);
    mkdirSync(backupFilePath); // a directory where restore expects to copyFileSync a regular file

    const restoreEnv = { GITTENSORY_MINER_CONFIG_DIR: join(root, "restored-state") };
    const results = runRestoreChecks(destDir, restoreEnv, false);
    const portfolioQueue = results.find((result) => result.name === "portfolio-queue");
    const others = results.filter((result) => result.name !== "portfolio-queue");

    expect(portfolioQueue?.ok).toBe(false);
    expect(portfolioQueue?.status).toBe("failed");
    expect(typeof portfolioQueue?.detail).toBe("string");
    for (const other of others) expect(other.ok).toBe(true);
  });

  it("restored files are chmod 0600, matching every other store file's permissions", async () => {
    const { root, ...env } = tempEnv();
    const store = initPortfolioQueueStore(resolvePortfolioQueueDbPath(env));
    store.close();
    const destDir = tempDestDir();
    await runBackupChecks(destDir, env);

    const restoreEnv = { GITTENSORY_MINER_CONFIG_DIR: join(root, "restored-state") };
    const results = runRestoreChecks(destDir, restoreEnv, false);
    const portfolioQueue = results.find((result) => result.name === "portfolio-queue")!;
    const mode = statSync(portfolioQueue.destPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("runBackup requires a destDir argument and prints usage on stderr otherwise", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runBackup([], tempEnv())).toBe(2);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Usage: gittensory-miner backup"));
  });

  it("runRestore requires a srcDir argument and prints usage on stderr otherwise", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runRestore([], tempEnv())).toBe(2);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Usage: gittensory-miner restore"));
  });

  it("runBackup prints human-readable text (exit 0) and machine JSON with --json, and exits 1 when a store fails", async () => {
    const { root, ...healthyEnv } = tempEnv();
    const destDir = join(root, "backup");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runBackup([destDir], healthyEnv)).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("skipped");
    log.mockClear();

    expect(await runBackup([destDir, "--json"], healthyEnv)).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.ok).toBe(true);
    expect(payload.stores).toHaveLength(STORE_NAMES.length);

    const { root: brokenRoot, ...brokenEnv } = tempEnv();
    const eventLedgerPath = resolveEventLedgerDbPath(brokenEnv);
    mkdirSync(join(eventLedgerPath, ".."), { recursive: true });
    writeFileSync(eventLedgerPath, "this is not a sqlite database");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runBackup([join(brokenRoot, "backup")], brokenEnv)).toBe(1);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("1 store(s) failed"));
  });

  it("runRestore prints human-readable text (exit 0) and machine JSON with --json", async () => {
    const { root, ...env } = tempEnv();
    const destDir = join(root, "backup");
    await runBackup([destDir], env);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const restoreEnv = { GITTENSORY_MINER_CONFIG_DIR: join(root, "restored-state") };
    expect(runRestore([destDir], restoreEnv)).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("skipped");
    log.mockClear();

    const restoreEnv2 = { GITTENSORY_MINER_CONFIG_DIR: join(root, "restored-state-2") };
    expect(runRestore([destDir, "--json"], restoreEnv2)).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.ok).toBe(true);
    expect(payload.stores).toHaveLength(STORE_NAMES.length);
  });

  it("runRestore itself exits 1 and reports the failure count when a store fails", () => {
    const { root, ...env } = tempEnv();
    const store = initPortfolioQueueStore(resolvePortfolioQueueDbPath(env));
    store.close();
    const destDir = tempDestDir();
    return runBackup([destDir], env).then(() => {
      // Restoring into the SAME env without --force: the destination already exists (the store just backed up).
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(runRestore([destDir], env)).toBe(1);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("1 store(s) failed"));
      log.mockRestore();
    });
  });

  it("REGRESSION (gate-caught pattern, same as migrate-cli.js's #4871 fix): a throwing resolveDbPath is caught INSIDE backupStore/restoreStore, reporting one failed store instead of crashing the whole sweep", async () => {
    const { root, ...env } = tempEnv();
    const throwingStore = {
      name: "fake-store",
      resolveDbPath: () => {
        throw "boom"; // deliberately non-Error, exercising the ternary's fallback branch too
      },
    };

    const backupResults = await runBackupChecks(join(root, "backup"), env, [throwingStore]);
    expect(backupResults).toEqual([
      { name: "fake-store", ok: false, status: "failed", detail: "boom", sourcePath: null, destPath: null },
    ]);

    const restoreResults = runRestoreChecks(join(root, "backup"), env, false, [throwingStore]);
    expect(restoreResults).toEqual([
      {
        name: "fake-store",
        ok: false,
        status: "failed",
        detail: "boom",
        sourcePath: join(root, "backup", "fake-store.sqlite3"), // resolved before the throwing resolveDbPath call
        destPath: null,
      },
    ]);
  });

  it("makes no network calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { root, ...env } = tempEnv();
    await runBackupChecks(join(root, "backup"), env);
    runRestoreChecks(join(root, "backup"), env, false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
