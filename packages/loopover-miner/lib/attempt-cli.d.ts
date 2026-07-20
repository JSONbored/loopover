import type { CodingAgentExecutionMode, FeasibilityVerdict, LocalWriteActionSpec } from "@loopover/engine";
import type { ClaimLedger } from "./claim-ledger.js";
import type { ClaimConflictResult, resolveClaimConflict as ResolveClaimConflictFn } from "./claim-conflict-resolver.js";
import type { EventLedger } from "./event-ledger.js";
import type { AttemptLog } from "./attempt-log.js";
import type { GovernorLedger } from "./governor-ledger.js";
import type { WorktreeAllocator } from "./worktree-allocator.js";
import type { resolveRejectionSignaled as ResolveRejectionSignaledFn } from "./rejection-signal.js";
import type { cleanupAttemptWorktree as CleanupAttemptWorktreeFn, prepareAttemptWorktree as PrepareAttemptWorktreeFn } from "./attempt-worktree.js";
import type { SelfReviewContextFetch, fetchSelfReviewContext as FetchSelfReviewContextFn } from "./self-review-context.js";
import type { buildCodingTaskSpec as BuildCodingTaskSpecFn } from "./coding-task-spec.js";
import type { resolveAmsPolicy as ResolveAmsPolicyFn } from "./ams-policy.js";
import type { checkMinerKillSwitch as CheckMinerKillSwitchFn } from "./governor-kill-switch.js";
import type { getAttemptHistory as GetAttemptHistoryFn } from "./portfolio-queue.js";
import type { recordOwnSubmission as RecordOwnSubmissionFn } from "./governor-state.js";
import type { AttemptDeps, AttemptResult as RunMinerAttemptResult, runMinerAttempt as RunMinerAttemptFn } from "./attempt-runner.js";
import type { submitSoftClaim as SubmitSoftClaimFn } from "./discovery-index-client.js";
import type { resolveMinerGoalSpec as ResolveMinerGoalSpecFn } from "./miner-goal-spec.js";
type CommonAttemptResultFields = {
    repoFullName: string;
    issueNumber: number;
    minerLogin: string;
    base: string;
    mode: CodingAgentExecutionMode;
    attemptId: string;
};
/** The result runAttempt reports at every real return point, threaded to `options.onResult` (in addition to
 *  the plain exit-code return runAttempt itself still returns, unchanged, so bin/loopover-miner.js's own
 *  `process.exit(exitCode)` usage never breaks) -- the loop orchestrator's real caller for this data. */
export type AttemptCliResult = (CommonAttemptResultFields & {
    outcome: "dry_run";
}) | (CommonAttemptResultFields & {
    outcome: "blocked_rejection_signaled";
    reason: string;
}) | (CommonAttemptResultFields & {
    outcome: "blocked_worktree_preparation_failed";
    reason: string;
}) | (CommonAttemptResultFields & {
    outcome: "blocked_infeasible";
    reason: string;
    verdict: FeasibilityVerdict;
    avoidReasons: string[];
    raiseReasons: string[];
}) | (CommonAttemptResultFields & {
    outcome: `attempt_${RunMinerAttemptResult["outcome"]}`;
    submissionMode: "observe" | "enforce";
    totalTurnsUsed: number;
    totalCostUsd: number;
    totalTokensUsed: number;
    iterationsUsed: number;
    reason?: string;
    decision?: unknown;
    spec?: LocalWriteActionSpec;
    execResult?: unknown;
    claimConflict?: ClaimConflictResult;
});
export type ParsedAttemptArgs = {
    error: string;
} | {
    repoFullName: string;
    issueNumber: number;
    minerLogin: string;
    base: string;
    live: boolean;
    dryRun: boolean;
    json: boolean;
};
export type RunAttemptOptions = {
    env?: Record<string, string | undefined>;
    nowMs?: number;
    attemptId?: string;
    resolveCodingAgentModeFromConfig?: (config: {
        env?: Record<string, string | undefined>;
    }) => CodingAgentExecutionMode;
    openWorktreeAllocator?: () => WorktreeAllocator;
    openClaimLedger?: () => ClaimLedger;
    initEventLedger?: () => EventLedger;
    initAttemptLog?: () => AttemptLog;
    initGovernorLedger?: () => GovernorLedger;
    buildAttemptDeps?: typeof buildAttemptDeps;
    resolveRejectionSignaled?: typeof ResolveRejectionSignaledFn;
    fetchImpl?: SelfReviewContextFetch;
    prepareAttemptWorktree?: typeof PrepareAttemptWorktreeFn;
    cleanupAttemptWorktree?: typeof CleanupAttemptWorktreeFn;
    fetchSelfReviewContext?: typeof FetchSelfReviewContextFn;
    buildCodingTaskSpec?: typeof BuildCodingTaskSpecFn;
    resolveAmsPolicy?: typeof ResolveAmsPolicyFn;
    checkMinerKillSwitch?: typeof CheckMinerKillSwitchFn;
    resolveMinerGoalSpec?: typeof ResolveMinerGoalSpecFn;
    runMinerAttempt?: typeof RunMinerAttemptFn;
    resolveClaimConflict?: typeof ResolveClaimConflictFn;
    recordOwnSubmission?: typeof RecordOwnSubmissionFn;
    getAttemptHistory?: typeof GetAttemptHistoryFn;
    /** Hosted soft-claim coordination at work-start/work-end, when the plane is enabled (#7168). Defaults to
     *  discovery-index-client.js's own submitSoftClaim. */
    submitSoftClaim?: typeof SubmitSoftClaimFn;
    /** Invoked with the real structured result at every return point, in addition to (never instead of) the
     *  plain exit-code return -- the loop orchestrator's real hook into what actually happened. */
    onResult?: (result: AttemptCliResult) => void;
};
export declare function parseAttemptArgs(args: string[]): ParsedAttemptArgs;
/**
 * Assemble a real AttemptDeps object: every field wired to a genuine implementation (the #5131 driver, the
 * #5133 slop assessor, the four real ledgers passed in, and the fetchLiveIssueSnapshot/executeLocalWrite
 * built alongside this file). Throws if the coding-agent driver is unconfigured (fails closed, matching
 * constructProductionCodingAgentDriver's own contract) -- callers should report that clearly rather than
 * silently falling back to a driver that could never run.
 */
export declare function buildAttemptDeps(env: Record<string, string | undefined>, ledgers: {
    claimLedger: ClaimLedger;
    eventLedger: EventLedger;
    attemptLog: AttemptLog;
    governorLedger: GovernorLedger;
    nowMs: number;
}): AttemptDeps;
/**
 * Run the `attempt` CLI subcommand end to end: resolveRejectionSignaled (before consuming a worktree slot) ->
 * acquire a concurrency slot -> assemble real AttemptDeps -> prepare a REAL git worktree -> fetch a real
 * SelfReviewContext -> build a real coding-task spec (blocks on an infeasible verdict) -> resolve the real
 * AmsPolicySpec execution policy -> assemble the real IterateLoopInput + Governor context -> call
 * runMinerAttempt for real. The worktree is cleaned up (or retained, per the real outcome) in `finally`.
 * See this file's header for the documented gaps (real convergence history).
 */
export declare function runAttempt(args: string[], options?: RunAttemptOptions): Promise<number>;
export {};
