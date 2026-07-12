import type { CodingAgentExecutionMode, FeasibilityVerdict, LocalWriteActionSpec } from "@jsonbored/gittensory-engine";
import type { AttemptDeps, AttemptResult as RunMinerAttemptResult, runMinerAttempt } from "./attempt-runner.js";
import type { ClaimLedger } from "./claim-ledger.js";
import type { EventLedger } from "./event-ledger.js";
import type { AttemptLog } from "./attempt-log.js";
import type { GovernorLedger } from "./governor-ledger.js";
import type { WorktreeAllocator } from "./worktree-allocator.js";
import type { resolveRejectionSignaled } from "./rejection-signal.js";
import type { SelfReviewContextFetch, fetchSelfReviewContext } from "./self-review-context.js";
import type { cleanupAttemptWorktree, prepareAttemptWorktree } from "./attempt-worktree.js";
import type { buildCodingTaskSpec } from "./coding-task-spec.js";
import type { resolveAmsPolicy } from "./ams-policy.js";
import type { checkMinerKillSwitch } from "./governor-kill-switch.js";
import type { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import type { ClaimConflictResult, resolveClaimConflict } from "./claim-conflict-resolver.js";

type CommonAttemptResultFields = {
  repoFullName: string;
  issueNumber: number;
  minerLogin: string;
  base: string;
  mode: CodingAgentExecutionMode;
  attemptId: string;
};

/** The result runAttempt reports at every real return point, threaded to `options.onResult` (in addition to
 *  the plain exit-code return runAttempt itself still returns, unchanged, so bin/gittensory-miner.js's own
 *  `process.exit(exitCode)` usage never breaks) -- the loop orchestrator's real caller for this data. */
export type AttemptCliResult =
  | (CommonAttemptResultFields & { outcome: "blocked_rejection_signaled"; reason: string })
  | (CommonAttemptResultFields & { outcome: "blocked_worktree_preparation_failed"; reason: string })
  | (CommonAttemptResultFields & {
      outcome: "blocked_infeasible";
      reason: string;
      verdict: FeasibilityVerdict;
      avoidReasons: string[];
      raiseReasons: string[];
    })
  | (CommonAttemptResultFields & {
      outcome: `attempt_${RunMinerAttemptResult["outcome"]}`;
      submissionMode: "observe" | "enforce";
      totalTurnsUsed: number;
      totalCostUsd: number;
      iterationsUsed: number;
      reason?: string;
      decision?: unknown;
      spec?: LocalWriteActionSpec;
      execResult?: unknown;
      claimConflict?: ClaimConflictResult;
    });

export type ParsedAttemptArgs =
  | { error: string }
  | { repoFullName: string; issueNumber: number; minerLogin: string; base: string; live: boolean; json: boolean };

export function parseAttemptArgs(args: string[]): ParsedAttemptArgs;

export function buildAttemptDeps(
  env: Record<string, string | undefined>,
  ledgers: { claimLedger: ClaimLedger; eventLedger: EventLedger; attemptLog: AttemptLog; governorLedger: GovernorLedger; nowMs: number },
): AttemptDeps;

export type RunAttemptOptions = {
  env?: Record<string, string | undefined>;
  nowMs?: number;
  attemptId?: string;
  resolveCodingAgentModeFromConfig?: (config: { env?: Record<string, string | undefined> }) => CodingAgentExecutionMode;
  openWorktreeAllocator?: () => WorktreeAllocator;
  openClaimLedger?: () => ClaimLedger;
  initEventLedger?: () => EventLedger;
  initAttemptLog?: () => AttemptLog;
  initGovernorLedger?: () => GovernorLedger;
  buildAttemptDeps?: typeof buildAttemptDeps;
  resolveRejectionSignaled?: typeof resolveRejectionSignaled;
  fetchImpl?: SelfReviewContextFetch;
  prepareAttemptWorktree?: typeof prepareAttemptWorktree;
  cleanupAttemptWorktree?: typeof cleanupAttemptWorktree;
  fetchSelfReviewContext?: typeof fetchSelfReviewContext;
  buildCodingTaskSpec?: typeof buildCodingTaskSpec;
  resolveAmsPolicy?: typeof resolveAmsPolicy;
  checkMinerKillSwitch?: typeof checkMinerKillSwitch;
  resolveMinerGoalSpec?: typeof resolveMinerGoalSpec;
  runMinerAttempt?: typeof runMinerAttempt;
  resolveClaimConflict?: typeof resolveClaimConflict;
  /** Invoked with the real structured result at every return point, in addition to (never instead of) the
   *  plain exit-code return -- the loop orchestrator's real hook into what actually happened. */
  onResult?: (result: AttemptCliResult) => void;
};

export function runAttempt(args: string[], options?: RunAttemptOptions): Promise<number>;
