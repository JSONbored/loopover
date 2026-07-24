import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openClaimLedger, closeDefaultClaimLedger } from "../../packages/loopover-miner/lib/claim-ledger.js";
import { initEventLedger, closeDefaultEventLedger } from "../../packages/loopover-miner/lib/event-ledger.js";
import { initGovernorLedger, closeDefaultGovernorLedger } from "../../packages/loopover-miner/lib/governor-ledger.js";
import { initPredictionLedger, closeDefaultPredictionLedger } from "../../packages/loopover-miner/lib/prediction-ledger.js";
import {
  initPortfolioQueueStore,
  closeDefaultPortfolioQueueStore,
} from "../../packages/loopover-miner/lib/portfolio-queue.js";
import { initRunStateStore, closeDefaultRunStateStore } from "../../packages/loopover-miner/lib/run-state.js";
import { initAttemptLog, closeDefaultAttemptLog } from "../../packages/loopover-miner/lib/attempt-log.js";
import {
  initContributionProfileCache,
  closeDefaultContributionProfileCache,
} from "../../packages/loopover-miner/lib/contribution-profile-cache.js";
import { initPolicyVerdictCacheStore } from "../../packages/loopover-miner/lib/policy-verdict-cache.js";
import { openGovernorState } from "../../packages/loopover-miner/lib/governor-state.js";
import { initRankedCandidatesStore } from "../../packages/loopover-miner/lib/ranked-candidates.js";
import { openReplaySnapshotStore } from "../../packages/loopover-miner/lib/replay-snapshot.js";
import { initDenyHookSynthesisStore } from "../../packages/loopover-miner/lib/deny-hook-synthesis.js";
import { openWorktreeAllocator } from "../../packages/loopover-miner/lib/worktree-allocator.js";
import { emptyContributionProfile } from "../../packages/loopover-miner/lib/contribution-profile.js";
import { DatabaseSync } from "node:sqlite";
import {
  ATTEMPT_LOG_NOT_PURGEABLE_NOTE,
  parsePurgeArgs,
  runPurge,
} from "../../packages/loopover-miner/lib/purge-cli.js";

const roots: string[] = [];
const closeables: Array<{ close(): void }> = [];
const POLICY_VERDICT = { allowed: true, matchedPhrase: null, source: "AI-USAGE.md" } as const;

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
  closeDefaultPortfolioQueueStore();
  closeDefaultRunStateStore();
  closeDefaultAttemptLog();
  closeDefaultContributionProfileCache();
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

describe("runPurge --dry-run (#5564, #6599)", () => {
  it("counts matching rows across the thirteen real stores without writing anything, and reports attempt-log as not-purgeable", async () => {
    const root = tempDir();
    const claimDbPath = join(root, "claim-ledger.sqlite3");
    const eventDbPath = join(root, "event-ledger.sqlite3");
    const governorDbPath = join(root, "governor-ledger.sqlite3");
    const predictionDbPath = join(root, "prediction-ledger.sqlite3");
    const portfolioDbPath = join(root, "portfolio-queue.sqlite3");
    const runStateDbPath = join(root, "run-state.sqlite3");
    const cacheDbPath = join(root, "contribution-profile-cache.sqlite3");
    const policyVerdictCacheDbPath = join(root, "policy-verdict-cache.sqlite3");
    const governorStateDbPath = join(root, "governor-state.sqlite3");
    const rankedCandidatesDbPath = join(root, "ranked-candidates.sqlite3");
    const replaySnapshotDbPath = join(root, "replay-snapshot.sqlite3");
    const denyHookSynthesisDbPath = join(root, "deny-hook-synthesis.sqlite3");
    const worktreeAllocatorDbPath = join(root, "worktree-allocator.sqlite3");
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

    const portfolioQueue = initPortfolioQueueStore(portfolioDbPath);
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue-1" });
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue-2" });
    portfolioQueue.enqueue({ repoFullName: "acme/other", identifier: "issue-3" });
    portfolioQueue.close();

    const runState = initRunStateStore(runStateDbPath);
    runState.setRunState("acme/widgets", "planning");
    runState.setRunState("acme/other", "idle");
    runState.close();

    const cache = initContributionProfileCache(cacheDbPath);
    cache.put(emptyContributionProfile("acme/widgets", "2026-07-17T00:00:00.000Z"));
    cache.put(emptyContributionProfile("acme/other", "2026-07-17T00:00:00.000Z"));
    cache.close();

    const policyVerdictCache = initPolicyVerdictCacheStore(policyVerdictCacheDbPath);
    policyVerdictCache.put("acme/widgets", "AI-USAGE.md", '"v1"', POLICY_VERDICT);
    policyVerdictCache.put("acme/other", "AI-USAGE.md", '"v2"', POLICY_VERDICT);
    policyVerdictCache.close();

    // governor-state's two repo-scoped tables. reputation history for acme/widgets is recorded under TWO
    // api_base_urls (both count for the repo, since the purge filters on repo_full_name alone) plus two own
    // submissions; the whole-run scalar row (governor_scalar_state) is not repo-scoped and never counted.
    const governorState = openGovernorState(governorStateDbPath);
    governorState.saveReputationHistory("acme/widgets", { decided: 5, unfavorable: 2 }, "https://api.github.com");
    governorState.saveReputationHistory("acme/widgets", { decided: 3, unfavorable: 1 }, "https://gitlab.example/api");
    governorState.saveReputationHistory("acme/other", { decided: 1, unfavorable: 0 });
    governorState.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "fp-1" });
    governorState.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "fp-2" });
    governorState.close();

    // The three #8009 stores, one acme/widgets row + one acme/other row each (only widgets' must count).
    const rankedCandidates = initRankedCandidatesStore(rankedCandidatesDbPath);
    rankedCandidates.saveRankedCandidates([
      { repoFullName: "acme/widgets", issueNumber: 1, rankScore: 0.9 },
      { repoFullName: "acme/other", issueNumber: 2, rankScore: 0.5 },
    ]);
    rankedCandidates.close();

    const replaySnapshots = openReplaySnapshotStore(replaySnapshotDbPath);
    replaySnapshots.saveSnapshot({
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      worktreePath: "/repo/.loopover-replay-snapshots/abc123",
      targetDate: "2026-01-05T00:00:00+00:00",
      commits: [{ sha: "abc123", date: "2026-01-05T00:00:00+00:00", subject: "t" }],
      tags: [],
      readme: null,
    });
    replaySnapshots.saveSnapshot({
      repoFullName: "acme/other",
      commitSha: "def456",
      worktreePath: "/repo/.loopover-replay-snapshots/def456",
      targetDate: "2026-01-05T00:00:00+00:00",
      commits: [{ sha: "def456", date: "2026-01-05T00:00:00+00:00", subject: "t" }],
      tags: [],
      readme: null,
    });
    replaySnapshots.close();

    // Two identical history records synthesize exactly one proposal per repo (the same seeding
    // miner-deny-hook-synthesis.test.ts's own suite relies on).
    const denyHookSynthesis = initDenyHookSynthesisStore(denyHookSynthesisDbPath);
    denyHookSynthesis.refreshProposals("acme/widgets", [
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
    ]);
    denyHookSynthesis.refreshProposals("acme/other", [
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
    ]);
    denyHookSynthesis.close();

    // worktree-allocator only counts a FREE slot's stale repo_full_name (#8320) — normal release() already
    // blanks it, so seed one directly (bypassing acquire/release) the same way miner-worktree-allocator.test.ts
    // does for its own purgeByRepo suite. Two free slots, one per repo, only widgets' must count.
    const worktreeAllocator = openWorktreeAllocator({
      dbPath: worktreeAllocatorDbPath,
      worktreeBaseDir: join(root, "worktrees"),
      maxConcurrency: 2,
    });
    worktreeAllocator.close();
    const worktreeDb = new DatabaseSync(worktreeAllocatorDbPath);
    worktreeDb.prepare("UPDATE worktree_slots SET repo_full_name = ? WHERE slot_index = 0").run("acme/widgets");
    worktreeDb.prepare("UPDATE worktree_slots SET repo_full_name = ? WHERE slot_index = 1").run("acme/other");
    worktreeDb.close();

    const resolveDbPaths = {
      "claim-ledger": () => claimDbPath,
      "event-ledger": () => eventDbPath,
      "governor-ledger": () => governorDbPath,
      "prediction-ledger": () => predictionDbPath,
      "portfolio-queue": () => portfolioDbPath,
      "run-state": () => runStateDbPath,
      "contribution-profile-cache": () => cacheDbPath,
      "policy-verdict-cache": () => policyVerdictCacheDbPath,
      "governor-state": () => governorStateDbPath,
      "ranked-candidates": () => rankedCandidatesDbPath,
      "replay-snapshot": () => replaySnapshotDbPath,
      "deny-hook-synthesis": () => denyHookSynthesisDbPath,
      "worktree-allocator": () => worktreeAllocatorDbPath,
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
        { store: "portfolio-queue", wouldPurge: 2 },
        { store: "run-state", wouldPurge: 1 },
        { store: "contribution-profile-cache", wouldPurge: 1 },
        // governor-state sums BOTH tables: 2 reputation rows (two api_base_urls) + 2 own submissions = 4.
        { store: "governor-state", wouldPurge: 4 },
        { store: "policy-verdict-cache", wouldPurge: 1 },
        { store: "ranked-candidates", wouldPurge: 1 },
        { store: "replay-snapshot", wouldPurge: 1 },
        { store: "deny-hook-synthesis", wouldPurge: 1 },
        { store: "worktree-allocator", wouldPurge: 1 },
      ],
      attemptLogNote: ATTEMPT_LOG_NOT_PURGEABLE_NOTE,
      attemptLogTotalRows: 0,
    });
    // No writes: none of the store files' row counts changed, and attempt-log was never even created.
    expect(existsSync(attemptLogDbPath)).toBe(false);
    const reopenedClaim = openClaimLedger(claimDbPath);
    closeables.push(reopenedClaim);
    expect(reopenedClaim.listClaims()).toHaveLength(3);
    const reopenedWorktreeDb = new DatabaseSync(worktreeAllocatorDbPath, { readOnly: true });
    const stillStaleSlot = reopenedWorktreeDb
      .prepare("SELECT repo_full_name FROM worktree_slots WHERE slot_index = 0")
      .get() as { repo_full_name: string | null };
    reopenedWorktreeDb.close();
    expect(stillStaleSlot.repo_full_name).toBe("acme/widgets");

    log.mockClear();
    expect(runPurge(["--repo", "acme/widgets", "--dry-run"], { resolveDbPaths })).toBe(0);
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("DRY RUN: would purge acme/widgets from:");
    expect(text).toContain("claim-ledger=2");
    expect(text).toContain("portfolio-queue=2");
    expect(text).toContain("run-state=1");
    expect(text).toContain("worktree-allocator=1");
    expect(text).toContain(ATTEMPT_LOG_NOT_PURGEABLE_NOTE);
  });

  it("reports 0 for every store when none of the files exist yet, and creates nothing", () => {
    const root = tempDir();
    const resolveDbPaths = {
      "claim-ledger": () => join(root, "claim-ledger.sqlite3"),
      "event-ledger": () => join(root, "event-ledger.sqlite3"),
      "governor-ledger": () => join(root, "governor-ledger.sqlite3"),
      "prediction-ledger": () => join(root, "prediction-ledger.sqlite3"),
      "portfolio-queue": () => join(root, "portfolio-queue.sqlite3"),
      "run-state": () => join(root, "run-state.sqlite3"),
      "contribution-profile-cache": () => join(root, "contribution-profile-cache.sqlite3"),
      "policy-verdict-cache": () => join(root, "policy-verdict-cache.sqlite3"),
      "governor-state": () => join(root, "governor-state.sqlite3"),
      "ranked-candidates": () => join(root, "ranked-candidates.sqlite3"),
      "replay-snapshot": () => join(root, "replay-snapshot.sqlite3"),
      "deny-hook-synthesis": () => join(root, "deny-hook-synthesis.sqlite3"),
      "worktree-allocator": () => join(root, "worktree-allocator.sqlite3"),
      "attempt-log": () => join(root, "attempt-log.sqlite3"),
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runPurge(["--repo", "acme/widgets", "--dry-run", "--json"], { resolveDbPaths })).toBe(0);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.stores).toHaveLength(13);
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
      "portfolio-queue": () => join(root, "portfolio-queue.sqlite3"),
      "run-state": () => join(root, "run-state.sqlite3"),
      "contribution-profile-cache": () => join(root, "contribution-profile-cache.sqlite3"),
      "policy-verdict-cache": () => join(root, "policy-verdict-cache.sqlite3"),
      "governor-state": () => join(root, "governor-state.sqlite3"),
      "ranked-candidates": () => join(root, "ranked-candidates.sqlite3"),
      "replay-snapshot": () => join(root, "replay-snapshot.sqlite3"),
      "deny-hook-synthesis": () => join(root, "deny-hook-synthesis.sqlite3"),
      "worktree-allocator": () => join(root, "worktree-allocator.sqlite3"),
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
      "portfolio-queue": () => join(root, "portfolio-queue.sqlite3"),
      "run-state": () => join(root, "run-state.sqlite3"),
      "contribution-profile-cache": () => join(root, "contribution-profile-cache.sqlite3"),
      "policy-verdict-cache": () => join(root, "policy-verdict-cache.sqlite3"),
      "governor-state": () => join(root, "governor-state.sqlite3"),
      "ranked-candidates": () => join(root, "ranked-candidates.sqlite3"),
      "replay-snapshot": () => join(root, "replay-snapshot.sqlite3"),
      "deny-hook-synthesis": () => join(root, "deny-hook-synthesis.sqlite3"),
      "worktree-allocator": () => join(root, "worktree-allocator.sqlite3"),
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

  it("emits the {ok:false,error} JSON envelope for an argument error when --json is passed (#5915)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runPurge(["--json"])).toBe(2);
    expect(error).not.toHaveBeenCalled();
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Usage: loopover-miner purge") });
  });

  it("opens the real default on-disk stores in dry-run when no resolveDbPaths override is supplied", () => {
    const root = tempDir();
    const previousDirs: Record<string, string | undefined> = {
      LOOPOVER_MINER_CLAIM_LEDGER_DB: process.env.LOOPOVER_MINER_CLAIM_LEDGER_DB,
      LOOPOVER_MINER_EVENT_LEDGER_DB: process.env.LOOPOVER_MINER_EVENT_LEDGER_DB,
      LOOPOVER_MINER_GOVERNOR_LEDGER_DB: process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB,
      LOOPOVER_MINER_PREDICTION_LEDGER_DB: process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB,
      LOOPOVER_MINER_PORTFOLIO_QUEUE_DB: process.env.LOOPOVER_MINER_PORTFOLIO_QUEUE_DB,
      LOOPOVER_MINER_RUN_STATE_DB: process.env.LOOPOVER_MINER_RUN_STATE_DB,
      LOOPOVER_MINER_CONTRIBUTION_PROFILE_CACHE_DB: process.env.LOOPOVER_MINER_CONTRIBUTION_PROFILE_CACHE_DB,
      LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB: process.env.LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB,
      LOOPOVER_MINER_GOVERNOR_STATE_DB: process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB,
      LOOPOVER_MINER_RANKED_CANDIDATES_DB: process.env.LOOPOVER_MINER_RANKED_CANDIDATES_DB,
      LOOPOVER_MINER_REPLAY_SNAPSHOT_DB: process.env.LOOPOVER_MINER_REPLAY_SNAPSHOT_DB,
      LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB: process.env.LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB,
      LOOPOVER_MINER_WORKTREE_ALLOCATOR_DB: process.env.LOOPOVER_MINER_WORKTREE_ALLOCATOR_DB,
      LOOPOVER_MINER_ATTEMPT_LOG_DB: process.env.LOOPOVER_MINER_ATTEMPT_LOG_DB,
    };
    process.env.LOOPOVER_MINER_CLAIM_LEDGER_DB = join(root, "claim-ledger.sqlite3");
    process.env.LOOPOVER_MINER_EVENT_LEDGER_DB = join(root, "event-ledger.sqlite3");
    process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB = join(root, "governor-ledger.sqlite3");
    process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB = join(root, "prediction-ledger.sqlite3");
    process.env.LOOPOVER_MINER_PORTFOLIO_QUEUE_DB = join(root, "portfolio-queue.sqlite3");
    process.env.LOOPOVER_MINER_RUN_STATE_DB = join(root, "run-state.sqlite3");
    process.env.LOOPOVER_MINER_CONTRIBUTION_PROFILE_CACHE_DB = join(root, "contribution-profile-cache.sqlite3");
    process.env.LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB = join(root, "policy-verdict-cache.sqlite3");
    process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB = join(root, "governor-state.sqlite3");
    process.env.LOOPOVER_MINER_RANKED_CANDIDATES_DB = join(root, "ranked-candidates.sqlite3");
    process.env.LOOPOVER_MINER_REPLAY_SNAPSHOT_DB = join(root, "replay-snapshot.sqlite3");
    process.env.LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB = join(root, "deny-hook-synthesis.sqlite3");
    process.env.LOOPOVER_MINER_WORKTREE_ALLOCATOR_DB = join(root, "worktree-allocator.sqlite3");
    process.env.LOOPOVER_MINER_ATTEMPT_LOG_DB = join(root, "attempt-log.sqlite3");
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(runPurge(["--repo", "acme/widgets", "--dry-run", "--json"])).toBe(0);
      const result = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(result.stores).toHaveLength(13);
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

describe("runPurge (real, #5564, #6599)", () => {
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
    const portfolio = fakeStore(4);
    const runState = fakeStore(1);
    const cache = fakeStore(1);
    const governorState = fakeStore(4); // its purgeByRepo already sums both repo-scoped tables
    const options = {
      openClaimLedger: () => claim,
      initEventLedger: () => event,
      initGovernorLedger: () => governor,
      initPredictionLedger: () => prediction,
      initPortfolioQueueStore: () => portfolio,
      initRunStateStore: () => runState,
      initContributionProfileCache: () => cache,
      openGovernorState: () => governorState,
      initPolicyVerdictCacheStore: () => fakeStore(0),
      initRankedCandidatesStore: () => fakeStore(0),
      openReplaySnapshotStore: () => fakeStore(0),
      initDenyHookSynthesisStore: () => fakeStore(0),
      openWorktreeAllocator: () => fakeStore(0),
    };

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runPurge(["--repo", "acme/widgets", "--json"], options as never)).toBe(0);
    const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(summary).toMatchObject({
      outcome: "purged",
      repoFullName: "acme/widgets",
      totalPurged: 16,
      stores: [
        { store: "claim-ledger", purged: 2 },
        { store: "event-ledger", purged: 1 },
        { store: "governor-ledger", purged: 0 },
        { store: "prediction-ledger", purged: 3 },
        { store: "portfolio-queue", purged: 4 },
        { store: "run-state", purged: 1 },
        { store: "contribution-profile-cache", purged: 1 },
        { store: "governor-state", purged: 4 },
        { store: "policy-verdict-cache", purged: 0 },
        { store: "ranked-candidates", purged: 0 },
        { store: "replay-snapshot", purged: 0 },
        { store: "deny-hook-synthesis", purged: 0 },
        { store: "worktree-allocator", purged: 0 },
        { store: "attempt-log", purged: null, note: ATTEMPT_LOG_NOT_PURGEABLE_NOTE },
      ],
    });
    expect(typeof summary.purgedAt).toBe("string");
    for (const store of [claim, event, governor, prediction, portfolio, runState, cache, governorState]) {
      expect(store.purgeByRepo).toHaveBeenCalledWith("acme/widgets");
    }
    // Injected stores are caller-owned: runPurge must not close them.
    for (const store of [claim, event, governor, prediction, portfolio, runState, cache, governorState]) {
      expect(store.close).not.toHaveBeenCalled();
    }

    log.mockClear();
    expect(runPurge(["--repo", "acme/widgets"], options as never)).toBe(0);
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("Purged 16 row(s) for acme/widgets");
    expect(text).toContain("claim-ledger=2");
    expect(text).toContain("portfolio-queue=4");
    expect(text).toContain("run-state=1");
    expect(text).toContain(ATTEMPT_LOG_NOT_PURGEABLE_NOTE);
  });

  it("is audit-observable on a PARTIAL failure: reports what succeeded, flags the failed store, and exits 2", () => {
    const claim = fakeStore(2);
    const event = fakeStore(1);
    const governorOpenError = new Error("governor-ledger disk full");
    const prediction = fakeStore(3);
    const portfolio = fakeStore(0);
    const runState = fakeStore(0);
    const options = {
      openClaimLedger: () => claim,
      initEventLedger: () => event,
      initGovernorLedger: () => {
        throw governorOpenError;
      },
      initPredictionLedger: () => prediction,
      initPortfolioQueueStore: () => portfolio,
      initRunStateStore: () => runState,
      initContributionProfileCache: () => fakeStore(0),
      openGovernorState: () => fakeStore(0),
      initPolicyVerdictCacheStore: () => fakeStore(0),
      initRankedCandidatesStore: () => fakeStore(0),
      openReplaySnapshotStore: () => fakeStore(0),
      initDenyHookSynthesisStore: () => fakeStore(0),
      openWorktreeAllocator: () => fakeStore(0),
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
    expect(summary.stores).toContainEqual({ store: "portfolio-queue", purged: 0 });
    expect(summary.stores).toContainEqual({ store: "run-state", purged: 0 });
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
      initPortfolioQueueStore: () => fakeStore(0),
      initRunStateStore: () => fakeStore(0),
      initContributionProfileCache: () => fakeStore(0),
      openGovernorState: () => fakeStore(0),
      initPolicyVerdictCacheStore: () => fakeStore(0),
      initRankedCandidatesStore: () => fakeStore(0),
      openReplaySnapshotStore: () => fakeStore(0),
      initDenyHookSynthesisStore: () => fakeStore(0),
      openWorktreeAllocator: () => fakeStore(0),
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
      initPortfolioQueueStore: () => fakeStore(0),
      initRunStateStore: () => fakeStore(0),
      initContributionProfileCache: () => fakeStore(0),
      openGovernorState: () => fakeStore(0),
      initPolicyVerdictCacheStore: () => fakeStore(0),
      initRankedCandidatesStore: () => fakeStore(0),
      openReplaySnapshotStore: () => fakeStore(0),
      initDenyHookSynthesisStore: () => fakeStore(0),
      openWorktreeAllocator: () => fakeStore(0),
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
      LOOPOVER_MINER_PORTFOLIO_QUEUE_DB: process.env.LOOPOVER_MINER_PORTFOLIO_QUEUE_DB,
      LOOPOVER_MINER_RUN_STATE_DB: process.env.LOOPOVER_MINER_RUN_STATE_DB,
      LOOPOVER_MINER_CONTRIBUTION_PROFILE_CACHE_DB: process.env.LOOPOVER_MINER_CONTRIBUTION_PROFILE_CACHE_DB,
      LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB: process.env.LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB,
      LOOPOVER_MINER_GOVERNOR_STATE_DB: process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB,
      LOOPOVER_MINER_RANKED_CANDIDATES_DB: process.env.LOOPOVER_MINER_RANKED_CANDIDATES_DB,
      LOOPOVER_MINER_REPLAY_SNAPSHOT_DB: process.env.LOOPOVER_MINER_REPLAY_SNAPSHOT_DB,
      LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB: process.env.LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB,
      LOOPOVER_MINER_WORKTREE_ALLOCATOR_DB: process.env.LOOPOVER_MINER_WORKTREE_ALLOCATOR_DB,
      LOOPOVER_MINER_WORKTREE_DIR: process.env.LOOPOVER_MINER_WORKTREE_DIR,
    };
    const claimDbPath = join(root, "claim-ledger.sqlite3");
    const portfolioDbPath = join(root, "portfolio-queue.sqlite3");
    const runStateDbPath = join(root, "run-state.sqlite3");
    process.env.LOOPOVER_MINER_CLAIM_LEDGER_DB = claimDbPath;
    process.env.LOOPOVER_MINER_EVENT_LEDGER_DB = join(root, "event-ledger.sqlite3");
    process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB = join(root, "governor-ledger.sqlite3");
    process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB = join(root, "prediction-ledger.sqlite3");
    process.env.LOOPOVER_MINER_PORTFOLIO_QUEUE_DB = portfolioDbPath;
    process.env.LOOPOVER_MINER_RUN_STATE_DB = runStateDbPath;
    process.env.LOOPOVER_MINER_CONTRIBUTION_PROFILE_CACHE_DB = join(root, "contribution-profile-cache.sqlite3");
    process.env.LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB = join(root, "policy-verdict-cache.sqlite3");
    process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB = join(root, "governor-state.sqlite3");
    process.env.LOOPOVER_MINER_RANKED_CANDIDATES_DB = join(root, "ranked-candidates.sqlite3");
    process.env.LOOPOVER_MINER_REPLAY_SNAPSHOT_DB = join(root, "replay-snapshot.sqlite3");
    process.env.LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB = join(root, "deny-hook-synthesis.sqlite3");
    process.env.LOOPOVER_MINER_WORKTREE_ALLOCATOR_DB = join(root, "worktree-allocator.sqlite3");
    process.env.LOOPOVER_MINER_WORKTREE_DIR = join(root, "worktrees");
    try {
      // Seed real rows via the default store paths before purging through them.
      const seededClaim = openClaimLedger(claimDbPath);
      seededClaim.claimIssue("acme/widgets", 1);
      seededClaim.close();
      const seededPortfolio = initPortfolioQueueStore(portfolioDbPath);
      seededPortfolio.enqueue({ repoFullName: "acme/widgets", identifier: "issue-1" });
      seededPortfolio.close();
      const seededRunState = initRunStateStore(runStateDbPath);
      seededRunState.setRunState("acme/widgets", "planning");
      seededRunState.close();

      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(runPurge(["--repo", "acme/widgets", "--json"])).toBe(0);
      const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(summary.stores.find((entry: { store: string }) => entry.store === "claim-ledger")).toMatchObject({
        purged: 1,
      });
      expect(summary.stores.find((entry: { store: string }) => entry.store === "portfolio-queue")).toMatchObject({
        purged: 1,
      });
      expect(summary.stores.find((entry: { store: string }) => entry.store === "run-state")).toMatchObject({
        purged: 1,
      });

      // Reopening confirms the purge was actually persisted through the default (owned, closed) code path.
      const reopenedClaim = openClaimLedger(claimDbPath);
      closeables.push(reopenedClaim);
      expect(reopenedClaim.listClaims()).toEqual([]);
      const reopenedPortfolio = initPortfolioQueueStore(portfolioDbPath);
      closeables.push(reopenedPortfolio);
      expect(reopenedPortfolio.listQueue()).toEqual([]);
      const reopenedRunState = initRunStateStore(runStateDbPath);
      closeables.push(reopenedRunState);
      expect(reopenedRunState.listRunStates()).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(previousDirs)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("REGRESSION (#6599): dry-run and real purge both report portfolio-queue and run-state in per-store output", () => {
    const root = tempDir();
    const portfolioDbPath = join(root, "portfolio-queue.sqlite3");
    const runStateDbPath = join(root, "run-state.sqlite3");

    const portfolio = initPortfolioQueueStore(portfolioDbPath);
    portfolio.enqueue({ repoFullName: "acme/widgets", identifier: "a" });
    portfolio.enqueue({ repoFullName: "acme/widgets", identifier: "b" });
    portfolio.close();

    const runState = initRunStateStore(runStateDbPath);
    runState.setRunState("acme/widgets", "discovering");
    runState.close();

    const resolveDbPaths = {
      "claim-ledger": () => join(root, "claim-ledger.sqlite3"),
      "event-ledger": () => join(root, "event-ledger.sqlite3"),
      "governor-ledger": () => join(root, "governor-ledger.sqlite3"),
      "prediction-ledger": () => join(root, "prediction-ledger.sqlite3"),
      "portfolio-queue": () => portfolioDbPath,
      "run-state": () => runStateDbPath,
      "contribution-profile-cache": () => join(root, "contribution-profile-cache.sqlite3"),
      "policy-verdict-cache": () => join(root, "policy-verdict-cache.sqlite3"),
      "governor-state": () => join(root, "governor-state.sqlite3"),
      "ranked-candidates": () => join(root, "ranked-candidates.sqlite3"),
      "replay-snapshot": () => join(root, "replay-snapshot.sqlite3"),
      "deny-hook-synthesis": () => join(root, "deny-hook-synthesis.sqlite3"),
      "worktree-allocator": () => join(root, "worktree-allocator.sqlite3"),
      "attempt-log": () => join(root, "attempt-log.sqlite3"),
    };

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runPurge(["--repo", "acme/widgets", "--dry-run", "--json"], { resolveDbPaths })).toBe(0);
    const dryRun = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(dryRun.stores).toContainEqual({ store: "portfolio-queue", wouldPurge: 2 });
    expect(dryRun.stores).toContainEqual({ store: "run-state", wouldPurge: 1 });

    log.mockClear();
    const portfolioStore = initPortfolioQueueStore(portfolioDbPath);
    const runStateStore = initRunStateStore(runStateDbPath);
    closeables.push(portfolioStore, runStateStore);
    expect(
      runPurge(["--repo", "acme/widgets", "--json"], {
        openClaimLedger: () => fakeStore(0),
        initEventLedger: () => fakeStore(0),
        initGovernorLedger: () => fakeStore(0),
        initPredictionLedger: () => fakeStore(0),
        initPortfolioQueueStore: () => portfolioStore,
        initRunStateStore: () => runStateStore,
        initContributionProfileCache: () => fakeStore(0),
        openGovernorState: () => fakeStore(0),
        initPolicyVerdictCacheStore: () => fakeStore(0),
      initRankedCandidatesStore: () => fakeStore(0),
      openReplaySnapshotStore: () => fakeStore(0),
      initDenyHookSynthesisStore: () => fakeStore(0),
      openWorktreeAllocator: () => fakeStore(0),
      } as never),
    ).toBe(0);
    const purged = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(purged.stores).toContainEqual({ store: "portfolio-queue", purged: 2 });
    expect(purged.stores).toContainEqual({ store: "run-state", purged: 1 });
    expect(portfolioStore.listQueue()).toEqual([]);
    expect(runStateStore.listRunStates()).toEqual([]);
  });

  it("REGRESSION (#7091): really deletes contribution-profile-cache + BOTH governor tables across api_base_urls, leaving other repos and the whole-run scalar row intact", () => {
    const root = tempDir();
    const cacheDbPath = join(root, "contribution-profile-cache.sqlite3");
    const governorStateDbPath = join(root, "governor-state.sqlite3");

    const seededCache = initContributionProfileCache(cacheDbPath);
    seededCache.put(emptyContributionProfile("acme/widgets", "2026-07-17T00:00:00.000Z"));
    seededCache.put(emptyContributionProfile("acme/other", "2026-07-17T00:00:00.000Z"));
    seededCache.close();

    const seededGovernor = openGovernorState(governorStateDbPath);
    // acme/widgets recorded under TWO forge hosts -- both must be swept, since the purge filters on
    // repo_full_name alone (the api_base_url half of the composite key is ignored).
    seededGovernor.saveReputationHistory("acme/widgets", { decided: 5, unfavorable: 2 }, "https://api.github.com");
    seededGovernor.saveReputationHistory("acme/widgets", { decided: 3, unfavorable: 1 }, "https://gitlab.example/api");
    seededGovernor.saveReputationHistory("acme/other", { decided: 1, unfavorable: 0 });
    seededGovernor.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "fp-1" });
    seededGovernor.recordOwnSubmission({ repoFullName: "acme/other", fingerprint: "fp-2" });
    seededGovernor.savePauseState({ paused: true, reason: "maintenance" }); // scalar row -- must survive the purge
    seededGovernor.close();

    // Inject the real openers against the seeded files (caller-owned, so we close them ourselves afterward).
    const cacheStore = initContributionProfileCache(cacheDbPath);
    const governorStore = openGovernorState(governorStateDbPath);
    closeables.push(cacheStore, governorStore);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runPurge(["--repo", "acme/widgets", "--json"], {
        openClaimLedger: () => fakeStore(0),
        initEventLedger: () => fakeStore(0),
        initGovernorLedger: () => fakeStore(0),
        initPredictionLedger: () => fakeStore(0),
        initPortfolioQueueStore: () => fakeStore(0),
        initRunStateStore: () => fakeStore(0),
        initContributionProfileCache: () => cacheStore,
        openGovernorState: () => governorStore,
        initPolicyVerdictCacheStore: () => fakeStore(0),
      initRankedCandidatesStore: () => fakeStore(0),
      openReplaySnapshotStore: () => fakeStore(0),
      initDenyHookSynthesisStore: () => fakeStore(0),
      openWorktreeAllocator: () => fakeStore(0),
      } as never),
    ).toBe(0);
    const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(summary.stores).toContainEqual({ store: "contribution-profile-cache", purged: 1 });
    // governor-state sums both repo-scoped tables for acme/widgets: 2 reputation rows + 1 own submission = 3.
    expect(summary.stores).toContainEqual({ store: "governor-state", purged: 3 });

    // acme/widgets is gone from every purged table across both forge hosts...
    expect(cacheStore.get("acme/widgets")).toBeNull();
    expect(governorStore.loadReputationHistory("acme/widgets", "https://api.github.com")).toEqual({ decided: 0, unfavorable: 0 });
    expect(governorStore.loadReputationHistory("acme/widgets", "https://gitlab.example/api")).toEqual({ decided: 0, unfavorable: 0 });
    expect(governorStore.listRecentOwnSubmissions({ repoFullName: "acme/widgets" })).toEqual([]);
    // ...while another repo's rows and the non-repo-scoped scalar pause row are untouched.
    expect(cacheStore.get("acme/other")).not.toBeNull();
    expect(governorStore.loadReputationHistory("acme/other")).toEqual({ decided: 1, unfavorable: 0 });
    expect(governorStore.listRecentOwnSubmissions({ repoFullName: "acme/other" })).toHaveLength(1);
    expect(governorStore.loadPauseState()).toMatchObject({ paused: true, reason: "maintenance" });
  });

  it("REGRESSION (#6987): really deletes policy-verdict-cache rows for the repo, leaving other repos intact", () => {
    const root = tempDir();
    const policyDbPath = join(root, "policy-verdict-cache.sqlite3");

    const seeded = initPolicyVerdictCacheStore(policyDbPath);
    seeded.put("acme/widgets", "AI-USAGE.md", '"v1"', POLICY_VERDICT);
    seeded.put("acme/other", "AI-USAGE.md", '"v2"', POLICY_VERDICT);
    seeded.close();

    const policyStore = initPolicyVerdictCacheStore(policyDbPath);
    closeables.push(policyStore);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runPurge(["--repo", "acme/widgets", "--json"], {
        openClaimLedger: () => fakeStore(0),
        initEventLedger: () => fakeStore(0),
        initGovernorLedger: () => fakeStore(0),
        initPredictionLedger: () => fakeStore(0),
        initPortfolioQueueStore: () => fakeStore(0),
        initRunStateStore: () => fakeStore(0),
        initContributionProfileCache: () => fakeStore(0),
        openGovernorState: () => fakeStore(0),
        initPolicyVerdictCacheStore: () => policyStore,
      initRankedCandidatesStore: () => fakeStore(0),
      openReplaySnapshotStore: () => fakeStore(0),
      initDenyHookSynthesisStore: () => fakeStore(0),
      openWorktreeAllocator: () => fakeStore(0),
      } as never),
    ).toBe(0);
    const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(summary.stores).toContainEqual({ store: "policy-verdict-cache", purged: 1 });
    expect(policyStore.get("acme/widgets")).toBeNull();
    expect(policyStore.get("acme/other")).not.toBeNull();
  });

  it("REGRESSION (#8009): really deletes ranked-candidates, replay-snapshot, and deny-hook-synthesis rows across api_base_urls, leaving other repos intact", () => {
    const root = tempDir();
    const rankedDbPath = join(root, "ranked-candidates.sqlite3");
    const replayDbPath = join(root, "replay-snapshot.sqlite3");
    const denyDbPath = join(root, "deny-hook-synthesis.sqlite3");
    const history = [
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
    ];

    const seededRanked = initRankedCandidatesStore(rankedDbPath);
    seededRanked.saveRankedCandidates([
      { repoFullName: "acme/widgets", issueNumber: 1, rankScore: 0.9 },
      { repoFullName: "acme/other", issueNumber: 2, rankScore: 0.5 },
    ]);
    seededRanked.close();

    const seededReplay = openReplaySnapshotStore(replayDbPath);
    for (const [repoFullName, commitSha] of [["acme/widgets", "abc123"], ["acme/other", "def456"]] as const) {
      seededReplay.saveSnapshot({
        repoFullName,
        commitSha,
        worktreePath: `/repo/.loopover-replay-snapshots/${commitSha}`,
        targetDate: "2026-01-05T00:00:00+00:00",
        commits: [{ sha: commitSha, date: "2026-01-05T00:00:00+00:00", subject: "t" }],
        tags: [],
        readme: null,
      });
    }
    seededReplay.close();

    // acme/widgets proposals recorded under TWO forge hosts -- both must be swept, since the purge filters on
    // repo_full_name alone (the api_base_url half of the composite key is ignored), like governor-state's.
    const seededDeny = initDenyHookSynthesisStore(denyDbPath);
    seededDeny.refreshProposals("acme/widgets", history, {}, "https://api.github.com");
    seededDeny.refreshProposals("acme/widgets", history, {}, "https://gitlab.example/api");
    seededDeny.refreshProposals("acme/other", history);
    seededDeny.close();

    // Inject the real openers against the seeded files (caller-owned, so we close them ourselves afterward).
    const rankedStore = initRankedCandidatesStore(rankedDbPath);
    const replayStore = openReplaySnapshotStore(replayDbPath);
    const denyStore = initDenyHookSynthesisStore(denyDbPath);
    closeables.push(rankedStore, replayStore, denyStore);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runPurge(["--repo", "acme/widgets", "--json"], {
        openClaimLedger: () => fakeStore(0),
        initEventLedger: () => fakeStore(0),
        initGovernorLedger: () => fakeStore(0),
        initPredictionLedger: () => fakeStore(0),
        initPortfolioQueueStore: () => fakeStore(0),
        initRunStateStore: () => fakeStore(0),
        initContributionProfileCache: () => fakeStore(0),
        openGovernorState: () => fakeStore(0),
        initPolicyVerdictCacheStore: () => fakeStore(0),
        initRankedCandidatesStore: () => rankedStore,
        openReplaySnapshotStore: () => replayStore,
        initDenyHookSynthesisStore: () => denyStore,
        openWorktreeAllocator: () => fakeStore(0),
      } as never),
    ).toBe(0);
    const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(summary.stores).toContainEqual({ store: "ranked-candidates", purged: 1 });
    expect(summary.stores).toContainEqual({ store: "replay-snapshot", purged: 1 });
    // deny-hook-synthesis sweeps the repo's rows under BOTH forge hosts: one proposal each = 2.
    expect(summary.stores).toContainEqual({ store: "deny-hook-synthesis", purged: 2 });

    // acme/widgets is gone from every purged table across both forge hosts...
    expect(rankedStore.listRankedCandidates().map((row) => row.repoFullName)).toEqual(["acme/other"]);
    expect(replayStore.getSnapshot("acme/widgets", "abc123")).toBeNull();
    expect(denyStore.listProposals("acme/widgets", "https://api.github.com")).toEqual([]);
    expect(denyStore.listProposals("acme/widgets", "https://gitlab.example/api")).toEqual([]);
    // ...while another repo's rows are untouched.
    expect(replayStore.getSnapshot("acme/other", "def456")).not.toBeNull();
    expect(denyStore.listProposals("acme/other")).toHaveLength(1);
  });
});
