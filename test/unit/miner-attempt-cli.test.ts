import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { closeDefaultClaimLedger, openClaimLedger } from "../../packages/gittensory-miner/lib/claim-ledger.js";
import { closeDefaultEventLedger, initEventLedger } from "../../packages/gittensory-miner/lib/event-ledger.js";
import { closeDefaultAttemptLog, initAttemptLog } from "../../packages/gittensory-miner/lib/attempt-log.js";
import type { AttemptLog } from "../../packages/gittensory-miner/lib/attempt-log.js";
import { closeDefaultGovernorLedger, initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";
import { closeDefaultWorktreeAllocator, openWorktreeAllocator } from "../../packages/gittensory-miner/lib/worktree-allocator.js";
import { closeDefaultPortfolioQueueStore } from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import { closeDefaultGovernorState } from "../../packages/gittensory-miner/lib/governor-state.js";
import { buildAttemptDeps, parseAttemptArgs, runAttempt } from "../../packages/gittensory-miner/lib/attempt-cli.js";
import type { PrepareAttemptWorktreeResult } from "../../packages/gittensory-miner/lib/attempt-worktree.js";
import { DEFAULT_AMS_POLICY_SPEC, DEFAULT_MINER_GOAL_SPEC, parseFocusManifest } from "../../packages/gittensory-engine/src/index";

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

/** A minimal but real-shaped IterateLoopResult stand-in for a mocked runMinerAttempt result (#5653) --
 *  attempt-cli.js reads `finalMeterTotals.tokens` unconditionally (the real loop always produces one), so
 *  every mocked `loopResult` needs one too, not just the flat totalTurnsUsed/totalCostUsd fields. */
function fakeLoopResult(overrides: Record<string, unknown> = {}) {
  return {
    totalTurnsUsed: 0,
    totalCostUsd: 0,
    iterationsUsed: 0,
    finalMeterTotals: { tokens: 0, turns: 0, wallClockMs: 0, costUsd: 0 },
    ...overrides,
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
    resolveMinerGoalSpec: () => ({ present: false, spec: DEFAULT_MINER_GOAL_SPEC, warnings: [] }),
    // Never touches the real (filesystem-backed) default portfolio-queue store (#5654) -- a test that cares
    // about a real convergenceInput value overrides this explicitly.
    getAttemptHistory: () => ({ attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false }),
    // Never touches the real (filesystem-backed) default governor-state store (#5655 follow-up) -- a test
    // that cares whether recordOwnSubmission was actually called overrides this explicitly.
    recordOwnSubmission: vi.fn(),
    ...overrides,
  };
}

function tempLedgers() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-attempt-cli-"));
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
  closeDefaultPortfolioQueueStore();
  closeDefaultGovernorState();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseAttemptArgs (#5132)", () => {
  it("parses a full, valid argv", () => {
    expect(
      parseAttemptArgs(["acme/widgets", "7", "--miner-login", "alice", "--base", "develop", "--live", "--dry-run", "--json"]),
    ).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 7,
      minerLogin: "alice",
      base: "develop",
      live: true,
      dryRun: true,
      json: true,
    });
  });

  it("defaults base to main, live to false, dryRun to false, and json to false", () => {
    expect(parseAttemptArgs(["acme/widgets", "7", "--miner-login", "alice"])).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 7,
      minerLogin: "alice",
      base: "main",
      live: false,
      dryRun: false,
      json: false,
    });
  });

  it("requires exactly repo and issue number as positional args", () => {
    expect(parseAttemptArgs([])).toEqual({ error: expect.stringContaining("Usage: loopover-miner attempt") });
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
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Usage: loopover-miner attempt"));
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

  it("#4847: --dry-run reports what would happen and returns 0 without opening any store", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const openWorktreeAllocatorSpy = vi.fn();
    const openClaimLedgerSpy = vi.fn();
    const initEventLedgerSpy = vi.fn();
    const initAttemptLogSpy = vi.fn();
    const initGovernorLedgerSpy = vi.fn();
    const onResult = vi.fn();

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--dry-run", "--json"], {
      openWorktreeAllocator: openWorktreeAllocatorSpy,
      openClaimLedger: openClaimLedgerSpy,
      initEventLedger: initEventLedgerSpy,
      initAttemptLog: initAttemptLogSpy,
      initGovernorLedger: initGovernorLedgerSpy,
      onResult,
    });

    expect(exitCode).toBe(0);
    expect(openWorktreeAllocatorSpy).not.toHaveBeenCalled();
    expect(openClaimLedgerSpy).not.toHaveBeenCalled();
    expect(initEventLedgerSpy).not.toHaveBeenCalled();
    expect(initAttemptLogSpy).not.toHaveBeenCalled();
    expect(initGovernorLedgerSpy).not.toHaveBeenCalled();

    const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(printed).toMatchObject({
      outcome: "dry_run",
      repoFullName: "acme/widgets",
      issueNumber: 7,
      minerLogin: "alice",
      base: "main",
      mode: "dry_run",
    });
    expect(onResult).toHaveBeenCalledWith(printed);
  });

  it("#4847: --dry-run --live reports the live mode it would have used, and prints a human-readable message by default", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--dry-run", "--live"], {});
    expect(exitCode).toBe(0);
    const printed = String(log.mock.calls[0]?.[0]);
    expect(printed).toContain("DRY RUN: would attempt acme/widgets#7 for alice");
    expect(printed).toContain("mode: live");
    expect(printed).toContain("No worktree, claim, or ledger writes were made.");
  });

  it("#4847: --dry-run still reports globally-paused mode, matching what a real (non-dry-run) run would refuse to do", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--dry-run"], {
      env: { MINER_CODING_AGENT_PAUSED: "1" },
    });
    // The pause check runs BEFORE the dry-run short-circuit, so a dry run of a paused config still refuses --
    // an honest reflection of what a real run would do, not a fabricated "would succeed."
    expect(exitCode).toBe(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("globally paused"));
    expect(log).not.toHaveBeenCalled();
  });

  it("REGRESSION: runs the full real pipeline end to end and reports a real submitted outcome (exit 0)", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const releaseSpy = vi.spyOn(allocator, "release");
    // attemptLog is closed in runAttempt's own `finally` block once it returns (same DI convention documented at
    // the claim-ledger test below) -- so the appended event is asserted via a spy recorded DURING the call, not
    // by re-querying the ledger once it's already closed.
    const appendAttemptLogEventSpy = vi.spyOn(attemptLog, "appendAttemptLogEvent");
    const worktreeResult = fakeWorktreeResult();
    const cleanupAttemptWorktreeSpy = vi.fn().mockResolvedValue({ ok: true, removed: true });
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({
      outcome: "submitted",
      spec: { command: "gh pr create", cwd: worktreeResult.worktreePath, timeoutMs: 1000 },
      execResult: { code: 0 },
      loopResult: fakeLoopResult({
        outcome: "handoff",
        totalTurnsUsed: 3,
        totalCostUsd: 0.42,
        iterationsUsed: 2,
        finalMeterTotals: { tokens: 1234, turns: 3, wallClockMs: 500, costUsd: 0.42 },
      }),
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
      totalTokensUsed: 1234,
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

    // #5185: one real attempt_outcome_summary call per completed attempt, carrying the real configured provider
    // and the real accumulated cost -- not a per-iteration event iterate-loop.ts already writes.
    const summaryCalls = appendAttemptLogEventSpy.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventType === "attempt_outcome_summary");
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls[0]).toMatchObject({
      attemptId: "fixed-attempt-id",
      actionClass: "attempt_submitted",
      mode: "dry_run",
      provider: "noop",
      costUsd: 0.42,
      // Real accumulated tokens (#5653), read the same way as costUsd -- from the loop's own finalMeterTotals.
      tokensUsed: 1234,
    });
  });

  it("REGRESSION (#5655 follow-up): a real submitted outcome with a real changed-files set records real own-submission history, closing the gap that left resolveOwnRejectionHistory silently a no-op", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const worktreeResult = fakeWorktreeResult();
    const recordOwnSubmissionSpy = vi.fn();
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({
      outcome: "submitted",
      spec: { command: "gh pr create", cwd: worktreeResult.worktreePath, timeoutMs: 1000 },
      execResult: { code: 0, stdout: "https://github.com/acme/widgets/pull/9\n" },
      loopResult: fakeLoopResult({
        handoffPacket: { changedFiles: [{ path: "src/b.ts" }, { path: "src/a.ts" }] },
      }),
    });

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      nowMs: Date.parse("2026-07-13T12:00:00.000Z"),
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ recordOwnSubmission: recordOwnSubmissionSpy, runMinerAttempt: runMinerAttemptSpy }),
    });

    expect(recordOwnSubmissionSpy).toHaveBeenCalledWith({
      repoFullName: "acme/widgets",
      // Sorted, comma-joined, deduped -- the real fingerprintFromChangedFiles contract (#5653 follow-up sibling).
      fingerprint: "src/a.ts,src/b.ts",
      submittedAt: "2026-07-13T12:00:00.000Z",
      pullRequestNumber: 9,
      issueNumber: 7,
    });
  });

  it("REGRESSION (#5655 follow-up): when options.recordOwnSubmission is omitted, runAttempt falls back to the REAL governor-state.js default, not a fabricated no-op", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-attempt-cli-governor-state-"));
    roots.push(root);
    vi.stubEnv("LOOPOVER_MINER_GOVERNOR_STATE_DB", join(root, "governor-state.sqlite3"));
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({
      outcome: "submitted",
      spec: { command: "gh pr create", cwd: "/fake", timeoutMs: 1000 },
      execResult: { code: 0, stdout: "https://github.com/acme/widgets/pull/9\n" },
      loopResult: fakeLoopResult({ handoffPacket: { changedFiles: [{ path: "src/a.ts" }] } }),
    });
    const { recordOwnSubmission: _omitted, ...optionsWithoutRecordOwnSubmission } = readyPipelineOptions({ runMinerAttempt: runMinerAttemptSpy });

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...optionsWithoutRecordOwnSubmission,
    });

    // A real write against the isolated store proves the real default (not a DI stub) actually ran.
    const { listRecentOwnSubmissions } = await import("../../packages/gittensory-miner/lib/governor-state.js");
    const submissions = listRecentOwnSubmissions({ repoFullName: "acme/widgets" });
    expect(submissions).toEqual([
      expect.objectContaining({ repoFullName: "acme/widgets", fingerprint: "src/a.ts", pullRequestNumber: 9, issueNumber: 7 }),
    ]);
  });

  it("does not record own-submission history when the loop's handoff packet reports no changed files -- an honest absence, never a fabricated fingerprint", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const recordOwnSubmissionSpy = vi.fn();
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({
      outcome: "submitted",
      spec: { command: "gh pr create", cwd: "/fake", timeoutMs: 1000 },
      execResult: { code: 0, stdout: "https://github.com/acme/widgets/pull/9\n" },
      loopResult: fakeLoopResult({ handoffPacket: { changedFiles: [] } }),
    });

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ recordOwnSubmission: recordOwnSubmissionSpy, runMinerAttempt: runMinerAttemptSpy }),
    });

    expect(recordOwnSubmissionSpy).not.toHaveBeenCalled();
  });

  it("records own-submission history with a null pullRequestNumber when the real PR number couldn't be parsed from execResult -- an honest gap, not a skipped record", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const recordOwnSubmissionSpy = vi.fn();
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({
      outcome: "submitted",
      spec: { command: "gh pr create", cwd: "/fake", timeoutMs: 1000 },
      execResult: { code: 0 }, // no stdout -- PR number genuinely unrecoverable
      loopResult: fakeLoopResult({ handoffPacket: { changedFiles: [{ path: "src/a.ts" }] } }),
    });

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ recordOwnSubmission: recordOwnSubmissionSpy, runMinerAttempt: runMinerAttemptSpy }),
    });

    expect(recordOwnSubmissionSpy).toHaveBeenCalledWith(expect.objectContaining({ pullRequestNumber: null }));
  });

  it("REGRESSION: a recordOwnSubmission failure never fails an otherwise-successful attempt", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const recordOwnSubmissionSpy = vi.fn().mockImplementation(() => {
      throw new Error("disk full");
    });
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({
      outcome: "submitted",
      spec: { command: "gh pr create", cwd: "/fake", timeoutMs: 1000 },
      execResult: { code: 0, stdout: "https://github.com/acme/widgets/pull/9\n" },
      loopResult: fakeLoopResult({ handoffPacket: { changedFiles: [{ path: "src/a.ts" }] } }),
    });

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ recordOwnSubmission: recordOwnSubmissionSpy, runMinerAttempt: runMinerAttemptSpy }),
    });

    expect(exitCode).toBe(0);
    expect(recordOwnSubmissionSpy).toHaveBeenCalled();
  });

  it("does not record own-submission history on a non-submitted outcome", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const recordOwnSubmissionSpy = vi.fn();
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({ outcome: "abandon", loopResult: fakeLoopResult() });

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ recordOwnSubmission: recordOwnSubmissionSpy, runMinerAttempt: runMinerAttemptSpy }),
    });

    expect(recordOwnSubmissionSpy).not.toHaveBeenCalled();
  });

  it("REGRESSION (#5654): the real portfolio-queue attempt history is read for THIS issue and threads into governor.convergenceInput, not the old hardcoded literal", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const realHistory = { attempts: 4, consecutiveFailures: 3, reenqueues: 3, reachedDone: false };
    const getAttemptHistorySpy = vi.fn().mockReturnValue(realHistory);
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({
      outcome: "abandon",
      loopResult: { outcome: "abandon", totalTurnsUsed: 0, totalCostUsd: 0, iterationsUsed: 0 },
    });

    await runAttempt(["acme/widgets", "42", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ getAttemptHistory: getAttemptHistorySpy, runMinerAttempt: runMinerAttemptSpy }),
    });

    expect(getAttemptHistorySpy).toHaveBeenCalledWith("acme/widgets", "issue:42");
    const [input] = runMinerAttemptSpy.mock.calls[0]!;
    expect(input.governor.convergenceInput).toEqual(realHistory);
  });

  it("REGRESSION (#5654): when options.getAttemptHistory is omitted, runAttempt falls back to the REAL portfolio-queue.js default, not a fabricated result", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-attempt-cli-portfolio-"));
    roots.push(root);
    vi.stubEnv("LOOPOVER_MINER_PORTFOLIO_QUEUE_DB", join(root, "portfolio-queue.sqlite3"));
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({
      outcome: "abandon",
      loopResult: { outcome: "abandon", totalTurnsUsed: 0, totalCostUsd: 0, iterationsUsed: 0 },
    });
    const { getAttemptHistory: _omitted, ...optionsWithoutGetAttemptHistory } = readyPipelineOptions({ runMinerAttempt: runMinerAttemptSpy });

    await runAttempt(["acme/widgets", "99", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...optionsWithoutGetAttemptHistory,
    });

    // The item was never enqueued in this fresh store -- the real default read honestly returns the
    // zero-state, same shape as the hardcoded literal it replaced, but genuinely read from disk.
    const [input] = runMinerAttemptSpy.mock.calls[0]!;
    expect(input.governor.convergenceInput).toEqual({ attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false });
  });

  it("#5185: writes attempt_outcome_summary with the real provider/cost on a non-submitted outcome too", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const appendAttemptLogEventSpy = vi.spyOn(attemptLog, "appendAttemptLogEvent");
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({
      outcome: "abandon",
      reason: "self_review_ambiguous",
      loopResult: fakeLoopResult({ outcome: "abandon", totalTurnsUsed: 1, totalCostUsd: 0, iterationsUsed: 1 }),
    });

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
      nowMs: 999,
      attemptId: "abandoned-attempt-id",
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ runMinerAttempt: runMinerAttemptSpy }),
    });

    expect(exitCode).toBe(7);
    const summaryCalls = appendAttemptLogEventSpy.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventType === "attempt_outcome_summary");
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls[0]).toMatchObject({ actionClass: "attempt_abandon", provider: "codex-cli", costUsd: 0 });
  });

  it("#5185: a broken appendAttemptLogEvent never fails an otherwise-successful attempt", async () => {
    const { allocator, claimLedger, eventLedger, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({
      outcome: "submitted",
      spec: { command: "gh pr create", cwd: "/tmp/work", timeoutMs: 1000 },
      execResult: { code: 0 },
      loopResult: fakeLoopResult({ outcome: "handoff", totalTurnsUsed: 1, totalCostUsd: 0, iterationsUsed: 1 }),
    });
    const brokenAttemptLog: AttemptLog = {
      dbPath: ":memory:",
      appendAttemptLogEvent: vi.fn().mockImplementation(() => {
        throw new Error("disk full");
      }),
      readAttemptLogEvents: () => [],
      exportAttemptLogJsonl: () => "",
      close: () => {},
    };

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      nowMs: 999,
      attemptId: "resilient-attempt-id",
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => brokenAttemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ runMinerAttempt: runMinerAttemptSpy }),
    });

    expect(exitCode).toBe(0);
  });

  it("REGRESSION (#4848): a real submitted outcome with a recoverable PR number runs the real claim-conflict check and surfaces its result", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({
      outcome: "submitted",
      spec: { command: "gh pr create", cwd: "/fake", timeoutMs: 1000 },
      execResult: { code: 0, stdout: "https://github.com/acme/widgets/pull/123\n", stderr: "", timedOut: false },
      loopResult: fakeLoopResult({ outcome: "handoff", totalTurnsUsed: 3, totalCostUsd: 0.42, iterationsUsed: 2 }),
    });
    const resolveClaimConflictSpy = vi.fn().mockResolvedValue({ checked: true, isWinner: true, winnerNumber: 123, competingCount: 0 });

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      attemptId: "conflict-attempt",
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ runMinerAttempt: runMinerAttemptSpy }),
      resolveClaimConflict: resolveClaimConflictSpy,
    });

    expect(exitCode).toBe(0);
    expect(resolveClaimConflictSpy).toHaveBeenCalledTimes(1);
    const [input, deps] = resolveClaimConflictSpy.mock.calls[0]!;
    expect(input).toMatchObject({
      repoFullName: "acme/widgets",
      issueNumber: 7,
      selfPrNumber: 123,
      minerLogin: "alice",
    });
    expect(typeof input.selfClaimedAt).toBe("string"); // the real claim-ledger record's own claimedAt
    expect(typeof deps.fetchLiveIssueSnapshot).toBe("function");
    expect(typeof deps.executeLocalWrite).toBe("function");
  });

  it("REGRESSION: uses the REAL default resolveClaimConflict (not just an injected override) when options.resolveClaimConflict is omitted", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchLiveIssueSnapshot = vi.fn().mockResolvedValue({ state: "open" as const, referencingPrs: [] });
    const executeLocalWrite = vi.fn();
    const buildAttemptDepsSpy = vi.fn((env: Record<string, string | undefined>, ledgers: unknown) => ({
      ...buildAttemptDeps(env, ledgers as never),
      fetchLiveIssueSnapshot,
      executeLocalWrite,
    }));

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({
        buildAttemptDeps: buildAttemptDepsSpy,
        runMinerAttempt: async () => ({
          outcome: "submitted",
          spec: { command: "gh pr create", cwd: "/fake", timeoutMs: 1000 },
          execResult: { code: 0, stdout: "https://github.com/acme/widgets/pull/9\n" },
          loopResult: fakeLoopResult(),
        }),
      }),
      // resolveClaimConflict deliberately omitted -- exercises the real module-level default.
    });

    expect(fetchLiveIssueSnapshot).toHaveBeenCalledWith("acme/widgets", 7);
    expect(executeLocalWrite).not.toHaveBeenCalled(); // no competing claims -> trivial win, no close_pr write
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).claimConflict).toEqual({
      checked: true,
      isWinner: true,
      winnerNumber: 9,
      competingCount: 0,
    });
  });

  it("does not run the claim-conflict check on a non-submitted outcome", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const resolveClaimConflictSpy = vi.fn();

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ runMinerAttempt: async () => ({ outcome: "abandon", loopResult: fakeLoopResult() }) }),
      resolveClaimConflict: resolveClaimConflictSpy,
    });

    expect(resolveClaimConflictSpy).not.toHaveBeenCalled();
  });

  it("does not run the claim-conflict check on a submitted outcome whose PR number can't be recovered from execResult", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const resolveClaimConflictSpy = vi.fn();

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({
        runMinerAttempt: async () => ({
          outcome: "submitted",
          spec: { command: "gh pr create", cwd: "/fake", timeoutMs: 1000 },
          execResult: { code: 0 },
          loopResult: fakeLoopResult(),
        }),
      }),
      resolveClaimConflict: resolveClaimConflictSpy,
    });

    expect(resolveClaimConflictSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).not.toHaveProperty("claimConflict");
  });

  it("REGRESSION: a real claim-conflict LOSS is surfaced verbatim in the final JSON result", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const lossResult = { checked: true as const, isWinner: false as const, winnerNumber: 5, competingCount: 1, closeResult: { action: "close_pr", code: 0 } };

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({
        runMinerAttempt: async () => ({
          outcome: "submitted",
          spec: { command: "gh pr create", cwd: "/fake", timeoutMs: 1000 },
          execResult: { code: 0, stdout: "https://github.com/acme/widgets/pull/6\n" },
          loopResult: fakeLoopResult(),
        }),
      }),
      resolveClaimConflict: async () => lossResult,
    });

    expect(JSON.parse(String(log.mock.calls[0]?.[0])).claimConflict).toEqual(lossResult);
  });

  it("resolves live mode only when --live is passed, and threads it through to the real loopInput", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({ outcome: "abandon", loopResult: fakeLoopResult() });

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
      ...readyPipelineOptions({ runMinerAttempt: async () => ({ outcome: "abandon", loopResult: fakeLoopResult() }) }),
    });

    expect(exitCode).toBe(7);
    expect(String(log.mock.calls[0]?.[0])).toContain("finished with outcome: abandon");
  });

  it.each([
    ["stale", 8, { outcome: "stale", reason: "expired", loopResult: fakeLoopResult() }],
    ["blocked", 9, { outcome: "blocked", decision: { allow: false }, loopResult: fakeLoopResult() }],
    ["governed", 10, { outcome: "governed", decision: { allowed: false }, loopResult: fakeLoopResult() }],
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
        runMinerAttempt: async () => ({ outcome: "governed", decision: { allowed: false }, loopResult: fakeLoopResult() }),
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
      ...readyPipelineOptions({ resolveRejectionSignaled: resolveRejectionSignaledSpy, fetchImpl, runMinerAttempt: async () => ({ outcome: "abandon", loopResult: fakeLoopResult() }) }),
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
      ...readyPipelineOptions({ prepareAttemptWorktree: prepareAttemptWorktreeSpy, runMinerAttempt: async () => ({ outcome: "abandon", loopResult: fakeLoopResult() }) }),
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
      ...readyPipelineOptions({ fetchSelfReviewContext: fetchSelfReviewContextSpy, runMinerAttempt: async () => ({ outcome: "abandon", loopResult: fakeLoopResult() }) }),
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
        runMinerAttempt: async () => ({ outcome: "submitted", spec: { command: "gh pr create", cwd: "/fake", timeoutMs: 1 }, execResult: { code: 0 }, loopResult: fakeLoopResult() }),
      }),
      onResult,
    });
    expect(submittedExit).toBe(0);
    expect(onResult).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "attempt_submitted", spec: expect.objectContaining({ command: "gh pr create" }) }));
  });
});

describe("runAttempt: real per-repo kill switch (#5392)", () => {
  it("resolves the real MinerGoalSpec from the worktree's repoPath and threads killSwitch.paused through to checkMinerKillSwitch and the governor context", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const worktreeResult = fakeWorktreeResult();
    const resolveMinerGoalSpecSpy = vi.fn().mockReturnValue({ present: true, spec: { ...DEFAULT_MINER_GOAL_SPEC, killSwitch: { paused: true } }, warnings: [] });
    const checkMinerKillSwitchSpy = vi.fn().mockReturnValue({ scope: "repo" as const, active: true });
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({ outcome: "governed", decision: { allowed: false }, loopResult: fakeLoopResult() });

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({
        resolveMinerGoalSpec: resolveMinerGoalSpecSpy,
        checkMinerKillSwitch: checkMinerKillSwitchSpy,
        runMinerAttempt: runMinerAttemptSpy,
      }),
    });

    expect(resolveMinerGoalSpecSpy).toHaveBeenCalledWith(worktreeResult.repoPath);
    expect(checkMinerKillSwitchSpy).toHaveBeenCalledWith({ env: { MINER_CODING_AGENT_PROVIDER: "noop" }, repoPaused: true });
    const [input] = runMinerAttemptSpy.mock.calls[0]!;
    expect(input.killSwitchScope).toBe("repo");
    expect(input.governor.killSwitchRepoPaused).toBe(true);
  });

  it("REGRESSION: reads a real .gittensory-miner.yml killSwitch.paused:true from the worktree's real repoPath, end to end", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const repoRoot = mkdtempSync(join(tmpdir(), "loopover-miner-attempt-cli-repo-"));
    roots.push(repoRoot);
    writeFileSync(join(repoRoot, ".gittensory-miner.yml"), "killSwitch:\n  paused: true\n");
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({ outcome: "governed", decision: { allowed: false }, loopResult: fakeLoopResult() });

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({
        resolveMinerGoalSpec: undefined, // use the real, non-injected resolver against the real repoRoot below
        checkMinerKillSwitch: undefined, // use the real resolver too, so it actually reacts to repoPaused
        prepareAttemptWorktree: async () => ({ ok: true, worktreePath: repoRoot, repoPath: repoRoot, branchName: "gittensory/attempt/real" }),
        runMinerAttempt: runMinerAttemptSpy,
      }),
    });

    const [input] = runMinerAttemptSpy.mock.calls[0]!;
    expect(input.killSwitchScope).toBe("repo");
    expect(input.governor.killSwitchRepoPaused).toBe(true);
  });

  it("does not gate on a repo pause when no .gittensory-miner.yml exists (real resolver, real empty dir)", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const repoRoot = mkdtempSync(join(tmpdir(), "loopover-miner-attempt-cli-repo-"));
    roots.push(repoRoot);
    const runMinerAttemptSpy = vi.fn().mockResolvedValue({ outcome: "abandon", loopResult: fakeLoopResult() });

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({
        resolveMinerGoalSpec: undefined,
        checkMinerKillSwitch: undefined,
        prepareAttemptWorktree: async () => ({ ok: true, worktreePath: repoRoot, repoPath: repoRoot, branchName: "gittensory/attempt/real" }),
        runMinerAttempt: runMinerAttemptSpy,
      }),
    });

    const [input] = runMinerAttemptSpy.mock.calls[0]!;
    expect(input.killSwitchScope).toBe("none");
    expect(input.governor.killSwitchRepoPaused).toBe(false);
  });
});

describe("runAttempt: real claim-ledger wiring (#5393)", () => {
  it("REGRESSION: claims the real issue before invoking runMinerAttempt, and releases it once the attempt finishes", async () => {
    // claimLedger is closed in runAttempt's own `finally` block once it returns (matching the file's own
    // "runAttempt tests inject theirs via DI" convention above) -- so the released-after state is asserted via
    // a spy recorded DURING the call, not by re-querying the ledger once it's already closed.
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const releaseClaimSpy = vi.spyOn(claimLedger, "releaseClaim");
    let activeClaimsDuringAttempt: unknown[] = [];
    const runMinerAttemptSpy = vi.fn().mockImplementation(async () => {
      activeClaimsDuringAttempt = claimLedger.listActiveClaims("acme/widgets");
      return {
        outcome: "submitted",
        spec: { command: "gh pr create", cwd: "/fake", timeoutMs: 1 },
        execResult: { code: 0 },
        loopResult: fakeLoopResult(),
      };
    });

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ runMinerAttempt: runMinerAttemptSpy }),
    });

    // Active (visible to a sibling miner process) while the real attempt was running...
    expect(activeClaimsDuringAttempt).toHaveLength(1);
    expect(activeClaimsDuringAttempt[0]).toMatchObject({ repoFullName: "acme/widgets", issueNumber: 7, status: "active" });
    // ...and released once the attempt concluded.
    expect(releaseClaimSpy).toHaveBeenCalledWith("acme/widgets", 7);
  });

  it("releases the real claim even on a non-submitted terminal outcome", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const releaseClaimSpy = vi.spyOn(claimLedger, "releaseClaim");

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({ runMinerAttempt: async () => ({ outcome: "abandon", loopResult: fakeLoopResult() }) }),
    });

    expect(releaseClaimSpy).toHaveBeenCalledWith("acme/widgets", 7);
  });

  it("REGRESSION: releases the real claim even when runMinerAttempt throws unexpectedly", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const releaseClaimSpy = vi.spyOn(claimLedger, "releaseClaim");

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({
        runMinerAttempt: async () => {
          throw new Error("boom");
        },
      }),
    });

    expect(exitCode).toBe(2);
    expect(releaseClaimSpy).toHaveBeenCalledWith("acme/widgets", 7);
  });

  it("never claims when the attempt is blocked before feasibility is even checked (rejection-signaled)", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const claimIssueSpy = vi.spyOn(claimLedger, "claimIssue");

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      resolveRejectionSignaled: async () => true,
    });

    expect(claimIssueSpy).not.toHaveBeenCalled();
  });

  it("never claims when the coding-task-spec is infeasible", async () => {
    const { allocator, claimLedger, eventLedger, attemptLog, governorLedger } = tempLedgers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const claimIssueSpy = vi.spyOn(claimLedger, "claimIssue");

    await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      env: { MINER_CODING_AGENT_PROVIDER: "noop" },
      openWorktreeAllocator: () => allocator,
      openClaimLedger: () => claimLedger,
      initEventLedger: () => eventLedger,
      initAttemptLog: () => attemptLog,
      initGovernorLedger: () => governorLedger,
      ...readyPipelineOptions({
        buildCodingTaskSpec: () => ({
          ready: false,
          verdict: "avoid",
          feasibility: { verdict: "avoid", avoidReasons: ["already_claimed"], raiseReasons: [], summary: "not feasible" },
        }),
      }),
    });

    expect(claimIssueSpy).not.toHaveBeenCalled();
  });
});
