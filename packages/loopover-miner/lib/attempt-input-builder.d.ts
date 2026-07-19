import type { AmsPolicySpec, CodingAgentExecutionMode, IterateLoopInput, PortfolioConvergenceInput, RepoOutcomeHistory, SelfReviewContext } from "@loopover/engine";
import type { AttemptGovernorContext } from "./attempt-runner.js";
import type { CodingTaskSpecResult } from "./coding-task-spec.js";
/**
 * Assemble the real Governor chokepoint context for one attempt. rateLimitBuckets/rateLimitBackoffAttempts/
 * capUsage are deliberately omitted -- evaluateGovernorChokepointGatePersisted (#5134) auto-loads them from
 * the persisted governor-state store when absent.
 *
 * `repoPaused` (#5392) is the caller's own resolved `MinerGoalSpec.killSwitch.paused` for the target repo
 * (miner-goal-spec.js's resolveMinerGoalSpec) -- this composer stays pure and just threads whatever the
 * caller already resolved through; passing nothing keeps the prior fails-open-on-that-axis-only behavior.
 *
 * `convergenceInput` (#5654) is the caller's own real portfolio-queue.js `getAttemptHistory` read -- this
 * composer stays pure and just threads it through, same as `repoPaused`. Omitted (never fabricated) falls
 * back to the honest first-attempt-shaped zero-state, so a caller that hasn't wired a real read yet (or an
 * item genuinely absent from the queue) still produces a well-formed `PortfolioConvergenceInput`.
 *
 * `reputationHistory` (#5675) is the caller's own real governor-state.js `loadReputationHistory` read for the
 * target repo. Optional and threaded through unchanged: when omitted the field is left off entirely, which
 * chokepoint.ts treats as "skip the self-reputation throttle" -- an honest absence, never a fabricated clean
 * history.
 */
export declare function buildAttemptGovernorContext(env: Record<string, string | undefined>, amsPolicySpec: AmsPolicySpec, repoPaused?: boolean, convergenceInput?: PortfolioConvergenceInput, reputationHistory?: RepoOutcomeHistory): AttemptGovernorContext;
export type BuildAttemptLoopInputInput = {
    codingTaskSpec: Extract<CodingTaskSpecResult, {
        ready: true;
    }>;
    reviewContext: SelfReviewContext;
    worktreePath: string;
    attemptId: string;
    mode: CodingAgentExecutionMode;
    repoFullName: string;
    minerLogin: string;
    rejectionSignaled: boolean;
    amsPolicySpec: AmsPolicySpec;
    branchRef?: string;
};
/**
 * Assemble the real IterateLoopInput for one attempt from every already-computed real dependency. Pure --
 * throws nothing itself (callers are expected to have already validated `codingTaskSpec.ready`).
 */
export declare function buildAttemptLoopInput(input: BuildAttemptLoopInputInput): IterateLoopInput;
