import { isGlobalMinerKillSwitch, isGlobalMinerLiveModeOptIn } from "@jsonbored/gittensory-engine";

// Pure composers for runMinerAttempt's real input (#5132, Wave 3.5 -- the final assembly). Everything here is
// a plain in/out transform over already-fetched/already-computed real data (coding-task-spec, #5239;
// self-review-context, #5145; worktree preparation, #5237/#5252; AmsPolicySpec, #5249) -- no fetching, no IO,
// same discipline as coding-task-spec.js's own composers.
//
// KNOWN, DOCUMENTED GAPS (not fabricated -- explicitly left as real, narrow follow-ups):
//   - governor.convergenceInput is a first-attempt-shaped literal ({ attempts: 0, consecutiveFailures: 0,
//     reenqueues: 0, reachedDone: false }), not a real per-issue query. attempt-log.js's schema has no
//     repo+issue index (attemptId embeds a timestamp, so it's not a stable group key), and reenqueue counts
//     aren't tracked ANYWHERE yet (non-convergence.ts's own header says that belongs on the portfolio-queue
//     table once it grows attempt-history columns -- a real, separate schema change, not something to fake
//     here). This literal is only ever an UNDER-estimate (reads "fresh, no prior failures" even on a real
//     Nth attempt), which fails toward LETTING an attempt through, not blocking one -- documented, not silent.
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
 * @param {Record<string, string | undefined>} env
 * @param {import("@jsonbored/gittensory-engine").AmsPolicySpec} amsPolicySpec
 * @param {boolean} [repoPaused]
 * @returns {import("./attempt-runner.js").AttemptGovernorContext}
 */
export function buildAttemptGovernorContext(env, amsPolicySpec, repoPaused) {
  return {
    killSwitchGlobal: isGlobalMinerKillSwitch(env),
    killSwitchRepoPaused: repoPaused,
    liveModeGlobalOptIn: isGlobalMinerLiveModeOptIn(env),
    capLimits: amsPolicySpec.capLimits,
    convergenceInput: { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false },
  };
}

/**
 * Assemble the real IterateLoopInput for one attempt from every already-computed real dependency. Pure --
 * throws nothing itself (callers are expected to have already validated `codingTaskSpec.ready`).
 *
 * @param {{
 *   codingTaskSpec: Extract<import("./coding-task-spec.js").CodingTaskSpecResult, { ready: true }>,
 *   reviewContext: import("@jsonbored/gittensory-engine").SelfReviewContext,
 *   worktreePath: string,
 *   attemptId: string,
 *   mode: import("@jsonbored/gittensory-engine").CodingAgentExecutionMode,
 *   repoFullName: string,
 *   minerLogin: string,
 *   rejectionSignaled: boolean,
 *   amsPolicySpec: import("@jsonbored/gittensory-engine").AmsPolicySpec,
 *   branchRef?: string,
 * }} input
 * @returns {import("@jsonbored/gittensory-engine").IterateLoopInput}
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
