import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runQueueClaimBatch,
  parseQueueClaimBatchArgs,
} from "../../packages/gittensory-miner/lib/portfolio-queue-cli.js";
import { initPortfolioQueueManager } from "../../packages/gittensory-miner/lib/portfolio-queue-manager.js";
import { initPortfolioQueueStore } from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import {
  runOrbExportCli,
  parseOrbExportArgs,
  openOrbExportStore,
} from "../../packages/gittensory-miner/lib/orb-export.js";
import { initEventLedger } from "../../packages/gittensory-miner/lib/event-ledger.js";
import { recordPrOutcomeSnapshot } from "../../packages/gittensory-miner/lib/pr-outcome.js";

const roots: string[] = [];
const closeables: Array<{ close(): void }> = [];
let logs: string[] = [];

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-wire-cli-"));
  roots.push(root);
  return root;
}

function captureLog() {
  logs = [];
  return vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const c of closeables.splice(0)) c.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("queue claim-batch — wires the WIP-cap-aware batch claimer (#4833)", () => {
  it("parses the wip flags, rejecting a non-numeric/negative value", () => {
    expect(parseQueueClaimBatchArgs(["--global-wip", "3", "--per-repo-wip", "1", "--json"])).toEqual({
      json: true,
      dryRun: false,
      globalWipCap: 3,
      perRepoWipCap: 1,
    });
    expect(parseQueueClaimBatchArgs(["--global-wip", "x"])).toHaveProperty("error");
    expect(parseQueueClaimBatchArgs(["--per-repo-wip", "-1"])).toHaveProperty("error");
    expect(parseQueueClaimBatchArgs(["--bogus"])).toHaveProperty("error");
  });

  it("#4847: --dry-run reports what a claim would do and returns 0 without opening the manager", () => {
    const initPortfolioQueueManagerSpy = vi.fn();
    const spy = captureLog();

    const jsonCode = runQueueClaimBatch(["--global-wip", "3", "--per-repo-wip", "2", "--dry-run", "--json"], {
      initPortfolioQueueManager: initPortfolioQueueManagerSpy,
    });
    expect(jsonCode).toBe(0);
    expect(initPortfolioQueueManagerSpy).not.toHaveBeenCalled();
    expect(JSON.parse(logs.join(""))).toEqual({ outcome: "dry_run", globalWipCap: 3, perRepoWipCap: 2 });

    logs = [];
    const textCode = runQueueClaimBatch(["--dry-run"], { initPortfolioQueueManager: initPortfolioQueueManagerSpy });
    expect(textCode).toBe(0);
    expect(logs.join("")).toContain("DRY RUN: would claim a batch (global-wip: 1, per-repo-wip: 1)");
    spy.mockRestore();
  });

  it("claims a diversified batch across repos via the manager", () => {
    const store = initPortfolioQueueStore(join(tempDir(), "q.sqlite3"));
    closeables.push(store);
    const manager = initPortfolioQueueManager({ store, caps: { globalWipCap: 2, perRepoWipCap: 1 } });
    manager.enqueue({ repoFullName: "o/a", identifier: "1" });
    manager.enqueue({ repoFullName: "o/b", identifier: "2" });

    const spy = captureLog();
    const code = runQueueClaimBatch(["--json"], { initPortfolioQueueManager: () => manager });
    spy.mockRestore();

    expect(code).toBe(0);
    const out = JSON.parse(logs.join(""));
    expect(out.claimed.map((e: { identifier: string }) => e.identifier).sort()).toEqual(["1", "2"]);
    // Both are now in_progress (claimed), so a second claim yields nothing.
    expect(store.listInProgress()).toHaveLength(2);
  });

  it("prints 'none' when the queue is empty", () => {
    const store = initPortfolioQueueStore(join(tempDir(), "q.sqlite3"));
    closeables.push(store);
    const manager = initPortfolioQueueManager({ store, caps: { globalWipCap: 1, perRepoWipCap: 1 } });
    const spy = captureLog();
    const code = runQueueClaimBatch([], { initPortfolioQueueManager: () => manager });
    spy.mockRestore();
    expect(code).toBe(0);
    expect(logs.join("")).toBe("none");
  });

  it("returns 2 (not a crash) when the manager fails to open", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = runQueueClaimBatch(["--json"], {
      initPortfolioQueueManager: () => {
        throw new Error("bad_store_path");
      },
    });
    errSpy.mockRestore();
    expect(code).toBe(2);
  });
});

describe("orb export — wires the anonymized telemetry batch-builder (#4833)", () => {
  const stores = () => {
    const dir = tempDir();
    const store = openOrbExportStore(join(dir, "orb.sqlite3"));
    const ledger = initEventLedger(join(dir, "ledger.sqlite3"));
    closeables.push(store, ledger);
    return { openOrbExportStore: () => store, initEventLedger: () => ledger };
  };

  it("#4847: --dry-run reports what an export would do and returns 0 without opening any store", async () => {
    const openOrbExportStoreSpy = vi.fn();
    const initEventLedgerSpy = vi.fn();
    const spy = captureLog();

    const disabledCode = await runOrbExportCli(["--dry-run", "--json"], {
      openOrbExportStore: openOrbExportStoreSpy,
      initEventLedger: initEventLedgerSpy,
    });
    expect(disabledCode).toBe(0);
    expect(openOrbExportStoreSpy).not.toHaveBeenCalled();
    expect(initEventLedgerSpy).not.toHaveBeenCalled();
    expect(JSON.parse(logs.join(""))).toEqual({ outcome: "dry_run", enabled: false, send: false });

    logs = [];
    const enabledCode = await runOrbExportCli(["--enable", "--dry-run"], {
      openOrbExportStore: openOrbExportStoreSpy,
      initEventLedger: initEventLedgerSpy,
    });
    expect(enabledCode).toBe(0);
    expect(openOrbExportStoreSpy).not.toHaveBeenCalled();
    expect(logs.join("")).toContain("DRY RUN: would build and report an anonymized Orb export batch");

    logs = [];
    const enabledSendCode = await runOrbExportCli(["--enable", "--send", "--dry-run"], {
      openOrbExportStore: openOrbExportStoreSpy,
      initEventLedger: initEventLedgerSpy,
    });
    expect(enabledSendCode).toBe(0);
    expect(openOrbExportStoreSpy).not.toHaveBeenCalled();
    expect(logs.join("")).toContain("DRY RUN: would build an anonymized Orb export batch and send it to the collector");

    logs = [];
    const disabledTextCode = await runOrbExportCli(["--dry-run"], {
      openOrbExportStore: openOrbExportStoreSpy,
      initEventLedger: initEventLedgerSpy,
    });
    expect(disabledTextCode).toBe(0);
    expect(openOrbExportStoreSpy).not.toHaveBeenCalled();
    expect(logs.join("")).toContain("DRY RUN: orb export is opt-in and disabled — pass --enable");
    spy.mockRestore();
  });

  it("is opt-in: exports nothing (null batch) without --enable", async () => {
    const spy = captureLog();
    const code = await runOrbExportCli(["--json"], stores());
    spy.mockRestore();
    expect(code).toBe(0);
    expect(JSON.parse(logs.join(""))).toEqual({ enabled: false, batch: null });
  });

  it("builds (but does not send) an anonymized batch when --enable is passed without --send (empty ledger → empty batch)", async () => {
    const spy = captureLog();
    const code = await runOrbExportCli(["--enable", "--json"], stores());
    spy.mockRestore();
    expect(code).toBe(0);
    expect(JSON.parse(logs.join(""))).toEqual({ enabled: true, sent: false, batch: [] });
  });

  it("--enable --send with an empty batch reports 0 sent without invoking the sender", async () => {
    const sendSpy = vi.fn();
    const spy = captureLog();
    const code = await runOrbExportCli(["--enable", "--send", "--json"], { ...stores(), sendAmsExportBatch: sendSpy });
    spy.mockRestore();
    expect(code).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(JSON.parse(logs.join(""))).toEqual({ enabled: true, sent: 0, skipped: 0 });
  });

  it("text mode: reports opt-in-disabled, enable-without-send, and no-new-events phrasing", async () => {
    const spy = captureLog();

    let code = await runOrbExportCli([], stores());
    expect(code).toBe(0);
    expect(logs.join("")).toBe("orb export is opt-in and disabled — pass --enable to build an anonymized batch");

    logs = [];
    code = await runOrbExportCli(["--enable"], stores());
    expect(code).toBe(0);
    expect(logs.join("")).toBe("0 anonymized event(s) — pass --send to transmit them to the collector");

    logs = [];
    code = await runOrbExportCli(["--enable", "--send"], { ...stores(), sendAmsExportBatch: vi.fn() });
    expect(code).toBe(0);
    expect(logs.join("")).toBe("no new events since the last export");

    spy.mockRestore();
  });

  it("REGRESSION (#5681): --enable --send actually delivers a real seeded outcome, advances the cursor, and a re-run sends nothing new", async () => {
    const s = stores();
    const store = s.openOrbExportStore();
    const ledger = s.initEventLedger();
    recordPrOutcomeSnapshot(
      { repoFullName: "acme/widgets", prNumber: 7, decision: "merged", closedAt: "2026-01-01T00:00:00Z", reason: null },
      { eventLedger: ledger },
    );

    const sendAmsExportBatchSpy = vi.fn().mockResolvedValue({ sent: 1 });
    const spy = captureLog();
    const code = await runOrbExportCli(["--enable", "--send", "--json"], { ...s, sendAmsExportBatch: sendAmsExportBatchSpy });
    spy.mockRestore();

    expect(code).toBe(0);
    expect(sendAmsExportBatchSpy).toHaveBeenCalledTimes(1);
    const call = sendAmsExportBatchSpy.mock.calls[0]![0] as { batch: unknown[]; secret: string };
    expect(call.batch).toHaveLength(1);
    expect(typeof call.secret).toBe("string");
    expect(JSON.parse(logs.join(""))).toEqual({ enabled: true, sent: 1, skipped: 0 });
    expect(store.getCursor()).toBe("2026-01-01T00:00:00Z"); // cursor advanced to the sent row's closedAt

    // Re-run: the same outcome is now at/before the cursor, so nothing new is sent.
    logs = [];
    const secondSpy = captureLog();
    const secondCode = await runOrbExportCli(["--enable", "--send", "--json"], { ...s, sendAmsExportBatch: sendAmsExportBatchSpy });
    secondSpy.mockRestore();
    expect(secondCode).toBe(0);
    expect(sendAmsExportBatchSpy).toHaveBeenCalledTimes(1); // not called again
    expect(JSON.parse(logs.join(""))).toEqual({ enabled: true, sent: 0, skipped: 1 });
  });

  it("text mode: reports a successful send", async () => {
    const s = stores();
    recordPrOutcomeSnapshot(
      { repoFullName: "acme/widgets", prNumber: 1, decision: "merged", closedAt: "2026-01-01T00:00:00Z", reason: null },
      { eventLedger: s.initEventLedger() },
    );
    const spy = captureLog();
    const code = await runOrbExportCli(["--enable", "--send"], { ...s, sendAmsExportBatch: vi.fn().mockResolvedValue({ sent: 1 }) });
    spy.mockRestore();
    expect(code).toBe(0);
    expect(logs.join("")).toBe("sent 1 anonymized event(s)");
  });

  it("REGRESSION: a send failure (non-2xx / network error) is reported and returns exit code 1, without advancing the cursor", async () => {
    const s = stores();
    const store = s.openOrbExportStore();
    recordPrOutcomeSnapshot(
      { repoFullName: "acme/widgets", prNumber: 1, decision: "merged", closedAt: "2026-01-01T00:00:00Z", reason: null },
      { eventLedger: s.initEventLedger() },
    );

    const spy = captureLog();
    const jsonCode = await runOrbExportCli(["--enable", "--send", "--json"], {
      ...s,
      sendAmsExportBatch: vi.fn().mockResolvedValue({ sent: 0, error: "http_503" }),
    });
    expect(jsonCode).toBe(1);
    expect(JSON.parse(logs.join(""))).toEqual({ enabled: true, sent: 0, error: "http_503", skipped: 0 });
    expect(store.getCursor()).toBeNull(); // no successful send → cursor untouched

    logs = [];
    const textCode = await runOrbExportCli(["--enable", "--send"], {
      ...s,
      sendAmsExportBatch: vi.fn().mockResolvedValue({ sent: 0, error: "network_down" }),
    });
    expect(textCode).toBe(1);
    expect(logs.join("")).toBe("export failed: network_down");
    spy.mockRestore();
  });

  it("rejects an unknown flag", async () => {
    expect(parseOrbExportArgs(["--nope"])).toHaveProperty("error");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runOrbExportCli(["--nope"], stores())).toBe(2);
    errSpy.mockRestore();
  });

  it("returns 2 (not a crash) when the store fails to open — the open is inside the try", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runOrbExportCli(["--enable"], {
      openOrbExportStore: () => {
        throw new Error("bad_config_path");
      },
      initEventLedger: () => {
        throw new Error("should_not_reach");
      },
    });
    errSpy.mockRestore();
    expect(code).toBe(2);
  });

  it("REGRESSION (#5681 follow-up): when openOrbExportStore/initEventLedger/sendAmsExportBatch are all omitted, runOrbExportCli falls back to the REAL defaults", async () => {
    // Isolated tmp DB paths (never touches a real ~/.config/loopover-miner), matching the pattern already
    // established for the analogous getAttemptHistory/recordOwnSubmission DI-fallback tests.
    const dir = tempDir();
    vi.stubEnv("LOOPOVER_MINER_ORB_EXPORT_DB", join(dir, "orb-export.sqlite3"));
    vi.stubEnv("LOOPOVER_MINER_EVENT_LEDGER_DB", join(dir, "ledger.sqlite3"));

    // Seed via the SAME real default ledger path runOrbExportCli will open — closedAt omitted (→ null) so the
    // send path's `latestClosedAt` also exercises its null branch (no cursor advance possible).
    const seedLedger = initEventLedger();
    recordPrOutcomeSnapshot({ repoFullName: "acme/widgets", prNumber: 3, decision: "merged", reason: null }, { eventLedger: seedLedger });
    seedLedger.close();

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);

    const spy = captureLog();
    const code = await runOrbExportCli(["--enable", "--send", "--json"], {});
    spy.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();

    expect(code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the REAL sendAmsExportBatch default really POSTed
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.loopover.ai/v1/ams/ingest");
    expect(JSON.parse(logs.join(""))).toEqual({ enabled: true, sent: 1, skipped: 0 });

    // Verify against the REAL default store directly: no cursor was persisted (closedAt was null on the only
    // sent row, so latestClosedAt returned null and the `if (nextCursor)` guard never ran setCursor).
    const store = openOrbExportStore(join(dir, "orb-export.sqlite3"));
    expect(store.getCursor()).toBeNull();
    store.close();
  });
});
