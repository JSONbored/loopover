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
// BOUNDED INSIDE THE LOOP: both the iteration ceiling (`input.maxIterations`) and the optional cumulative
// budget (`input.budget`, evaluated every iteration via attempt-metering.ts's `accumulateAttemptUsage`/
// `evaluateAttemptBudget` against real per-iteration turns/costUsd/wallClockMs -- tokens stays an honest 0,
// no driver reports a real token count today, #5395) are enforced here every iteration -- not left to an
// external caller to remember, and not just capped after the fact between loop cycles (loop-cli.js's own
// governor cap usage). A `maxIterations <= 0` input abandons immediately, before ever invoking the driver.
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
import { accumulateAttemptUsage, evaluateAttemptBudget, type AttemptBudget, type AttemptBudgetAxis, type AttemptMeterTotals } from "./attempt-metering.js";

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
  /** Optional cumulative budget ceiling(s), evaluated every iteration against the real running totals
   *  (attempt-metering.ts's `AttemptMeterTotals`, #5395). Omitted means no additional ceiling beyond what
   *  `maxIterations * maxTurnsPerIteration` already implies. A breach on any axis (turns/costUsd/wallClockMs
   *  -- tokens is never real-tracked today) is a HARD, unconditional stop: checked and abandoned on BEFORE
   *  self-review even runs, so a same-iteration pass can never bypass the ceiling (this is deliberately NOT
   *  routed through iterate-policy.ts's `costCeilingReached` field, whose own precedence checks a self-review
   *  pass first -- see the loop body's own comment at the check site for why that ordering doesn't fit a hard
   *  budget ceiling). */
  budget?: AttemptBudget | undefined;

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
  /** Injected clock for real per-iteration wall-clock measurement (#5395), mirroring this package's own
   *  injected-dependency discipline elsewhere (never a hardcoded `Date.now()` a test can't control). Defaults
   *  to the real `Date.now` when omitted. */
  nowMs?: (() => number) | undefined;
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
  /** Cumulative real dollar cost summed across every iteration that ran, from each iteration's
   *  `CodingAgentDriverResult.costUsd`. Only the `agent-sdk` provider reports this today (the CLI-subprocess
   *  providers report no cost signal) -- always `0` for a provider that never reports one, never fabricated. */
  totalCostUsd: number;
  /** The real accumulated {@link AttemptMeterTotals} across every iteration that ran (attempt-metering.ts,
   *  #5395) -- a superset of `totalTurnsUsed`/`totalCostUsd` above that also carries `wallClockMs` (real,
   *  measured around each driver invocation) and `tokens` (always 0 today -- no driver reports a real token
   *  count, an honest absence rather than a fabricated number). */
  finalMeterTotals: AttemptMeterTotals;
  /** The budget axes breached at the point this attempt abandoned, when `input.budget` was set and at least
   *  one axis was at/over its ceiling -- empty when no budget was configured or none breached. */
  budgetBreaches: AttemptBudgetAxis[];
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

function logDecision(
  input: IterateLoopInput,
  deps: IterateLoopDeps,
  iterationNumber: number,
  decision: IterateLoopDecision,
  budgetBreaches: readonly AttemptBudgetAxis[],
): void {
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
      // Which real axis (or axes) breached, on the hard-budget-ceiling abandon path (#5395, checked directly
      // in the loop body before self-review even runs -- see that check site's own comment) -- an operator
      // reading the attempt log back otherwise has no way to see which axis actually tripped.
      ...(budgetBreaches.length > 0 ? { budgetBreaches } : {}),
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

const ZERO_METER_TOTALS: AttemptMeterTotals = { tokens: 0, turns: 0, wallClockMs: 0, costUsd: 0 };

/** The result shape {@link runIterateLoopCore} itself returns -- everything BUT the meter fields, which the
 *  thin {@link runIterateLoop} wrapper attaches once, from `tracker`, at its own single always-reached return
 *  point (#5395). Keeps the core's own internal return statements -- including the `/* v8 ignore *\/`-guarded
 *  unreachable fallback -- byte-identical to their pre-#5395 shape, so that genuinely unreachable branch never
 *  needs new fields threaded onto it (v8's ignore-comment suppresses vitest's OWN text-reporter percentage,
 *  but NOT the raw lcov Codecov reads -- a new field on that branch would show as a real uncovered patch line
 *  with no way to actually exercise it). */
type IterateLoopCoreResult = Omit<IterateLoopResult, "finalMeterTotals" | "budgetBreaches">;

/** Mutable accumulator threaded into {@link runIterateLoopCore} so the wrapper can read the real running
 *  totals/breaches after the core returns, without the core itself needing to carry them on every return
 *  statement. */
type MeterTracker = { totals: AttemptMeterTotals; breaches: AttemptBudgetAxis[] };

function immediateAbandonNoIterationsPermitted(input: IterateLoopInput, deps: IterateLoopDeps): IterateLoopCoreResult {
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
  return { outcome: "abandon", finalDecision: decision, iterationsUsed: 0, totalTurnsUsed: 0, totalCostUsd: 0, iterations: [] };
}

/**
 * Run the full create->score->self-review->decide loop for one attempt, iteration by iteration, until
 * iterate-policy.ts's {@link decideNextActionWithReason} reaches a terminal `"handoff"` or `"abandon"`.
 *
 * Every iteration: invoke the driver, self-review the resulting diff (never fabricating a pass from a failed
 * or errored driver/self-review run), consult the policy with the running iteration/cost/no-progress state,
 * and record the decision via the attempt-log. `"continue"` decisions loop again; `"handoff"`/`"abandon"`
 * return immediately. See {@link IterateLoopCoreResult}'s own doc comment for why this doesn't carry
 * `finalMeterTotals`/`budgetBreaches` itself -- {@link runIterateLoop} attaches those.
 */
async function runIterateLoopCore(input: IterateLoopInput, deps: IterateLoopDeps, tracker: MeterTracker): Promise<IterateLoopCoreResult> {
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

  const nowMs = deps.nowMs ?? Date.now;
  const iterations: IterateLoopIterationRecord[] = [];
  let previousBlockerCodes: readonly string[] | null = null;
  let totalTurnsUsed = 0;
  let totalCostUsd = 0;

  for (let iterationNumber = 1; iterationNumber <= maxIterations; iterationNumber += 1) {
    const iterationStartMs = nowMs();
    const driverResult = await runDriverSafely(input, deps, {
      attemptId: input.attemptId,
      workingDirectory: input.workingDirectory,
      acceptanceCriteriaPath: input.acceptanceCriteriaPath,
      instructions: input.instructions,
      maxTurns: input.maxTurnsPerIteration,
    });
    const iterationElapsedMs = Math.max(0, nowMs() - iterationStartMs);
    totalTurnsUsed += driverResult.turnsUsed ?? 0;
    totalCostUsd += driverResult.costUsd ?? 0;
    // tokens stays an honest 0: no CodingAgentDriver reports a real per-iteration token count today (#5395) --
    // an absence, never a fabricated number, matching this package's costUsd discipline elsewhere.
    tracker.totals = accumulateAttemptUsage(tracker.totals, {
      tokens: 0,
      turns: driverResult.turnsUsed ?? 0,
      wallClockMs: iterationElapsedMs,
      costUsd: driverResult.costUsd ?? 0,
    });
    const budgetVerdict = input.budget !== undefined ? evaluateAttemptBudget(tracker.totals, input.budget) : undefined;
    tracker.breaches = budgetVerdict?.breaches ?? [];

    // A reached budget ceiling is a HARD, unconditional stop -- checked and, if breached, acted on BEFORE
    // self-review even runs, so a same-iteration pass can never bypass it. The spend/turns/time on this
    // iteration are sunk either way (the driver already ran), but handing off anyway would let a single
    // over-budget iteration silently defeat the entire point of wiring a ceiling in (#5395's own mid-attempt
    // abort goal) -- so this abandons regardless of what this iteration's own result looks like.
    if (budgetVerdict !== undefined && !budgetVerdict.withinBudget) {
      const decision: IterateLoopDecision = {
        action: "abandon",
        abandonReason: "cost_ceiling_reached",
        reason: `Reached the attempt's budget ceiling (${tracker.breaches.join(", ")}) on iteration ${iterationNumber}; abandoning regardless of this iteration's own result.`,
      };
      logDecision(input, deps, iterationNumber, decision, tracker.breaches);
      iterations.push({ iterationNumber, driverResult, decision });
      return { outcome: "abandon", finalDecision: decision, iterationsUsed: iterationNumber, totalTurnsUsed, totalCostUsd, iterations };
    }

    const { outcome: selfReview, verdict } = evaluateSelfReviewOutcome(input, driverResult, deps);

    const state: IterationState = {
      iterationNumber,
      maxIterations,
      selfReview,
      previousBlockerCodes,
      rejectionSignaled: input.rejectionSignaled,
    };
    const decision = decideNextActionWithReason(state);
    logDecision(input, deps, iterationNumber, decision, []);
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
        totalCostUsd,
        iterations,
        handoffPacket: buildHandoffPacket(input, verdict as SelfReviewVerdict, driverResult),
      };
    }
    if (decision.action === "abandon") {
      return { outcome: "abandon", finalDecision: decision, iterationsUsed: iterationNumber, totalTurnsUsed, totalCostUsd, iterations };
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
  return { outcome: "abandon", finalDecision: fallbackDecision, iterationsUsed: maxIterations, totalTurnsUsed, totalCostUsd, iterations };
}

/**
 * Thin wrapper over {@link runIterateLoopCore} that attaches the real accumulated
 * {@link AttemptMeterTotals}/breached axes (#5395) once, at this single always-reached return point -- see
 * {@link IterateLoopCoreResult}'s own doc comment for why the core itself doesn't carry these fields.
 */
export async function runIterateLoop(input: IterateLoopInput, deps: IterateLoopDeps): Promise<IterateLoopResult> {
  const tracker: MeterTracker = { totals: ZERO_METER_TOTALS, breaches: [] };
  const core = await runIterateLoopCore(input, deps, tracker);
  return { ...core, finalMeterTotals: tracker.totals, budgetBreaches: tracker.breaches };
}
