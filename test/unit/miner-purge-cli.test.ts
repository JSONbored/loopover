import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openClaimLedger, closeDefaultClaimLedger } from "../../packages/gittensory-miner/lib/claim-ledger.js";
import { initEventLedger, closeDefaultEventLedger } from "../../packages/gittensory-miner/lib/event-ledger.js";
import { initGovernorLedger, closeDefaultGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";
import { initPredictionLedger, closeDefaultPredictionLedger } from "../../packages/gittensory-miner/lib/prediction-ledger.js";
import { initAttemptLog, closeDefaultAttemptLog } from "../../packages/gittensory-miner/lib/attempt-log.js";
import {
  ATTEMPT_LOG_NOT_PURGEABLE_NOTE,
  parsePurgeArgs,
  runPurge,
} from "../../packages/gittensory-miner/lib/purge-cli.js";

const roots: string[] = [];
const closeables: Array<{ close(): void }> = [];

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-purge-cli-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const store of closeables.splice(0)) store.close();
  closeDefaultClaimLedger();
  closeDefaultEventLedger();
  closeDefaultGovernorLedger();
  closeDefaultPredictionLedger();
  closeDefaultAttemptLog();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parsePurgeArgs (#5564)", () => {
  it("requires --repo", () => {
    expect(parsePurgeArgs([])).toEqual({ error: expect.stringContaining("Usage: loopover-miner purge") });
  });

  it("parses --repo, --dry-run, and --json together", () => {
    expect(parsePurgeArgs(["--repo", "acme/widgets", "--dry-run", "--json"])).toEqual({
      json: true,
      dryRun: true,
      repoFullName: "acme/widgets",
    });
  });

  it("defaults dryRun and json to false", () => {
    expect(parsePurgeArgs(["--repo", "acme/widgets"])).toEqual({
      json: false,
      dryRun: false,
      repoFullName: "acme/widgets",
    });
  });

  it("rejects a malformed --repo value", () => {
    expect(parsePurgeArgs(["--repo", "no-slash"])).toEqual({ error: "Repository must be in owner/repo form." });
  });

  it("rejects a --repo flag missing its value", () => {
    expect(parsePurgeArgs(["--repo"])).toEqual({ error: expect.stringContaining("Usage: loopover-miner purge") });
    expect(parsePurgeArgs(["--repo", "--json"])).toEqual({ error: expect.stringContaining("Usage: loopover-miner purge") });
  });

  it("rejects an unknown option", () => {
    expect(parsePurgeArgs(["--repo", "acme/widgets", "--verbose"])).toEqual({ error: "Unknown option: --verbose" });
  });
});

describe("runPurge --dry-run (#5564)", () => {
  it("counts matching rows across the four real stores without writing anything, and reports attempt-log as not-purgeable", async () => {
    const root = tempDir();
    const claimDbPath = join(root, "claim-ledger.sqlite3");
    const eventDbPath = join(root, "event-ledger.sqlite3");
    const governorDbPath = join(root, "governor-ledger.sqlite3");
    const predictionDbPath = join(root, "prediction-ledger.sqlite3");
    const attemptLogDbPath = join(root, "attempt-log.sqlite3"); // never created — dry run must not touch it

    const claimLedger = openClaimLedger(claimDbPath);
    claimLedger.claimIssue("acme/widgets", 1);
    claimLedger.claimIssue("acme/widgets", 2);
    claimLedger.claimIssue("acme/other", 3);
    claimLedger.close();

    const eventLedger = initEventLedger(eventDbPath);
    eventLedger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: {} });
    eventLedger.close();

    const governorLedger = initGovernorLedger(governorDbPath);
    governorLedger.appendGovernorEvent({
      eventType: "allowed",
      repoFullName: "acme/widgets",
      actionClass: "analyze",
      decision: "allow",
      reason: "within budget",
    });
    governorLedger.close();

    // Prediction ledger has NO row for acme/widgets — exercises the "0 matches, store still exists" path.
    const predictionLedger = initPredictionLedger(predictionDbPath);
    predictionLedger.appendPrediction({
      repoFullName: "acme/other",
      targetId: 1,
      conclusion: "success",
      pack: "gittensor",
      engineVersion: "0.2.0",
    });
    predictionLedger.close();

    const resolveDbPaths = {
      "claim-ledger": () => claimDbPath,
      "event-ledger": () => eventDbPath,
      "governor-ledger": () => governorDbPath,
      "prediction-ledger": () => predictionDbPath,
      "attempt-log": () => attemptLogDbPath,
    };

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runPurge(["--repo", "acme/widgets", "--dry-run", "--json"], { resolveDbPaths })).toBe(0);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result).toMatchObject({
      outcome: "dry_run",
      repoFullName: "acme/widgets",
      stores: [
        { store: "claim-ledger", wouldPurge: 2 },
        { store: "event-ledger", wouldPurge: 1 },
        { store: "governor-ledger", wouldPurge: 1 },
        { store: "prediction-ledger", wouldPurge: 0 },
      ],
      attemptLogNote: ATTEMPT_LOG_NOT_PURGEABLE_NOTE,
      attemptLogTotalRows: 0,
    });
    // No writes: none of the store files' row counts changed, and attempt-log was never even created.
    expect(existsSync(attemptLogDbPath)).toBe(false);
    const reopenedClaim = openClaimLedger(claimDbPath);
    closeables.push(reopenedClaim);
    expect(reopenedClaim.listClaims()).toHaveLength(3);

    log.mockClear();
    expect(runPurge(["--repo", "acme/widgets", "--dry-run"], { resolveDbPaths })).toBe(0);
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("DRY RUN: would purge acme/widgets from:");
    expect(text).toContain("claim-ledger=2");
    expect(text).toContain(ATTEMPT_LOG_NOT_PURGEABLE_NOTE);
  });

  it("reports 0 for every store when none of the files exist yet, and creates nothing", () => {
    const root = tempDir();
    const resolveDbPaths = {
      "claim-ledger": () => join(root, "claim-ledger.sqlite3"),
      "event-ledger": () => join(root, "event-ledger.sqlite3"),
      "governor-ledger": () => join(root, "governor-ledger.sqlite3"),
      "prediction-ledger": () => join(root, "prediction-ledger.sqlite3"),
      "attempt-log": () => join(root, "attempt-log.sqlite3"),
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runPurge(["--repo", "acme/widgets", "--dry-run", "--json"], { resolveDbPaths })).toBe(0);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.stores.every((entry: { wouldPurge: number }) => entry.wouldPurge === 0)).toBe(true);
    expect(result.attemptLogTotalRows).toBe(0);
    for (const resolve of Object.values(resolveDbPaths)) {
      expect(existsSync(resolve())).toBe(false);
    }
  });

  it("reports the real attempt-log row total when the store already exists with rows", () => {
    const root = tempDir();
    const attemptLogDbPath = join(root, "attempt-log.sqlite3");
    const attemptLog = initAttemptLog(attemptLogDbPath);
    attemptLog.appendAttemptLogEvent({
      eventType: "attempt_started",
      attemptId: "attempt-1",
      actionClass: "codegen",
      mode: "live",
      reason: "live run",
    });
    attemptLog.appendAttemptLogEvent({
      eventType: "attempt_succeeded",
      attemptId: "attempt-1",
      actionClass: "codegen",
      mode: "live",
      reason: "done",
    });
    attemptLog.close();

    const resolveDbPaths = {
      "claim-ledger": () => join(root, "claim-ledger.sqlite3"),
      "event-ledger": () => join(root, "event-ledger.sqlite3"),
      "governor-ledger": () => join(root, "governor-ledger.sqlite3"),
      "prediction-ledger": () => join(root, "prediction-ledger.sqlite3"),
      "attempt-log": () => attemptLogDbPath,
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runPurge(["--repo", "acme/widgets", "--dry-run", "--json"], { resolveDbPaths })).toBe(0);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.attemptLogTotalRows).toBe(2);
  });

  it("reports a per-store error and continues the others when a store file is corrupted", () => {
    const root = tempDir();
    const claimDbPath = join(root, "claim-ledger.sqlite3");
    writeFileSync(claimDbPath, "this is not a sqlite database");

    const eventDbPath = join(root, "event-ledger.sqlite3");
    const eventLedger = initEventLedger(eventDbPath);
    eventLedger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: {} });
    eventLedger.close();

    const resolveDbPaths = {
      "claim-ledger": () => claimDbPath,
      "event-ledger": () => eventDbPath,
      "governor-ledger": () => join(root, "governor-ledger.sqlite3"),
      "prediction-ledger": () => join(root, "prediction-ledger.sqlite3"),
      "attempt-log": () => join(root, "attempt-log.sqlite3"),
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runPurge(["--repo", "acme/widgets", "--dry-run", "--json"], { resolveDbPaths })).toBe(0);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    const claimEntry = result.stores.find((entry: { store: string }) => entry.store === "claim-ledger");
    expect(claimEntry.wouldPurge).toBeNull();
    expect(typeof claimEntry.error).toBe("string");
    // The corrupted store's failure doesn't stop the others from being counted.
    expect(result.stores.find((entry: { store: string }) => entry.store === "event-ledger")).toMatchObject({
      wouldPurge: 1,
    });
  });

  it("prints an argument error without opening or counting anything", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runPurge([])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Usage: loopover-miner purge"));
  });

  it("opens the real default on-disk stores in dry-run when no resolveDbPaths override is supplied", () => {
    const root = tempDir();
    const previousDirs: Record<string, string | undefined> = {
      LOOPOVER_MINER_CLAIM_LEDGER_DB: process.env.LOOPOVER_MINER_CLAIM_LEDGER_DB,
      LOOPOVER_MINER_EVENT_LEDGER_DB: process.env.LOOPOVER_MINER_EVENT_LEDGER_DB,
      LOOPOVER_MINER_GOVERNOR_LEDGER_DB: process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB,
      LOOPOVER_MINER_PREDICTION_LEDGER_DB: process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB,
      LOOPOVER_MINER_ATTEMPT_LOG_DB: process.env.LOOPOVER_MINER_ATTEMPT_LOG_DB,
    };
    process.env.LOOPOVER_MINER_CLAIM_LEDGER_DB = join(root, "claim-ledger.sqlite3");
    process.env.LOOPOVER_MINER_EVENT_LEDGER_DB = join(root, "event-ledger.sqlite3");
    process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB = join(root, "governor-ledger.sqlite3");
    process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB = join(root, "prediction-ledger.sqlite3");
    process.env.LOOPOVER_MINER_ATTEMPT_LOG_DB = join(root, "attempt-log.sqlite3");
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(runPurge(["--repo", "acme/widgets", "--dry-run", "--json"])).toBe(0);
      const result = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(result.stores.every((entry: { wouldPurge: number }) => entry.wouldPurge === 0)).toBe(true);
      // Nothing was created — dry run against nonexistent default-path stores makes zero writes.
      expect(existsSync(process.env.LOOPOVER_MINER_CLAIM_LEDGER_DB)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previousDirs)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("runPurge (real, #5564)", () => {
  function fakeStore(purged: number) {
    const store = { purgeByRepo: vi.fn(() => purged), close: vi.fn() };
    closeables.push(store);
    return store;
  }

  it("purges every injected store, reports a per-store + total summary, and marks attempt-log as skipped", () => {
    const claim = fakeStore(2);
    const event = fakeStore(1);
    const governor = fakeStore(0);
    const prediction = fakeStore(3);
    const options = {
      openClaimLedger: () => claim,
      initEventLedger: () => event,
      initGovernorLedger: () => governor,
      initPredictionLedger: () => prediction,
    };

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runPurge(["--repo", "acme/widgets", "--json"], options as never)).toBe(0);
    const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(summary).toMatchObject({
      outcome: "purged",
      repoFullName: "acme/widgets",
      totalPurged: 6,
      stores: [
        { store: "claim-ledger", purged: 2 },
        { store: "event-ledger", purged: 1 },
        { store: "governor-ledger", purged: 0 },
        { store: "prediction-ledger", purged: 3 },
        { store: "attempt-log", purged: null, note: ATTEMPT_LOG_NOT_PURGEABLE_NOTE },
      ],
    });
    expect(typeof summary.purgedAt).toBe("string");
    for (const store of [claim, event, governor, prediction]) {
      expect(store.purgeByRepo).toHaveBeenCalledWith("acme/widgets");
    }
    // Injected stores are caller-owned: runPurge must not close them.
    for (const store of [claim, event, governor, prediction]) {
      expect(store.close).not.toHaveBeenCalled();
    }

    log.mockClear();
    expect(runPurge(["--repo", "acme/widgets"], options as never)).toBe(0);
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("Purged 6 row(s) for acme/widgets");
    expect(text).toContain("claim-ledger=2");
    expect(text).toContain(ATTEMPT_LOG_NOT_PURGEABLE_NOTE);
  });

  it("is audit-observable on a PARTIAL failure: reports what succeeded, flags the failed store, and exits 2", () => {
    const claim = fakeStore(2);
    const event = fakeStore(1);
    const governorOpenError = new Error("governor-ledger disk full");
    const prediction = fakeStore(3);
    const options = {
      openClaimLedger: () => claim,
      initEventLedger: () => event,
      initGovernorLedger: () => {
        throw governorOpenError;
      },
      initPredictionLedger: () => prediction,
    };

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runPurge(["--repo", "acme/widgets", "--json"], options as never)).toBe(2);
    const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(summary.outcome).toBe("partial");
    // Everything that DID succeed is still reported, not swallowed by the one failure.
    expect(summary.totalPurged).toBe(6); // claim(2) + event(1) + prediction(3); governor contributes 0 (null)
    expect(summary.stores).toContainEqual({ store: "claim-ledger", purged: 2 });
    expect(summary.stores).toContainEqual({ store: "event-ledger", purged: 1 });
    expect(summary.stores).toContainEqual({ store: "prediction-ledger", purged: 3 });
    expect(summary.stores).toContainEqual({ store: "governor-ledger", purged: null, error: "governor-ledger disk full" });

    log.mockClear();
    expect(runPurge(["--repo", "acme/widgets"], options as never)).toBe(2);
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("governor-ledger=ERROR(governor-ledger disk full)");
    expect(text).toContain("claim-ledger=2");
  });

  it("surfaces a non-Error thrown open failure as a string", () => {
    const claim = fakeStore(1);
    const options = {
      openClaimLedger: () => claim,
      initEventLedger: () => {
        throw "raw_string_fault";
      },
      initGovernorLedger: () => fakeStore(0),
      initPredictionLedger: () => fakeStore(0),
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runPurge(["--repo", "acme/widgets", "--json"], options as never)).toBe(2);
    const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(summary.stores).toContainEqual({ store: "event-ledger", purged: null, error: "raw_string_fault" });
  });

  it("surfaces a purgeByRepo call failure (not just an open failure) as a per-store error", () => {
    const throwingStore = { purgeByRepo: vi.fn(() => { throw new Error("locked"); }), close: vi.fn() };
    closeables.push(throwingStore);
    const options = {
      openClaimLedger: () => throwingStore,
      initEventLedger: () => fakeStore(0),
      initGovernorLedger: () => fakeStore(0),
      initPredictionLedger: () => fakeStore(0),
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runPurge(["--repo", "acme/widgets", "--json"], options as never)).toBe(2);
    const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(summary.stores).toContainEqual({ store: "claim-ledger", purged: null, error: "locked" });
    // DI-injected (caller-owned) here, same as every other options override — runPurge must not close a store
    // it didn't open itself, even when that store's purgeByRepo call fails.
    expect(throwingStore.close).not.toHaveBeenCalled();
  });

  it("opens and closes the real default on-disk stores when no override is supplied (owned stores)", () => {
    const root = tempDir();
    const previousDirs: Record<string, string | undefined> = {
      LOOPOVER_MINER_CLAIM_LEDGER_DB: process.env.LOOPOVER_MINER_CLAIM_LEDGER_DB,
      LOOPOVER_MINER_EVENT_LEDGER_DB: process.env.LOOPOVER_MINER_EVENT_LEDGER_DB,
      LOOPOVER_MINER_GOVERNOR_LEDGER_DB: process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB,
      LOOPOVER_MINER_PREDICTION_LEDGER_DB: process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB,
    };
    const claimDbPath = join(root, "claim-ledger.sqlite3");
    process.env.LOOPOVER_MINER_CLAIM_LEDGER_DB = claimDbPath;
    process.env.LOOPOVER_MINER_EVENT_LEDGER_DB = join(root, "event-ledger.sqlite3");
    process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB = join(root, "governor-ledger.sqlite3");
    process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB = join(root, "prediction-ledger.sqlite3");
    try {
      // Seed a real claim via the default store path before purging through it.
      const seeded = openClaimLedger(claimDbPath);
      seeded.claimIssue("acme/widgets", 1);
      seeded.close();

      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(runPurge(["--repo", "acme/widgets", "--json"])).toBe(0);
      const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(summary.stores.find((entry: { store: string }) => entry.store === "claim-ledger")).toMatchObject({
        purged: 1,
      });

      // Reopening confirms the purge was actually persisted through the default (owned, closed) code path.
      const reopened = openClaimLedger(claimDbPath);
      closeables.push(reopened);
      expect(reopened.listClaims()).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(previousDirs)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
