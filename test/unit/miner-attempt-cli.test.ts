import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { closeDefaultClaimLedger, openClaimLedger } from "../../packages/gittensory-miner/lib/claim-ledger.js";
import { closeDefaultEventLedger, initEventLedger } from "../../packages/gittensory-miner/lib/event-ledger.js";
import { closeDefaultAttemptLog, initAttemptLog } from "../../packages/gittensory-miner/lib/attempt-log.js";
import { closeDefaultGovernorLedger, initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";
import { closeDefaultWorktreeAllocator, openWorktreeAllocator } from "../../packages/gittensory-miner/lib/worktree-allocator.js";
import { buildAttemptDeps, parseAttemptArgs, runAttempt } from "../../packages/gittensory-miner/lib/attempt-cli.js";

const roots: string[] = [];
// Only ever holds ledgers a test itself must close -- runAttempt tests inject theirs via DI and runAttempt's
// own `finally` block closes them, so registering the same objects here would double-close (the underlying
// SQLite handle throws "database is not open" / "statement has been finalized" on a second close()).
const closeables: Array<{ close(): void }> = [];

function tempLedgers() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-attempt-cli-"));
  roots.push(root);
  const allocator = openWorktreeAllocator({
    dbPath: join(root, "worktree-allocator.sqlite3"),
    worktreeBaseDir: join(root, "worktrees"),
  });
  const claimLedger = openClaimLedger(join(root, "claim-ledger.sqlite3"));
  const eventLedger = initEventLedger(join(root, "event-ledger.sqlite3"));
  const attemptLog = initAttemptLog(join(root, "attempt-log.sqlite3"));
  const governorLedger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
  return { allocator, claimLedger, eventLedger, attemptLog, governorLedger };
}

afterEach(() => {
  for (const closeable of closeables.splice(0)) closeable.close();
  closeDefaultWorktreeAllocator();
  closeDefaultClaimLedger();
  closeDefaultEventLedger();
  closeDefaultAttemptLog();
  closeDefaultGovernorLedger();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseAttemptArgs (#5132)", () => {
  it("parses a full, valid argv", () => {
    expect(parseAttemptArgs(["acme/widgets", "7", "--miner-login", "alice", "--base", "develop", "--live", "--json"])).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 7,
      minerLogin: "alice",
      base: "develop",
      live: true,
      json: true,
    });
  });

  it("defaults base to main, live to false, and json to false", () => {
    expect(parseAttemptArgs(["acme/widgets", "7", "--miner-login", "alice"])).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 7,
      minerLogin: "alice",
      base: "main",
      live: false,
      json: false,
    });
  });

  it("requires exactly repo and issue number as positional args", () => {
    expect(parseAttemptArgs([])).toEqual({ error: expect.stringContaining("Usage: gittensory-miner attempt") });
    expect(parseAttemptArgs(["acme/widgets"])).toEqual({ error: expect.stringContaining("Usage:") });
    expect(parseAttemptArgs(["acme/widgets", "7", "extra", "--miner-login", "alice"])).toEqual({
      error: expect.stringContaining("Usage:"),
    });
  });

  it("rejects a malformed repo target", () => {
    expect(parseAttemptArgs(["not-a-repo", "7", "--miner-login", "alice"])).toEqual({
      error: "Repository must be in owner/repo form: not-a-repo",
    });
  });

  it("rejects a non-positive or non-integer issue number", () => {
    expect(parseAttemptArgs(["acme/widgets", "0", "--miner-login", "alice"])).toEqual({
      error: "Issue number must be a positive integer: 0",
    });
    expect(parseAttemptArgs(["acme/widgets", "abc", "--miner-login", "alice"])).toEqual({
      error: "Issue number must be a positive integer: abc",
    });
  });

  it("requires --miner-login", () => {
    expect(parseAttemptArgs(["acme/widgets", "7"])).toEqual({
      error: expect.stringContaining("--miner-login is required"),
    });
  });

  it("rejects --miner-login or --base with a missing or flag-like value", () => {
    expect(parseAttemptArgs(["acme/widgets", "7", "--miner-login"])).toEqual({
      error: expect.stringContaining("Usage:"),
    });
    expect(parseAttemptArgs(["acme/widgets", "7", "--base", "--json"])).toEqual({
      error: expect.stringContaining("Usage:"),
    });
  });

  it("rejects unknown options", () => {
    expect(parseAttemptArgs(["acme/widgets", "7", "--miner-login", "alice", "--verbose"])).toEqual({
      error: "Unknown option: --verbose",
    });
  });
});

describe("buildAttemptDeps (#5132)", () => {
  it("assembles a fully real AttemptDeps object when a coding-agent provider is configured", () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    closeables.push(allocator, claimLedger, eventLedger, attemptLog, governorLedger);
    const deps = buildAttemptDeps({ MINER_CODING_AGENT_PROVIDER: "noop" }, { claimLedger, eventLedger, attemptLog, governorLedger, nowMs: 12345 });

    expect(typeof deps.driver.run).toBe("function");
    expect(typeof deps.runSlopAssessment).toBe("function");
    expect(typeof deps.appendAttemptLogEvent).toBe("function");
    expect(deps.claimLedger).toBe(claimLedger);
    expect(typeof deps.fetchLiveIssueSnapshot).toBe("function");
    expect(deps.eventLedger).toBe(eventLedger);
    expect(typeof deps.governorLedgerAppend).toBe("function");
    expect(deps.nowMs).toBe(12345);
    expect(typeof deps.executeLocalWrite).toBe("function");
  });

  it("wires appendAttemptLogEvent and governorLedgerAppend through to the real ledgers", () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    closeables.push(allocator, claimLedger, eventLedger, attemptLog, governorLedger);
    const deps = buildAttemptDeps({ MINER_CODING_AGENT_PROVIDER: "noop" }, { claimLedger, eventLedger, attemptLog, governorLedger, nowMs: 1 });

    deps.appendAttemptLogEvent({
      eventType: "attempt_aborted",
      attemptId: "a1",
      actionClass: "open_pr",
      mode: "dry_run",
      reason: "test",
      payload: {},
    });
    expect(attemptLog.readAttemptLogEvents({ attemptId: "a1" })).toHaveLength(1);

    deps.governorLedgerAppend?.({
      eventType: "allowed",
      repoFullName: "acme/widgets",
      actionClass: "open_pr",
      decision: "allow",
      reason: "test",
    });
    expect(governorLedger.readGovernorEvents({})).toHaveLength(1);
  });

  it("fails closed (throws) when no coding-agent provider is configured", () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    closeables.push(allocator, claimLedger, eventLedger, attemptLog, governorLedger);
    expect(() => buildAttemptDeps({}, { claimLedger, eventLedger, attemptLog, governorLedger, nowMs: 1 })).toThrow(
      /unconfigured_coding_agent_driver/,
    );
  });
});

describe("runAttempt (#5132)", () => {
  it("short-circuits with a usage error on malformed args, before touching any ledger or allocator", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const openWorktreeAllocatorSpy = vi.fn();
    const exitCode = await runAttempt([], { openWorktreeAllocator: openWorktreeAllocatorSpy });
    expect(exitCode).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Usage: gittensory-miner attempt"));
    expect(openWorktreeAllocatorSpy).not.toHaveBeenCalled();
  });

  it("short-circuits when coding-agent execution is globally paused, before touching any ledger or allocator", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const openWorktreeAllocatorSpy = vi.fn();
    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice"], {
      env: { MINER_CODING_AGENT_PAUSED: "1" },
      openWorktreeAllocator: openWorktreeAllocatorSpy,
    });
    expect(exitCode).toBe(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("globally paused"));
    expect(openWorktreeAllocatorSpy).not.toHaveBeenCalled();
  });

  it("acquires and releases a real worktree slot, wires real deps, then reports the block instead of fabricating a run", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // runAttempt closes every ledger/allocator it owns in its own `finally` block (correct for a real CLI
    // invocation), so post-invocation state can't be read off these same instances -- spy on the calls
    // instead, asserted before close() ever fires.
    const releaseSpy = vi.spyOn(allocator, "release");
    const appendAttemptLogEventSpy = vi.spyOn(attemptLog, "appendAttemptLogEvent");
    const appendEventSpy = vi.spyOn(eventLedger, "appendEvent");

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      nowMs: 999,
      attemptId: "fixed-attempt-id",
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
    });

    expect(exitCode).toBe(4);
    const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(printed).toEqual({
      outcome: "blocked_missing_prerequisite",
      reason: "missing_self_review_context_and_task_spec",
      trackingIssue: 5145,
      repoFullName: "acme/widgets",
      issueNumber: 7,
      minerLogin: "alice",
      base: "main",
      mode: "dry_run",
      attemptId: "fixed-attempt-id",
      worktreePath: expect.any(String),
    });

    // The worktree slot was acquired for real and then released, not left dangling.
    expect(releaseSpy).toHaveBeenCalledWith("fixed-attempt-id");
    // A real, persisted record of the block was written to both ledgers -- not just console output.
    expect(appendAttemptLogEventSpy).toHaveBeenCalledWith(expect.objectContaining({ eventType: "attempt_aborted", attemptId: "fixed-attempt-id" }));
    expect(appendEventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "attempt_blocked", repoFullName: "acme/widgets" }));
  });

  it("resolves live mode only when --live is passed", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--live", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
    });

    expect(exitCode).toBe(4);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).mode).toBe("live");
  });

  it("prints a human-readable message (not JSON) by default", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
    });

    expect(exitCode).toBe(4);
    expect(String(log.mock.calls[0]?.[0])).toContain("is blocked");
    expect(String(log.mock.calls[0]?.[0])).toContain("#5145");
  });

  it("reports and cleans up when the coding-agent driver is unconfigured, still releasing the worktree slot", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const releaseSpy = vi.spyOn(allocator, "release");
    const appendAttemptLogEventSpy = vi.spyOn(attemptLog, "appendAttemptLogEvent");

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice"], {
      env: {},
      attemptId: "unconfigured-attempt",
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
    });

    expect(exitCode).toBe(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("unconfigured_coding_agent_driver"));
    expect(releaseSpy).toHaveBeenCalledWith("unconfigured-attempt");
    // The block was never logged to the ledgers -- the driver-construction failure short-circuits before that.
    expect(appendAttemptLogEventSpy).not.toHaveBeenCalled();
  });

  it("reports an unexpected allocator failure and still closes every already-open ledger", async () => {
    const { claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const closeSpy = vi.spyOn(claimLedger, "close");

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => ({
        dbPath: ":memory:",
        worktreeBaseDir: "/tmp/unused",
        maxConcurrency: 1,
        processPid: process.pid,
        acquire: () => {
          throw new Error("no_free_worktree_slots");
        },
        release: vi.fn(),
        listSlots: () => [],
        close: vi.fn(),
      }),
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
    });

    expect(exitCode).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("no_free_worktree_slots"));
    expect(closeSpy).toHaveBeenCalled();
  });
});
