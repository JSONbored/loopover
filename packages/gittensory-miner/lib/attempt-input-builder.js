import { isGlobalMinerKillSwitch, isGlobalMinerLiveModeOptIn } from "@loopover/engine";

// Pure composers for runMinerAttempt's real input (#5132, Wave 3.5 -- the final assembly). Everything here is
// a plain in/out transform over already-fetched/already-computed real data (coding-task-spec, #5239;
// self-review-context, #5145; worktree preparation, #5237/#5252; AmsPolicySpec, #5249) -- no fetching, no IO,
// same discipline as coding-task-spec.js's own composers.
//
// KNOWN, DOCUMENTED GAPS (not fabricated -- explicitly left as real, narrow follow-ups):
//   - governor.selfPlagiarismCandidate/selfPlagiarismRecentSubmissions are omitted, which chokepoint.ts's own
//     design treats as "skip that stage entirely" -- an honest absence, not a fabricated "clean" verdict.
//
// governor.convergenceInput is now a REAL per-issue attempt-history query (#5654) and governor.reputationHistory
// a REAL per-repo governor-state query (#5675): the caller (attempt-cli.js) reads them from portfolio-queue.js's
// getAttemptHistory and governor-state.js's loadReputationHistory and passes them in here, this composer staying
// pure over them same as every other already-computed dependency below. An omitted argument stays an honest
// absence (zero-state convergence / skipped reputation throttle), never a fabricated clean history.

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
 *
 * @param {Record<string, string | undefined>} env
 * @param {import("@loopover/engine").AmsPolicySpec} amsPolicySpec
 * @param {boolean} [repoPaused]
 * @param {import("@loopover/engine").PortfolioConvergenceInput} [convergenceInput]
 * @param {import("@loopover/engine").RepoOutcomeHistory} [reputationHistory]
 * @returns {import("./attempt-runner.js").AttemptGovernorContext}
 */
export function buildAttemptGovernorContext(env, amsPolicySpec, repoPaused, convergenceInput, reputationHistory) {
  return {
    killSwitchGlobal: isGlobalMinerKillSwitch(env),
    killSwitchRepoPaused: repoPaused,
    liveModeGlobalOptIn: isGlobalMinerLiveModeOptIn(env),
    capLimits: amsPolicySpec.capLimits,
    convergenceInput: convergenceInput ?? { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false },
    ...(reputationHistory === undefined ? {} : { reputationHistory }),
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
    // burn through the entire cross-cycle budget before anything reacts. No maxTokens: every driver now
    // reports a real per-iteration token count (#5653), but no policy field sets a token ceiling yet -- that
    // axis genuinely has no real ceiling to set today, never fabricated.
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
