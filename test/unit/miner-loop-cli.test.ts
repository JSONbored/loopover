import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { parseLoopArgs, runLoop } from "../../packages/gittensory-miner/lib/loop-cli.js";
import { initEventLedger } from "../../packages/gittensory-miner/lib/event-ledger.js";
import { initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";
import { initPortfolioQueueStore } from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import { initRunStateStore } from "../../packages/gittensory-miner/lib/run-state.js";
import { openGovernorState } from "../../packages/gittensory-miner/lib/governor-state.js";
import { DEFAULT_AMS_POLICY_SPEC } from "../../packages/gittensory-engine/src/index";

const roots: string[] = [];
// Fresh, separate connections opened AFTER a runLoop call to inspect real persisted state -- runLoop's own
// `finally` always closes the store handles it was given, so re-reading through the SAME handle afterward
// fails ("statement has been finalized"). A fresh connection to the same on-disk file sees the same data.
const postRunClosers: Array<{ close(): void }> = [];

function tempPath(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `gittensory-miner-${prefix}-`));
  roots.push(root);
  return join(root, "db.sqlite3");
}

// runLoop's own `finally` block always closes every store it's handed (success or error path), mirroring
// runAttempt's own DI contract -- registering these in a shared closer list here would double-close (the
// underlying SQLite handle throws "database is not open" / "statement has been finalized" on a second close).
function tempStores() {
  const eventLedgerPath = tempPath("loop-cli-events");
  const governorLedgerPath = tempPath("loop-cli-governor-ledger");
  const portfolioQueuePath = tempPath("loop-cli-queue");
  const runStatePath = tempPath("loop-cli-runstate");
  const governorStatePath = tempPath("loop-cli-governor-state");
  return {
    eventLedger: initEventLedger(eventLedgerPath),
    governorLedger: initGovernorLedger(governorLedgerPath),
    portfolioQueue: initPortfolioQueueStore(portfolioQueuePath),
    runState: initRunStateStore(runStatePath),
    governorState: openGovernorState(governorStatePath),
    paths: { eventLedgerPath, governorLedgerPath, portfolioQueuePath, runStatePath, governorStatePath },
  };
}

/** Open a fresh connection to inspect state persisted by a completed runLoop call. */
function reopenAfterRun(paths: ReturnType<typeof tempStores>["paths"]) {
  const eventLedger = initEventLedger(paths.eventLedgerPath);
  const governorLedger = initGovernorLedger(paths.governorLedgerPath);
  const portfolioQueue = initPortfolioQueueStore(paths.portfolioQueuePath);
  const governorState = openGovernorState(paths.governorStatePath);
  postRunClosers.push(eventLedger, governorLedger, portfolioQueue, governorState);
  return { eventLedger, governorLedger, portfolioQueue, governorState };
}

/** A no-op discover stub that primes the shared queue with one fixed candidate the first time it's called on
 *  an empty queue, then does nothing on later calls -- markFailed/reentry already keep re-surfacing the same
 *  claimed item without needing fresh discovery every cycle. */
function primeOnceDiscover(portfolioQueue: ReturnType<typeof initPortfolioQueueStore>, item: { repoFullName: string; identifier: string }) {
  return vi.fn(async () => {
    if (portfolioQueue.listQueue().length === 0) portfolioQueue.enqueue(item);
    return 0;
  });
}

function readyLoopOptions(overrides: Record<string, unknown> = {}) {
  return {
    resolveAmsPolicy: async () => ({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default" as const, warnings: [] }),
    checkMinerKillSwitch: () => ({ scope: "none" as const, active: false }),
    sleepFn: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(() => {
  for (const closer of postRunClosers.splice(0)) closer.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("parseLoopArgs (#5135)", () => {
  it("parses repo targets with the required miner-login and every optional flag", () => {
    expect(
      parseLoopArgs([
        "acme/widgets",
        "acme/other",
        "--miner-login",
        "alice",
        "--base",
        "develop",
        "--live",
        "--max-cycles",
        "5",
        "--cycle-delay-ms",
        "1000",
        "--json",
      ]),
    ).toEqual({
      targets: ["acme/widgets", "acme/other"],
      search: null,
      minerLogin: "alice",
      base: "develop",
      live: true,
      maxCycles: 5,
      cycleDelayMs: 1000,
      json: true,
    });
  });

  it("parses a --search query in place of repo targets", () => {
    expect(parseLoopArgs(["--search", "label:good-first-issue", "--miner-login", "alice"])).toEqual({
      targets: [],
      search: "label:good-first-issue",
      minerLogin: "alice",
      base: "main",
      live: false,
      maxCycles: undefined,
      cycleDelayMs: 60_000,
      json: false,
    });
  });

  it("requires --miner-login", () => {
    expect(parseLoopArgs(["acme/widgets"])).toEqual({ error: expect.stringContaining("--miner-login is required") });
  });

  it("rejects mixing repo targets and --search", () => {
    expect(parseLoopArgs(["acme/widgets", "--search", "x", "--miner-login", "alice"])).toEqual({
      error: "Pass either repository targets or --search, not both.",
    });
  });

  it("requires at least one target or --search", () => {
    expect(parseLoopArgs(["--miner-login", "alice"])).toEqual({ error: expect.stringContaining("Usage:") });
  });

  it("rejects a malformed repo target", () => {
    expect(parseLoopArgs(["not-a-repo", "--miner-login", "alice"])).toEqual({
      error: "Repository must be in owner/repo form: not-a-repo",
    });
  });

  it("rejects a non-integer or negative --max-cycles / --cycle-delay-ms", () => {
    expect(parseLoopArgs(["acme/widgets", "--miner-login", "alice", "--max-cycles", "abc"])).toHaveProperty("error");
    expect(parseLoopArgs(["acme/widgets", "--miner-login", "alice", "--max-cycles", "-1"])).toHaveProperty("error");
    expect(parseLoopArgs(["acme/widgets", "--miner-login", "alice", "--cycle-delay-ms", "abc"])).toHaveProperty("error");
  });

  it("rejects an unknown flag", () => {
    expect(parseLoopArgs(["acme/widgets", "--miner-login", "alice", "--bogus"])).toEqual({
      error: "Unknown option: --bogus",
    });
  });
});

describe("runLoop (#5135)", () => {
  it("fails closed: refuses to start when governor state cannot be loaded", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitCode = await runLoop(["acme/widgets", "--miner-login", "alice"], {
      openGovernorState: () => {
        throw new Error("corrupt_governor_state_db");
      },
    });
    expect(exitCode).toBe(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("governor state cannot be loaded"));
  });

  it("halts immediately on an active kill switch, before running discovery or any attempt", async () => {
    const { eventLedger, governorLedger, portfolioQueue, runState, governorState } = tempStores();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runDiscoverSpy = vi.fn();
    const runAttemptSpy = vi.fn();

    const exitCode = await runLoop(["acme/widgets", "--miner-login", "alice", "--json"], {
      openGovernorState: () => governorState,
      initEventLedger: () => eventLedger,
      initGovernorLedger: () => governorLedger,
      initPortfolioQueue: () => portfolioQueue,
      initRunStateStore: () => runState,
      runDiscover: runDiscoverSpy,
      runAttempt: runAttemptSpy,
      ...readyLoopOptions({ checkMinerKillSwitch: () => ({ scope: "global" as const, active: true }) }),
    });

    expect(exitCode).toBe(0);
    expect(runDiscoverSpy).not.toHaveBeenCalled();
    expect(runAttemptSpy).not.toHaveBeenCalled();
    const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(printed.haltReason).toBe("kill_switch_global");
    expect(printed.cycles).toEqual([{ cycle: 1, outcome: "halted", reason: "kill_switch_global" }]);
  });

  it("REGRESSION: runs a full cycle end to end -- claims, attempts, polls real PR disposition, records the outcome, and re-enters", async () => {
    const { eventLedger, governorLedger, portfolioQueue, runState, governorState, paths } = tempStores();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const item = { repoFullName: "acme/widgets", identifier: "issue:7" };
    const runDiscoverSpy = primeOnceDiscover(portfolioQueue, item);
    const runAttemptSpy = vi.fn(async (_args: string[], options?: Record<string, unknown>) => {
      (options?.onResult as ((result: unknown) => void) | undefined)?.({
        outcome: "attempt_submitted",
        repoFullName: "acme/widgets",
        issueNumber: 7,
        minerLogin: "alice",
        base: "main",
        mode: "dry_run",
        attemptId: "loop-attempt-1",
        submissionMode: "observe",
        totalTurnsUsed: 4,
        iterationsUsed: 1,
        execResult: { action: "open_pr", stdout: "https://github.com/acme/widgets/pull/123\n", stderr: "", code: 0, timedOut: false },
      });
      return 0;
    });
    const pollPrDispositionSpy = vi.fn().mockResolvedValue({ state: "closed", merged: true, closedAt: "2026-07-12T00:00:00Z", attempts: 1 });

    const exitCode = await runLoop(["acme/widgets", "--miner-login", "alice", "--max-cycles", "2", "--json"], {
      env: { GITHUB_TOKEN: "ghp_loop_test" },
      openGovernorState: () => governorState,
      initEventLedger: () => eventLedger,
      initGovernorLedger: () => governorLedger,
      initPortfolioQueue: () => portfolioQueue,
      initRunStateStore: () => runState,
      runDiscover: runDiscoverSpy,
      runAttempt: runAttemptSpy,
      pollPrDisposition: pollPrDispositionSpy,
      ...readyLoopOptions(),
    });

    expect(exitCode).toBe(0);
    expect(runAttemptSpy).toHaveBeenCalledTimes(1);
    const [attemptArgv] = runAttemptSpy.mock.calls[0]!;
    expect(attemptArgv).toEqual(["acme/widgets", "7", "--miner-login", "alice", "--base", "main"]);

    // REGRESSION: the real githubToken (resolved from env.GITHUB_TOKEN, same as runDiscover's own call) must
    // reach the poller -- an unauthenticated poll would silently hit GitHub's much lower rate limit or fail
    // outright against a private repo.
    expect(pollPrDispositionSpy).toHaveBeenCalledWith("acme/widgets", 123, expect.objectContaining({ githubToken: "ghp_loop_test" }));

    const after = reopenAfterRun(paths);

    // recordPrOutcomeSnapshot (real, not mocked) actually persisted the merged decision to the shared ledger.
    const prOutcomeEvents = after.eventLedger.readEvents({}).filter((e) => e.type === "pr_outcome");
    expect(prOutcomeEvents).toHaveLength(1);
    expect(prOutcomeEvents[0]?.payload).toMatchObject({ prNumber: 123, decision: "merged" });

    // The claimed item resolved to done (real success), not left in_progress or requeued.
    expect(after.portfolioQueue.listQueue()).toEqual([expect.objectContaining({ identifier: "issue:7", status: "done" })]);

    // Real governor cap usage was saved using runAttempt's own real totalTurnsUsed, not fabricated.
    expect(after.governorState.loadCapUsage().turnsTaken).toBe(4);

    // Re-entry actually fired (a real loop_reentry_decision event, reentered on a merged outcome).
    const reentryEvents = after.eventLedger.readEvents({}).filter((e) => e.type === "loop_reentry_decision");
    expect(reentryEvents).toHaveLength(1);
    expect(reentryEvents[0]?.payload).toMatchObject({ reentered: true, outcome: "merged" });

    const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(printed.cycles[0]).toMatchObject({ outcome: "attempted", attemptOutcome: "attempt_submitted", reentryOutcome: "merged", prNumber: 123 });
  });

  it("REGRESSION: a repeatedly-blocked (non-permanent) outcome requeues the item and eventually halts on real non-convergence, not forever", async () => {
    const { eventLedger, governorLedger, portfolioQueue, runState, governorState, paths } = tempStores();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const item = { repoFullName: "acme/widgets", identifier: "issue:9" };
    const runDiscoverSpy = primeOnceDiscover(portfolioQueue, item);
    const runAttemptSpy = vi.fn(async (_args: string[], options?: Record<string, unknown>) => {
      (options?.onResult as ((result: unknown) => void) | undefined)?.({
        outcome: "attempt_blocked",
        repoFullName: "acme/widgets",
        issueNumber: 9,
        minerLogin: "alice",
        base: "main",
        mode: "dry_run",
        attemptId: `loop-attempt-${Date.now()}`,
        submissionMode: "observe",
        totalTurnsUsed: 1,
        iterationsUsed: 1,
        decision: { allowed: false },
      });
      return 9;
    });

    const exitCode = await runLoop(["acme/widgets", "--miner-login", "alice", "--max-cycles", "10", "--json"], {
      openGovernorState: () => governorState,
      initEventLedger: () => eventLedger,
      initGovernorLedger: () => governorLedger,
      initPortfolioQueue: () => portfolioQueue,
      initRunStateStore: () => runState,
      runDiscover: runDiscoverSpy,
      runAttempt: runAttemptSpy,
      ...readyLoopOptions(),
    });

    expect(exitCode).toBe(0);
    // DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS.maxReenqueues is 3: the item is attempted 3 times (reenqueues
    // reaching 1, 2, 3), then the 4th cycle's boundary check halts BEFORE attempting a 4th time.
    expect(runAttemptSpy).toHaveBeenCalledTimes(3);
    const after = reopenAfterRun(paths);
    const governorEvents = after.governorLedger.readGovernorEvents({});
    expect(governorEvents.some((e) => e.reason === "non_convergence_detected")).toBe(true);
    // The run-loop boundary gate released the in-flight item back to 'queued' on the fresh halt.
    expect(after.portfolioQueue.listQueue()).toHaveLength(1);
    expect(after.portfolioQueue.listQueue()[0]).toMatchObject({ status: "queued" });
  });

  it("REGRESSION: a permanent (AI-usage-policy) block marks the item done instead of re-queuing it forever", async () => {
    const { eventLedger, governorLedger, portfolioQueue, runState, governorState, paths } = tempStores();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const item = { repoFullName: "acme/widgets", identifier: "issue:11" };
    const runDiscoverSpy = primeOnceDiscover(portfolioQueue, item);
    const runAttemptSpy = vi.fn(async (_args: string[], options?: Record<string, unknown>) => {
      (options?.onResult as ((result: unknown) => void) | undefined)?.({
        outcome: "blocked_rejection_signaled",
        reason: "ai_usage_policy_ban",
        repoFullName: "acme/widgets",
        issueNumber: 11,
        minerLogin: "alice",
        base: "main",
        mode: "dry_run",
        attemptId: "loop-attempt-permanent",
      });
      return 5;
    });

    const exitCode = await runLoop(["acme/widgets", "--miner-login", "alice", "--max-cycles", "3", "--json"], {
      openGovernorState: () => governorState,
      initEventLedger: () => eventLedger,
      initGovernorLedger: () => governorLedger,
      initPortfolioQueue: () => portfolioQueue,
      initRunStateStore: () => runState,
      runDiscover: runDiscoverSpy,
      runAttempt: runAttemptSpy,
      ...readyLoopOptions(),
    });

    expect(exitCode).toBe(0);
    // Attempted exactly once -- a permanent block is marked done, not requeued, so cycles 2-3 are idle.
    expect(runAttemptSpy).toHaveBeenCalledTimes(1);
    expect(reopenAfterRun(paths).portfolioQueue.listQueue()).toEqual([
      expect.objectContaining({ identifier: "issue:11", status: "done" }),
    ]);
  });

  it("respects --max-cycles even when the queue never has anything to claim", async () => {
    const { eventLedger, governorLedger, portfolioQueue, runState, governorState } = tempStores();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runDiscoverSpy = vi.fn().mockResolvedValue(0);
    const runAttemptSpy = vi.fn();
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const exitCode = await runLoop(["acme/widgets", "--miner-login", "alice", "--max-cycles", "3", "--json"], {
      openGovernorState: () => governorState,
      initEventLedger: () => eventLedger,
      initGovernorLedger: () => governorLedger,
      initPortfolioQueue: () => portfolioQueue,
      initRunStateStore: () => runState,
      runDiscover: runDiscoverSpy,
      runAttempt: runAttemptSpy,
      ...readyLoopOptions({ sleepFn }),
    });

    expect(exitCode).toBe(0);
    expect(runAttemptSpy).not.toHaveBeenCalled();
    const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(printed.haltReason).toBe("max_cycles_reached");
    expect(printed.cycles.every((c: { outcome: string }) => c.outcome === "idle_queue_empty")).toBe(true);
    expect(printed.cycles).toHaveLength(3);
  });

  it("closes every store it opened, even when an unexpected error is thrown mid-cycle", async () => {
    const { eventLedger, governorLedger, portfolioQueue, runState, governorState } = tempStores();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const closeSpies = [eventLedger, governorLedger, portfolioQueue, runState, governorState].map((store) => vi.spyOn(store, "close"));

    const exitCode = await runLoop(["acme/widgets", "--miner-login", "alice"], {
      openGovernorState: () => governorState,
      initEventLedger: () => eventLedger,
      initGovernorLedger: () => governorLedger,
      initPortfolioQueue: () => portfolioQueue,
      initRunStateStore: () => runState,
      runDiscover: async () => {
        throw new Error("network_unreachable");
      },
      ...readyLoopOptions(),
    });

    expect(exitCode).toBe(2);
    for (const spy of closeSpies) expect(spy).toHaveBeenCalledTimes(1);
  });
});
