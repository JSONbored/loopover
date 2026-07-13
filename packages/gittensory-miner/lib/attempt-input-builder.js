import { isGlobalMinerKillSwitch, isGlobalMinerLiveModeOptIn } from "@loopover/engine";

// Pure composers for runMinerAttempt's real input (#5132, Wave 3.5 -- the final assembly). Everything here is
// a plain in/out transform over already-fetched/already-computed real data (coding-task-spec, #5239;
// self-review-context, #5145; worktree preparation, #5237/#5252; AmsPolicySpec, #5249) -- no fetching, no IO,
// same discipline as coding-task-spec.js's own composers.
//
// KNOWN, DOCUMENTED GAPS (not fabricated -- explicitly left as real, narrow follow-ups):
//   - governor.convergenceInput is now a REAL per-issue query (#5654): the caller reads the portfolio-queue's
//     attempt-history columns (portfolio-queue.js's getAttemptHistory) and threads the resulting
//     PortfolioConvergenceInput in through this composer's `convergenceInput` parameter, so the already-built
//     non-convergence detector finally sees real attempt/reenqueue/failure counts instead of a permanent
//     first-attempt literal. This composer stays pure -- it just forwards whatever the caller resolved,
//     defaulting to the honest first-attempt shape ({ attempts: 0, ... }) when nothing is supplied (an item
//     the queue has never seen, which reads as a converging first-look, not a fabricated history).
//   - governor.reputationHistory/selfPlagiarismCandidate/selfPlagiarismRecentSubmissions are omitted, which
//     chokepoint.ts's own design treats as "skip that stage entirely" -- an honest absence, not a fabricated
//     "clean" verdict.

/**
 * Assemble the real Governor chokepoint context for one attempt. rateLimitBuckets/rateLimitBackoffAttempts/
 * capUsage are deliberately omitted -- evaluateGovernorChokepointGatePersisted (#5134) auto-loads them from
 * the persisted governor-state store when absent.
 *
 * `repoPaused` (#5392) is the caller's own resolved `MinerGoalSpec.killSwitch.paused` for the target repo
 * (miner-goal-spec.js's resolveMinerGoalSpec) -- this composer stays pure and just threads whatever the
 * caller already resolved through; passing nothing keeps the prior fails-open-on-that-axis-only behavior.
 *
 * `convergenceInput` (#5654) is the caller's already-resolved real per-issue attempt history (from
 * portfolio-queue.js's getAttemptHistory) -- this composer stays pure and just forwards it. Omitting it (an
 * item the queue has never seen) falls back to the honest first-attempt shape, which the non-convergence
 * detector reads as a converging first-look, not a fabricated history.
 *
 * @param {Record<string, string | undefined>} env
 * @param {import("@loopover/engine").AmsPolicySpec} amsPolicySpec
 * @param {boolean} [repoPaused]
 * @param {import("@loopover/engine").PortfolioConvergenceInput} [convergenceInput]
 * @returns {import("./attempt-runner.js").AttemptGovernorContext}
 */
export function buildAttemptGovernorContext(env, amsPolicySpec, repoPaused, convergenceInput) {
  return {
    killSwitchGlobal: isGlobalMinerKillSwitch(env),
    killSwitchRepoPaused: repoPaused,
    liveModeGlobalOptIn: isGlobalMinerLiveModeOptIn(env),
    capLimits: amsPolicySpec.capLimits,
    convergenceInput: convergenceInput ?? { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false },
  };
}

/**
 * Assemble the real IterateLoopInput for one attempt from every already-computed real dependency. Pure --
 * throws nothing itself (callers are expected to have already validated `codingTaskSpec.ready`).
 *
 * @param {{
 *   codingTaskSpec: Extract<import("./coding-task-spec.js").CodingTaskSpecResult, { ready: true }>,
 *   reviewContext: import("@loopover/engine").SelfReviewContext,
 *   worktreePath: string,
 *   attemptId: string,
 *   mode: import("@loopover/engine").CodingAgentExecutionMode,
 *   repoFullName: string,
 *   minerLogin: string,
 *   rejectionSignaled: boolean,
 *   amsPolicySpec: import("@loopover/engine").AmsPolicySpec,
 *   branchRef?: string,
 * }} input
 * @returns {import("@loopover/engine").IterateLoopInput}
 */
export function buildAttemptLoopInput(input) {
  return {
    attemptId: input.attemptId,
    workingDirectory: input.worktreePath,
    acceptanceCriteriaPath: input.codingTaskSpec.acceptanceCriteriaPath,
    instructions: input.codingTaskSpec.instructions,
    mode: input.mode,
    maxIterations: input.amsPolicySpec.maxIterations,
    maxTurnsPerIteration: input.amsPolicySpec.maxTurnsPerIteration,
    // Real mid-attempt budget (#5395): the SAME Governor cap ceilings that already bound cross-cycle spend
    // (loop-cli.js's after-the-fact governorState.saveCapUsage) now also bound this ONE attempt in progress,
    // via the engine's real accumulateAttemptUsage/evaluateAttemptBudget -- a runaway attempt can no longer
    // burn through the entire cross-cycle budget before anything reacts. No maxTokens: no driver reports a
    // real per-iteration token count today, so that axis has no real ceiling to set (never fabricated).
    budget: {
      maxTurns: input.amsPolicySpec.capLimits.turns,
      maxWallClockMs: input.amsPolicySpec.capLimits.elapsedMs,
      maxCostUsd: input.amsPolicySpec.capLimits.budget,
    },
    repoFullName: input.repoFullName,
    contributorLogin: input.minerLogin,
    title: input.codingTaskSpec.title,
    body: input.codingTaskSpec.body,
    labels: input.codingTaskSpec.labels,
    linkedIssues: input.codingTaskSpec.linkedIssues,
    branchRef: input.branchRef,
    reviewContext: input.reviewContext,
    rejectionSignaled: input.rejectionSignaled,
  };
}
