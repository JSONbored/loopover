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
import type { PrepareAttemptWorktreeResult } from "../../packages/gittensory-miner/lib/attempt-worktree.js";
import { DEFAULT_AMS_POLICY_SPEC, parseFocusManifest } from "../../packages/gittensory-engine/src/index";

const roots: string[] = [];
// Only ever holds ledgers a test itself must close -- runAttempt tests inject theirs via DI and runAttempt's
// own `finally` block closes them, so registering the same objects here would double-close (the underlying
// SQLite handle throws "database is not open" / "statement has been finalized" on a second close()).
const closeables: Array<{ close(): void }> = [];

/** A stubbed successful prepareAttemptWorktree, for tests exercising code paths past worktree preparation
 *  that don't themselves care about real git plumbing (covered separately by miner-attempt-worktree.test.ts). */
function fakeWorktreeResult(): Extract<PrepareAttemptWorktreeResult, { ok: true }> {
  return { ok: true, worktreePath: "/fake/repo/.gittensory-worktrees/fake", repoPath: "/fake/repo", branchName: "gittensory/attempt/fake" };
}

function fakeReviewContext() {
  return {
    manifest: parseFocusManifest(undefined),
    repo: { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false, htmlUrl: "https://github.com/acme/widgets", defaultBranch: "main" },
    issues: [{ repoFullName: "acme/widgets", number: 7, title: "Uploads should retry on 5xx", state: "open", labels: ["bug"], linkedPrs: [], body: "Uploads fail silently." }],
    pullRequests: [],
  };
}

/** A stubbed READY coding-task-spec result, matching buildCodingTaskSpec's own `ready: true` shape. */
function fakeCodingTaskSpec() {
  return {
    ready: true as const,
    verdict: "go" as const,
    feasibility: { verdict: "go" as const, avoidReasons: [], raiseReasons: [], summary: "ready" },
    acceptanceCriteriaPath: "/fake/repo/.gittensory-worktrees/fake/acceptance-criteria.json",
    instructions: "Resolve issue #7",
    title: "Uploads should retry on 5xx",
    body: "Uploads fail silently.",
    labels: ["bug"],
    linkedIssues: [7],
  };
}

/** The default set of injected options a test needs to reach past every real dependency and into (or
 *  through) the final runMinerAttempt call, without doing any real network/git/subprocess work. */
function readyPipelineOptions(overrides: Record<string, unknown> = {}) {
  return {
    resolveRejectionSignaled: async () => false,
    prepareAttemptWorktree: async () => fakeWorktreeResult(),
    cleanupAttemptWorktree: vi.fn().mockResolvedValue({ ok: true, removed: true }),
    fetchSelfReviewContext: async () => fakeReviewContext(),
    buildCodingTaskSpec: () => fakeCodingTaskSpec(),
    resolveAmsPolicy: async () => ({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default" as const, warnings: [] }),
    checkMinerKillSwitch: () => ({ scope: "none" as const, active: false }),
    ...overrides,
  };
}

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

  it("REGRESSION: runs the full real pipeline end to end and reports a real submitted outcome (exit 0)", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const releaseSpy = vi.spyOn(allocator, "release");
    const worktreeResult = fakeWorktreeResult();
    const cleanupAttemptWorktreeSpy = vi.fn().mockResolvedValue({ ok: true, removed: true });
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({
      outcome: "submitted",
      spec: { command: "gh pr create", cwd: worktreeResult.worktreePath, timeoutMs: 1000 },
      execResult: { code: 0 },
      loopResult: { outcome: "handoff", totalTurnsUsed: 3, totalCostUsd: 0.42, iterationsUsed: 2 },
    });

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      nowMs: 999,
      attemptId: "fixed-attempt-id",
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ cleanupAttemptWorktree: cleanupAttemptWorktreeSpy, runMinerAttempt: runMinerAttemptSpy }),
    });

    expect(exitCode).toBe(0);
    const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(printed).toEqual({
      outcome: "attempt_submitted",
      repoFullName: "acme/widgets",
      issueNumber: 7,
      minerLogin: "alice",
      base: "main",
      mode: "dry_run",
      attemptId: "fixed-attempt-id",
      submissionMode: "observe",
      totalTurnsUsed: 3,
      totalCostUsd: 0.42,
      iterationsUsed: 2,
      spec: { command: "gh pr create", cwd: worktreeResult.worktreePath, timeoutMs: 1000 },
      execResult: { code: 0 },
    });

    // The worktree slot was acquired for real and then released, not left dangling.
    expect(releaseSpy).toHaveBeenCalledWith("fixed-attempt-id");
    // A submitted outcome removes the worktree (attemptOk: true) -- nothing left to postmortem.
    expect(cleanupAttemptWorktreeSpy).toHaveBeenCalledWith(worktreeResult.repoPath, worktreeResult.worktreePath, true);

    // The real IterateLoopInput was assembled from the real coding-task-spec + review context, not fabricated.
    expect(runMinerAttemptSpy).toHaveBeenCalledTimes(1);
    const [input, deps] = runMinerAttemptSpy.mock.calls[0]!;
    expect(input.loopInput).toMatchObject({
      attemptId: "fixed-attempt-id",
      workingDirectory: worktreeResult.worktreePath,
      acceptanceCriteriaPath: fakeCodingTaskSpec().acceptanceCriteriaPath,
      instructions: fakeCodingTaskSpec().instructions,
      mode: "dry_run",
      repoFullName: "acme/widgets",
      contributorLogin: "alice",
      title: fakeCodingTaskSpec().title,
      rejectionSignaled: false,
    });
    expect(input.issueNumber).toBe(7);
    expect(input.minerLogin).toBe("alice");
    expect(input.base).toBe("main");
    expect(input.killSwitchScope).toBe("none");
    expect(input.slopThreshold).toBe(DEFAULT_AMS_POLICY_SPEC.slopThreshold);
    expect(input.submissionMode).toBe(DEFAULT_AMS_POLICY_SPEC.submissionMode);
    expect(input.governor.capLimits).toEqual(DEFAULT_AMS_POLICY_SPEC.capLimits);
    expect(deps).toBeDefined();
    expect(typeof deps.driver.run).toBe("function");
  });

  it("resolves live mode only when --live is passed, and threads it through to the real loopInput", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({ outcome: "abandon", loopResult: {} });

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--live", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ runMinerAttempt: runMinerAttemptSpy }),
    });

    expect(exitCode).toBe(7);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).mode).toBe("live");
    expect(runMinerAttemptSpy.mock.calls[0]![0].loopInput.mode).toBe("live");
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
      ...readyPipelineOptions({ runMinerAttempt: async () => ({ outcome: "abandon", loopResult: {} }) }),
    });

    expect(exitCode).toBe(7);
    expect(String(log.mock.calls[0]?.[0])).toContain("finished with outcome: abandon");
  });

  it.each([
    ["stale", 8, { outcome: "stale", reason: "expired", loopResult: {} }],
    ["blocked", 9, { outcome: "blocked", decision: { allow: false }, loopResult: {} }],
    ["governed", 10, { outcome: "governed", decision: { allowed: false }, loopResult: {} }],
  ] as const)("reports a real %s outcome with exit code %i", async (_label, expectedExitCode, mockResult) => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ runMinerAttempt: async () => mockResult }),
    });

    expect(exitCode).toBe(expectedExitCode);
    const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(printed.outcome).toBe(`attempt_${mockResult.outcome}`);
  });

  it("REGRESSION: a non-submitted outcome retains the worktree instead of cleaning it up", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const worktreeResult = fakeWorktreeResult();
    const cleanupAttemptWorktreeSpy = vi.fn().mockResolvedValue({ ok: true, removed: false });

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({
        cleanupAttemptWorktree: cleanupAttemptWorktreeSpy,
        runMinerAttempt: async () => ({ outcome: "governed", decision: { allowed: false }, loopResult: {} }),
      }),
    });

    expect(cleanupAttemptWorktreeSpy).toHaveBeenCalledWith(worktreeResult.repoPath, worktreeResult.worktreePath, false);
  });

  it("REGRESSION: blocks with a real feasibility verdict when the coding-task-spec is infeasible, without ever calling runMinerAttempt", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const appendAttemptLogEventSpy = vi.spyOn(attemptLog, "appendAttemptLogEvent");
    const runMinerAttemptSpy = vi.fn();
    const cleanupAttemptWorktreeSpy = vi.fn().mockResolvedValue({ ok: true, removed: true });

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      attemptId: "infeasible-attempt",
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({
        buildCodingTaskSpec: () => ({
          ready: false,
          verdict: "raise",
          feasibility: { verdict: "raise", avoidReasons: [], raiseReasons: ["target_not_found"], summary: "issue not found" },
        }),
        runMinerAttempt: runMinerAttemptSpy,
        cleanupAttemptWorktree: cleanupAttemptWorktreeSpy,
      }),
    });

    expect(exitCode).toBe(4);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      outcome: "blocked_infeasible",
      reason: "infeasible_raise",
      verdict: "raise",
      avoidReasons: [],
      raiseReasons: ["target_not_found"],
      repoFullName: "acme/widgets",
      issueNumber: 7,
      minerLogin: "alice",
      base: "main",
      mode: "dry_run",
      attemptId: "infeasible-attempt",
    });
    expect(runMinerAttemptSpy).not.toHaveBeenCalled();
    expect(appendAttemptLogEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "attempt_aborted", attemptId: "infeasible-attempt", reason: "infeasible_raise" }),
    );
    // Nothing ran against this worktree -- cleaned up like every other pre-execution block.
    expect(cleanupAttemptWorktreeSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), true);
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
      resolveRejectionSignaled: async () => false,
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
      resolveRejectionSignaled: async () => false,
    });

    expect(exitCode).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("no_free_worktree_slots"));
    expect(closeSpy).toHaveBeenCalled();
  });

  it("blocks on a rejection-signaled repo before ever acquiring a worktree slot, without fabricating a run", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const acquireSpy = vi.spyOn(allocator, "acquire");
    const appendAttemptLogEventSpy = vi.spyOn(attemptLog, "appendAttemptLogEvent");
    const appendEventSpy = vi.spyOn(eventLedger, "appendEvent");
    const resolveRejectionSignaledSpy = vi.fn().mockResolvedValue(true);

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      attemptId: "rejected-attempt",
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      resolveRejectionSignaled: resolveRejectionSignaledSpy,
    });

    expect(exitCode).toBe(5);
    expect(resolveRejectionSignaledSpy).toHaveBeenCalledWith("acme/widgets", expect.objectContaining({ fetchImpl: undefined }));
    // No worktree slot was ever acquired for a repo we already know rejects AI contributions.
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(appendAttemptLogEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "attempt_aborted", attemptId: "rejected-attempt", reason: "ai_usage_policy_ban" }),
    );
    expect(appendEventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "attempt_blocked", repoFullName: "acme/widgets" }));
    expect(error).not.toHaveBeenCalled();
  });

  it("blocks on a rejection-signaled repo with a human-readable message by default", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      resolveRejectionSignaled: async () => true,
    });

    expect(exitCode).toBe(5);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AI-usage policy bans automated/AI-authored contributions"));
  });

  it("passes options.fetchImpl through to resolveRejectionSignaled", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const resolveRejectionSignaledSpy = vi.fn().mockResolvedValue(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchImpl = vi.fn();

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ resolveRejectionSignaled: resolveRejectionSignaledSpy, fetchImpl, runMinerAttempt: async () => ({ outcome: "abandon", loopResult: {} }) }),
    });

    expect(resolveRejectionSignaledSpy).toHaveBeenCalledWith("acme/widgets", { fetchImpl });
    expect(log).toHaveBeenCalled();
  });

  it("REGRESSION: reports a real block and releases the worktree slot when worktree preparation fails", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const releaseSpy = vi.spyOn(allocator, "release");
    const appendAttemptLogEventSpy = vi.spyOn(attemptLog, "appendAttemptLogEvent");
    const cleanupAttemptWorktreeSpy = vi.fn();

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      attemptId: "clone-failed-attempt",
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      resolveRejectionSignaled: async () => false,
      prepareAttemptWorktree: async () => ({ ok: false, error: "git_clone_failed" }),
      cleanupAttemptWorktree: cleanupAttemptWorktreeSpy,
    });

    expect(exitCode).toBe(6);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      outcome: "blocked_worktree_preparation_failed",
      reason: "git_clone_failed",
      repoFullName: "acme/widgets",
      issueNumber: 7,
      minerLogin: "alice",
      base: "main",
      mode: "dry_run",
      attemptId: "clone-failed-attempt",
    });
    // The worktree slot is still released even though preparation failed -- no leaked allocation.
    expect(releaseSpy).toHaveBeenCalledWith("clone-failed-attempt");
    expect(appendAttemptLogEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "attempt_aborted", attemptId: "clone-failed-attempt", reason: "git_clone_failed" }),
    );
    // Nothing to clean up -- preparation never produced a real worktree to remove.
    expect(cleanupAttemptWorktreeSpy).not.toHaveBeenCalled();
  });

  it("reports a real block with a human-readable message when worktree preparation fails", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      resolveRejectionSignaled: async () => false,
      prepareAttemptWorktree: async () => ({ ok: false, error: "git_fetch_failed" }),
      cleanupAttemptWorktree: vi.fn(),
    });

    expect(exitCode).toBe(6);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("real worktree preparation failed: git_fetch_failed"));
  });

  it("passes parsed.base through as prepareAttemptWorktree's baseBranch", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const prepareAttemptWorktreeSpy = vi.fn().mockResolvedValue(fakeWorktreeResult());

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--base", "develop", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ prepareAttemptWorktree: prepareAttemptWorktreeSpy, runMinerAttempt: async () => ({ outcome: "abandon", loopResult: {} }) }),
    });

    expect(prepareAttemptWorktreeSpy).toHaveBeenCalledWith("acme/widgets", expect.any(String), expect.objectContaining({ baseBranch: "develop" }));
  });

  it("fetches SelfReviewContext with the real miner login and target issue number", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchSelfReviewContextSpy = vi.fn().mockResolvedValue(fakeReviewContext());

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop", GITHUB_TOKEN: "ghp_test" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ fetchSelfReviewContext: fetchSelfReviewContextSpy, runMinerAttempt: async () => ({ outcome: "abandon", loopResult: {} }) }),
    });

    expect(fetchSelfReviewContextSpy).toHaveBeenCalledWith("acme/widgets", {
      githubToken: "ghp_test",
      contributorLogin: "alice",
      linkedIssues: [7],
    });
  });

  it("REGRESSION: options.onResult is called with the real structured result at every return point, alongside the unchanged plain exit code", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onResult = vi.fn();

    // blocked_rejection_signaled path
    const rejectedLedgers = tempLedgers();
    const rejectedExit = await runAttempt(["acme/widgets", "7", "--miner-login", "alice"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => rejectedLedgers.allocator,
      openClaimLedger: () => rejectedLedgers.claimLedger,
      initEventLedger: () => rejectedLedgers.eventLedger,
      initAttemptLog: () => rejectedLedgers.attemptLog,
      initGovernorLedger: () => rejectedLedgers.governorLedger,
      resolveRejectionSignaled: async () => true,
      onResult,
    });
    expect(rejectedExit).toBe(5);
    expect(onResult).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "blocked_rejection_signaled" }));

    // attempt_submitted path (real final result) -- a separate set of real ledgers, since runAttempt closes
    // whatever it's given in its own `finally` block.
    onResult.mockClear();
    const submittedLedgers = tempLedgers();
    const submittedExit = await runAttempt(["acme/widgets", "7", "--miner-login", "alice"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => submittedLedgers.allocator,
      openClaimLedger: () => submittedLedgers.claimLedger,
      initEventLedger: () => submittedLedgers.eventLedger,
      initAttemptLog: () => submittedLedgers.attemptLog,
      initGovernorLedger: () => submittedLedgers.governorLedger,
      ...readyPipelineOptions({
        runMinerAttempt: async () => ({ outcome: "submitted", spec: { command: "gh pr create", cwd: "/fake", timeoutMs: 1 }, execResult: { code: 0 }, loopResult: {} }),
      }),
      onResult,
    });
    expect(submittedExit).toBe(0);
    expect(onResult).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "attempt_submitted", spec: expect.objectContaining({ command: "gh pr create" }) }));
  });

  it("REGRESSION: stakes a real active claim before running the attempt and releases it once the attempt finishes (#5393)", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const claimIssueSpy = vi.spyOn(claimLedger, "claimIssue");
    const releaseClaimSpy = vi.spyOn(claimLedger, "releaseClaim");
    let activeDuringFlight: Array<{ issueNumber: number; status: string }> = [];
    // The freshness check inside runMinerAttempt reads this same ledger to confirm the miner still holds an
    // active claim -- capture what it would see while the attempt is in flight.
    const runMinerAttemptSpy = vi.fn().mockImplementation(async () => {
      activeDuringFlight = claimLedger.listActiveClaims("acme/widgets");
      return { outcome: "submitted", spec: { command: "gh pr create", cwd: "/fake", timeoutMs: 1 }, execResult: { code: 0 }, loopResult: {} };
    });

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ runMinerAttempt: runMinerAttemptSpy }),
    });

    expect(exitCode).toBe(0);
    // A REAL claim was staked before the attempt ran and was active while it was in flight...
    expect(claimIssueSpy).toHaveBeenCalledWith("acme/widgets", 7);
    expect(activeDuringFlight).toHaveLength(1);
    expect(activeDuringFlight[0]).toMatchObject({ issueNumber: 7, status: "active" });
    // ...and released once the attempt finished, so `claim list` no longer shows it as active.
    expect(releaseClaimSpy).toHaveBeenCalledWith("acme/widgets", 7);
  });

  it("blocks a second concurrent attempt when an active claim already exists on the same repo+issue, without running runMinerAttempt (#5393)", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const appendAttemptLogEventSpy = vi.spyOn(attemptLog, "appendAttemptLogEvent");
    const appendEventSpy = vi.spyOn(eventLedger, "appendEvent");
    const runMinerAttemptSpy = vi.fn();
    const onResult = vi.fn();
    // A first, in-flight attempt already holds an active claim on this exact issue.
    claimLedger.claimIssue("acme/widgets", 7);

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      attemptId: "conflicting-attempt",
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ runMinerAttempt: runMinerAttemptSpy }),
      onResult,
    });

    expect(exitCode).toBe(11);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      outcome: "blocked_claim_conflict",
      reason: "claim_conflict",
      repoFullName: "acme/widgets",
      issueNumber: 7,
      minerLogin: "alice",
      base: "main",
      mode: "dry_run",
      attemptId: "conflicting-attempt",
    });
    // The duplicate never ran a real attempt against the already-claimed issue.
    expect(runMinerAttemptSpy).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ outcome: "blocked_claim_conflict" }));
    expect(appendAttemptLogEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "attempt_aborted", attemptId: "conflicting-attempt", reason: "claim_conflict" }),
    );
    expect(appendEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "attempt_blocked", repoFullName: "acme/widgets", payload: expect.objectContaining({ issueNumber: 7, reason: "claim_conflict" }) }),
    );
  });

  it("blocks a conflicting claim with a human-readable message by default (#5393)", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runMinerAttemptSpy = vi.fn();
    claimLedger.claimIssue("acme/widgets", 7);

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ runMinerAttempt: runMinerAttemptSpy }),
    });

    expect(exitCode).toBe(11);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("already holds an active claim on this issue"));
    expect(runMinerAttemptSpy).not.toHaveBeenCalled();
  });
});
