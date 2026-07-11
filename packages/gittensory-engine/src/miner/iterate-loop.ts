// Local create->score->self-review->decide iterate-loop orchestrator (#2333): the actual autonomous control
// flow Phase 3 exists to build. Repeatedly invokes a `CodingAgentDriver` (coding-agent-driver.ts), self-reviews
// the resulting diff against the byte-identical predicted-gate target (self-review-adapter.ts, #2334), and
// consults the pure policy (iterate-policy.ts, #2335) to decide -- autonomously, no human in the loop at this
// stage -- whether to keep iterating, hand off to Phase 4 submission, or abandon.
//
// TAGGED maintainer (not contributor) per the phase brief: this orchestration control flow is the precise
// chokepoint the fixed architecture skeleton's safety-tier system reserves for the owner -- it is the trigger
// surface for "does the system keep trying, or does it eventually open a PR" without a human approving each
// step, and is adjacent to the #1 slop-at-scale strategic risk (an autonomous fleet maximizing gate-pass rate
// can mass-produce gate-passing-but-low-value PRs).
//
// FAIL CLOSED ON AMBIGUITY: a driver run that does not complete successfully, or a self-review call that
// itself throws, is treated identically to a `SelfReviewOutcome` of `"ambiguous"` -- iterate-policy.ts's own
// precedence then abandons rather than optimistically continuing or handing off. The loop never fabricates a
// "pass" from anything other than a genuinely successful `runSelfReview` call.
//
// BOUNDED INSIDE THE LOOP: both the iteration ceiling (`input.maxIterations`) and the optional cumulative-cost
// ceiling (`input.maxTotalTurns`, summing every iteration's `turnsUsed`) are enforced here every iteration --
// not left to an external caller to remember. A `maxIterations <= 0` input abandons immediately, before ever
// invoking the driver.
//
// AUDITABLE: every iteration's decision (continue / handoff / abandon) is recorded via the injected
// `appendAttemptLogEvent` dependency (attempt-log.ts's normalized event shape) before this function returns
// control to its caller for that iteration -- the decision trail survives independently of this function's own
// return value. A logging failure never alters the loop's decision (mirrors the governor-ledger and
// pretooluse-hook append-failure handling elsewhere in this package).

import type { CodingAgentDriver, CodingAgentDriverResult, CodingAgentDriverTask } from "./coding-agent-driver.js";
import { codingAgentModeExecutes, type CodingAgentExecutionMode } from "./coding-agent-mode.js";
import { invokeCodingAgentDriver } from "./coding-agent-invoke.js";
import type { AttemptLogEvent, AttemptLogEventType } from "./attempt-log.js";
import { runSelfReview, type AttemptDiffState, type SelfReviewAdapterDeps, type SelfReviewContext, type SelfReviewVerdict } from "./self-review-adapter.js";
import { decideNextActionWithReason, deriveSelfReviewOutcome, type IterateLoopDecision, type HandoffPacket, type IterationState, type SelfReviewOutcome } from "./iterate-policy.js";

/** Everything one call to {@link runIterateLoop} needs, aside from the injected {@link IterateLoopDeps}.
 *  Identity/context fields mirror self-review-adapter.ts's `AttemptDiffState`/`SelfReviewContext` exactly --
 *  the caller assembles these from whatever Phase 2 plan/acceptance-criteria packet exists; that packet's
 *  exact combined shape is explicitly out of scope for this issue. */
export type IterateLoopInput = {
  attemptId: string;
  workingDirectory: string;
  acceptanceCriteriaPath: string;
  instructions: string;
  /** Resolved by the caller (e.g. the Governor chokepoint / action-mode resolution, #2340/#2342) -- this loop
   *  does not re-derive execution mode itself, only records whatever mode it is told. */
  mode: CodingAgentExecutionMode;

  /** Hard ceiling on iteration count, enforced every iteration via iterate-policy.ts. `<= 0` abandons before
   *  the first driver invocation. */
  maxIterations: number;
  /** Per-iteration turn budget, passed through to each `CodingAgentDriverTask`. */
  maxTurnsPerIteration: number;
  /** Optional hard ceiling on CUMULATIVE turns spent across every iteration of this attempt so far (summed
   *  from each iteration's `CodingAgentDriverResult.turnsUsed`). Omitted means no additional cost ceiling
   *  beyond what `maxIterations * maxTurnsPerIteration` already implies. */
  maxTotalTurns?: number | undefined;

  // Self-review identity fields -- mirror `AttemptDiffState`'s own identity fields (self-review-adapter.ts).
  repoFullName: string;
  contributorLogin: string;
  title: string;
  body?: string | undefined;
  labels?: string[] | undefined;
  linkedIssues?: number[] | undefined;
  authorAssociation?: string | undefined;
  /** Optional branch ref for the attempt's worktree, threaded through to a passing {@link HandoffPacket}
   *  unchanged -- this loop does not itself manage worktrees/branches (worktree-allocator.ts's job). */
  branchRef?: string | undefined;

  /** Repo-level self-review context (manifest, repo record, issues, pull requests, ...) -- passed through to
   *  `runSelfReview` unchanged every iteration. */
  reviewContext: SelfReviewContext;

  /** True when the target repo (or this contributor's history with it) has signaled it does not want
   *  automated contributions -- resolved by the caller (AI-policy-map / rejection-state-machine), consumed
   *  as-is. See iterate-policy.ts's own `IterationState.rejectionSignaled` doc comment. */
  rejectionSignaled: boolean;
};

export type IterateLoopDeps = {
  driver: CodingAgentDriver;
  runSlopAssessment: SelfReviewAdapterDeps["runSlopAssessment"];
  appendAttemptLogEvent: (event: AttemptLogEvent) => void;
};

/** The terminal outcomes a full loop run can end in -- never `"continue"`, which is only ever a per-iteration,
 *  non-terminal signal. */
export type IterateLoopOutcome = "handoff" | "abandon";

export type IterateLoopIterationRecord = {
  iterationNumber: number;
  driverResult: CodingAgentDriverResult;
  decision: IterateLoopDecision;
};

export type IterateLoopResult = {
  outcome: IterateLoopOutcome;
  finalDecision: IterateLoopDecision;
  /** Count of iterations that actually invoked the driver -- `0` for the `maxIterations <= 0` immediate-abandon
   *  case, since the driver is never invoked there. */
  iterationsUsed: number;
  /** Cumulative `turnsUsed` summed across every iteration that ran. */
  totalTurnsUsed: number;
  iterations: readonly IterateLoopIterationRecord[];
  /** Populated only when `outcome === "handoff"`. */
  handoffPacket?: HandoffPacket | undefined;
};

function buildAttemptDiffState(input: IterateLoopInput, driverResult: CodingAgentDriverResult): AttemptDiffState {
  return {
    repoFullName: input.repoFullName,
    contributorLogin: input.contributorLogin,
    title: input.title,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.labels !== undefined ? { labels: input.labels } : {}),
    ...(input.linkedIssues !== undefined ? { linkedIssues: input.linkedIssues } : {}),
    ...(input.authorAssociation !== undefined ? { authorAssociation: input.authorAssociation } : {}),
    changedFiles: driverResult.changedFiles.map((path) => ({ path })),
  };
}

type SelfReviewEvaluation = { outcome: SelfReviewOutcome; verdict?: SelfReviewVerdict | undefined };

/** Turn one iteration's driver result into a policy-ready {@link SelfReviewOutcome}. A driver run that did not
 *  complete successfully, or a `runSelfReview` call that itself throws, both become `"ambiguous"` -- this loop
 *  never fabricates a pass/fail from anything other than a genuinely successful self-review call. */
function evaluateSelfReviewOutcome(input: IterateLoopInput, driverResult: CodingAgentDriverResult, deps: IterateLoopDeps): SelfReviewEvaluation {
  if (!driverResult.ok) {
    return {
      outcome: { kind: "ambiguous", reason: `driver run did not complete successfully${driverResult.error ? `: ${driverResult.error}` : "."}` },
    };
  }
  try {
    const verdict = runSelfReview(buildAttemptDiffState(input, driverResult), input.reviewContext, { runSlopAssessment: deps.runSlopAssessment });
    return { outcome: deriveSelfReviewOutcome(verdict), verdict };
  } catch (error) {
    return { outcome: { kind: "ambiguous", reason: `self_review_error: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

/** A thrown driver error is normalized into the same `{ ok: false }` shape a driver returning gracefully would
 *  produce, so {@link evaluateSelfReviewOutcome} has exactly one failure path to handle, not two. Non-live modes
 *  are also resolved here, at the driver boundary, so paused/dry-run attempts never spawn the underlying agent. */
async function runDriverSafely(input: IterateLoopInput, deps: IterateLoopDeps, task: CodingAgentDriverTask): Promise<CodingAgentDriverResult> {
  if (!codingAgentModeExecutes(input.mode)) {
    return invokeCodingAgentDriver(deps.driver, input.mode, task, {
      append: (event) => safeAppendAttemptLogEvent(deps, event),
    });
  }
  try {
    return await deps.driver.run(task);
  } catch (error) {
    return { ok: false, changedFiles: [], summary: "", error: `driver_threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function attemptLogEventTypeForDecision(decision: IterateLoopDecision): AttemptLogEventType {
  if (decision.action === "continue") return "attempt_tool_edit";
  if (decision.action === "handoff") return "attempt_succeeded";
  // abandon: a deliberate early disengagement (rejection signaled, or the self-review itself was inconclusive)
  // reads as aborted; a genuine failure to converge (ceiling reached, or stuck with no progress) reads as
  // failed. Both are still `action: "abandon"` in the decision itself -- this is only a coarser attempt-log
  // classification layered on top, for the fixed six-value ATTEMPT_LOG_EVENT_TYPES vocabulary.
  if (decision.abandonReason === "rejection_signaled" || decision.abandonReason === "self_review_ambiguous") return "attempt_aborted";
  return "attempt_failed";
}

/** A logging failure must never crash the loop or alter its decision -- mirrors the governor-ledger and
 *  pretooluse-hook append-failure handling elsewhere in this package. */
function safeAppendAttemptLogEvent(deps: IterateLoopDeps, event: AttemptLogEvent): void {
  try {
    deps.appendAttemptLogEvent(event);
  } catch {
    // Deliberately swallowed -- see doc comment above.
  }
}

function logDecision(input: IterateLoopInput, deps: IterateLoopDeps, iterationNumber: number, decision: IterateLoopDecision): void {
  safeAppendAttemptLogEvent(deps, {
    eventType: attemptLogEventTypeForDecision(decision),
    attemptId: input.attemptId,
    actionClass: "iterate_loop",
    mode: input.mode,
    reason: decision.reason,
    payload: {
      iterationNumber,
      action: decision.action,
      ...(decision.abandonReason !== undefined ? { abandonReason: decision.abandonReason } : {}),
    },
  });
}

/**
 * Extract the blocker codes to carry into the next iteration's no-progress comparison. Only ever called after
 * `decideNextActionWithReason` has returned `"continue"` for this exact `outcome` -- that function's own
 * precedence ladder short-circuits BOTH the `"ambiguous"` and `"pass"` variants (to abandon and handoff
 * respectively) before ever reaching its `"continue"` fallthrough, so `outcome.kind === "fail"` is guaranteed
 * whenever this is reached from the real call site below, not just the common case.
 */
function blockerCodesFromContinuingOutcome(outcome: SelfReviewOutcome): readonly string[] {
  if (outcome.kind === "fail") return outcome.blockerCodes;
  /* v8 ignore next -- unreachable: see this function's own doc comment above. */
  return [];
}

function buildHandoffPacket(input: IterateLoopInput, verdict: SelfReviewVerdict, driverResult: CodingAgentDriverResult): HandoffPacket {
  return {
    worktreePath: input.workingDirectory,
    ...(input.branchRef !== undefined ? { branchRef: input.branchRef } : {}),
    diffSummary: driverResult.summary,
    selfReviewVerdict: verdict,
    attemptLogReference: input.attemptId,
  };
}

function immediateAbandonNoIterationsPermitted(input: IterateLoopInput, deps: IterateLoopDeps): IterateLoopResult {
  const decision: IterateLoopDecision = {
    action: "abandon",
    abandonReason: "max_iterations_reached",
    reason: `maxIterations (${input.maxIterations}) permits no iterations; abandoning without invoking the driver.`,
  };
  safeAppendAttemptLogEvent(deps, {
    eventType: "attempt_aborted",
    attemptId: input.attemptId,
    actionClass: "iterate_loop",
    mode: input.mode,
    reason: decision.reason,
    payload: { iterationNumber: 0, action: decision.action, abandonReason: decision.abandonReason },
  });
  return { outcome: "abandon", finalDecision: decision, iterationsUsed: 0, totalTurnsUsed: 0, iterations: [] };
}

/**
 * Run the full create->score->self-review->decide loop for one attempt, iteration by iteration, until
 * iterate-policy.ts's {@link decideNextActionWithReason} reaches a terminal `"handoff"` or `"abandon"`.
 *
 * Every iteration: invoke the driver, self-review the resulting diff (never fabricating a pass from a failed
 * or errored driver/self-review run), consult the policy with the running iteration/cost/no-progress state,
 * and record the decision via the attempt-log. `"continue"` decisions loop again; `"handoff"`/`"abandon"`
 * return immediately.
 */
export async function runIterateLoop(input: IterateLoopInput, deps: IterateLoopDeps): Promise<IterateLoopResult> {
  // Truncated toward zero rather than used as-is: a fractional maxIterations (a caller bug -- "how many times
  // to run a coding agent" has no fractional meaning) would otherwise let this loop's own `for` bound and
  // iterate-policy.ts's `iterationNumber >= maxIterations` ceiling check disagree by less than one iteration
  // (e.g. 2.5 lets the `for` loop run a 3rd time that the ceiling check, comparing against 2.5, would not yet
  // reject), silently permitting one extra iteration beyond the caller's intent. Normalizing once here keeps
  // both checks watching the exact same integer ceiling.
  const maxIterations = Math.max(0, Math.trunc(input.maxIterations));
  if (maxIterations <= 0) return immediateAbandonNoIterationsPermitted(input, deps);

  safeAppendAttemptLogEvent(deps, {
    eventType: "attempt_started",
    attemptId: input.attemptId,
    actionClass: "iterate_loop",
    mode: input.mode,
    reason: "iterate_loop_started",
    payload: { maxIterations, maxTurnsPerIteration: input.maxTurnsPerIteration },
  });

  const iterations: IterateLoopIterationRecord[] = [];
  let previousBlockerCodes: readonly string[] | null = null;
  let totalTurnsUsed = 0;

  for (let iterationNumber = 1; iterationNumber <= maxIterations; iterationNumber += 1) {
    const driverResult = await runDriverSafely(input, deps, {
      attemptId: input.attemptId,
      workingDirectory: input.workingDirectory,
      acceptanceCriteriaPath: input.acceptanceCriteriaPath,
      instructions: input.instructions,
      maxTurns: input.maxTurnsPerIteration,
    });
    totalTurnsUsed += driverResult.turnsUsed ?? 0;

    const { outcome: selfReview, verdict } = evaluateSelfReviewOutcome(input, driverResult, deps);

    const state: IterationState = {
      iterationNumber,
      maxIterations,
      costCeilingReached: input.maxTotalTurns !== undefined && totalTurnsUsed >= input.maxTotalTurns,
      selfReview,
      previousBlockerCodes,
      rejectionSignaled: input.rejectionSignaled,
    };
    const decision = decideNextActionWithReason(state);
    logDecision(input, deps, iterationNumber, decision);
    iterations.push({ iterationNumber, driverResult, decision });

    if (decision.action === "handoff") {
      // Guaranteed defined: decideNextActionWithReason only reaches `"handoff"` from `selfReview.kind ===
      // "pass"`, which evaluateSelfReviewOutcome only ever returns alongside a real, successfully computed
      // verdict (never from the ambiguous/driver-failure path).
      return {
        outcome: "handoff",
        finalDecision: decision,
        iterationsUsed: iterationNumber,
        totalTurnsUsed,
        iterations,
        handoffPacket: buildHandoffPacket(input, verdict as SelfReviewVerdict, driverResult),
      };
    }
    if (decision.action === "abandon") {
      return { outcome: "abandon", finalDecision: decision, iterationsUsed: iterationNumber, totalTurnsUsed, iterations };
    }
    previousBlockerCodes = blockerCodesFromContinuingOutcome(selfReview);
  }

  /* v8 ignore next 8 -- unreachable in practice: decideNextActionWithReason's own `iterationNumber >=
   * maxIterations` check guarantees an abandon by the time iterationNumber reaches the (now-integer, per the
   * truncation above) maxIterations ceiling inside the loop above, so the for-loop above always returns.
   * Retained as an explicit fail-closed fallback rather than an implicit `undefined` return, consistent with
   * this package's fail-closed discipline, in case a future edit to the precedence ladder ever removes that
   * guarantee. */
  const fallbackDecision: IterateLoopDecision = { action: "abandon", abandonReason: "max_iterations_reached", reason: "Iterate loop exhausted its iteration budget." };
  return { outcome: "abandon", finalDecision: fallbackDecision, iterationsUsed: maxIterations, totalTurnsUsed, iterations };
}
