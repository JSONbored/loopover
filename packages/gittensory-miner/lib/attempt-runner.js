import { buildOpenPrSpec } from "@jsonbored/gittensory-engine";
import { runIterateLoop } from "@jsonbored/gittensory-engine";
import { checkSubmissionFreshness } from "./submission-freshness-check.js";
import { evaluateGovernorChokepointGatePersisted } from "./governor-chokepoint-persisted.js";
import { prepareOpenPrSubmission } from "./harness-submission-trigger.js";

// The real driving-loop entrypoint (#2337): the missing link between #2333's iterate-loop orchestrator and an
// actual, executed open_pr write. Composes, in order: runIterateLoop (create -> score -> self-review -> decide,
// #2333) -> on handoff, checkSubmissionFreshness (#3007) -> prepareOpenPrSubmission (#2336/#2337) -> the
// Governor chokepoint (#2340, which itself composes kill-switch, dry-run, rate-limit, budget caps, non-
// convergence, self-reputation-throttle, and self-plagiarism -- see chokepoint.ts's own module doc comment for
// the exact precedence ladder) -> on allowed:true, builds the REAL open_pr command via the now-shared
// buildOpenPrSpec (@jsonbored/gittensory-engine, moved from root src/mcp/local-write-tools.ts) and executes it.
//
// WORKTREE LIFECYCLE IS NOT THIS MODULE'S JOB: runIterateLoop already takes a plain `workingDirectory` string
// (packages/gittensory-engine/src/miner/iterate-loop.ts's own IterateLoopInput), deliberately agnostic about
// where it came from. Allocating one is the caller's job, via the already-built slot allocator
// (worktree-allocator.js, #4297) -- this module composes the create/review/gate/submit sequence #2337 is
// actually about, not worktree allocation policy, which is a separate, already-solved concern.
//
// KNOWN, DELIBERATE GAP (not silently papered over -- was an injected-but-unwired seam before this module
// existed, and remains so here):
//   - `deps.runSlopAssessment` has no production implementation anywhere in this package. The real slop scorer
//     (src/signals/slop.ts, 518 lines, 5 sibling src/signals/** dependencies) is far larger and more
//     interconnected than local-write-tools.ts was, so extracting it is separate, substantial scope -- this
//     function requires a real one be injected rather than silently stubbing a result that would either always
//     pass (unsafe) or always fail (useless).
//
// `input.governor`'s cross-attempt state (rate-limit buckets, backoff attempts, budget-cap usage) DOES now
// persist across separate process invocations (#5134, governor-state.js), via
// evaluateGovernorChokepointGatePersisted -- callers no longer need to hand-thread honest empty/zero defaults
// on every invocation; `capUsage` is loaded from that same store but its post-attempt save stays the caller's
// job (see governor-chokepoint-persisted.js's own header for why: nothing computes "the next capUsage" from a
// verdict, only the attempt's real outcome does). Reputation/self-plagiarism state also has real persistence
// primitives (governor-state.js) but isn't auto-loaded here yet -- `input.governor.reputationHistory`/
// `selfPlagiarismCandidate`/`selfPlagiarismRecentSubmissions` are still caller-supplied optional fields on
// GovernorChokepointInput, same as before.

/** True once the loop reaches handoff AND every downstream gate (freshness, submission, governor) allows. */
export const ATTEMPT_OUTCOMES = Object.freeze(["abandon", "stale", "blocked", "governed", "submitted"]);

function assertFn(value, name) {
  if (typeof value !== "function") throw new Error(`invalid_${name}`);
}

function assertDeps(deps) {
  if (!deps || typeof deps !== "object") throw new Error("invalid_attempt_deps");
  assertFn(deps.runSlopAssessment, "run_slop_assessment");
  assertFn(deps.appendAttemptLogEvent, "append_attempt_log_event");
  assertFn(deps.fetchLiveIssueSnapshot, "fetch_live_issue_snapshot");
  assertFn(deps.executeLocalWrite, "execute_local_write");
  if (!deps.driver || typeof deps.driver.run !== "function") throw new Error("invalid_driver");
  if (!deps.claimLedger || typeof deps.claimLedger.listClaims !== "function") throw new Error("invalid_claim_ledger");
  if (!deps.eventLedger || typeof deps.eventLedger.appendEvent !== "function") throw new Error("invalid_event_ledger");
  if (typeof deps.nowMs !== "number" || !Number.isFinite(deps.nowMs)) throw new Error("invalid_now_ms");
}

function assertInput(input) {
  if (!input || typeof input !== "object") throw new Error("invalid_attempt_input");
  if (!input.loopInput || typeof input.loopInput !== "object") throw new Error("invalid_loop_input");
  if (!Number.isInteger(input.issueNumber) || input.issueNumber < 1) throw new Error("invalid_issue_number");
  if (typeof input.minerLogin !== "string" || !input.minerLogin.trim()) throw new Error("invalid_miner_login");
  if (typeof input.base !== "string" || !input.base.trim()) throw new Error("invalid_base");
  if (!["global", "repo", "none"].includes(input.killSwitchScope)) throw new Error("invalid_kill_switch_scope");
  if (!["clean", "low", "elevated", "high"].includes(input.slopThreshold)) throw new Error("invalid_slop_threshold");
  if (!["observe", "enforce"].includes(input.submissionMode)) throw new Error("invalid_submission_mode");
  if (!input.governor || typeof input.governor !== "object") throw new Error("invalid_governor_context");
}

/**
 * Run one full attempt end to end: iterate-loop -> (on handoff) freshness -> submission-gate -> Governor
 * chokepoint -> (on allowed:true) build + execute the real open_pr command. Fails closed (throws) on malformed
 * input/deps, mirroring every sibling module in this pipeline.
 *
 * @param {{
 *   loopInput: import("@jsonbored/gittensory-engine").IterateLoopInput,
 *   issueNumber: number,
 *   minerLogin: string,
 *   base: string,
 *   killSwitchScope: "global"|"repo"|"none",
 *   slopThreshold: "clean"|"low"|"elevated"|"high",
 *   submissionMode: "observe"|"enforce",
 *   maxConsecutiveGateBlocks?: number,
 *   draft?: boolean,
 *   governor: Omit<import("@jsonbored/gittensory-engine").GovernorChokepointInput, "actionClass"|"repoFullName"|"nowMs"|"wouldBeAction">,
 * }} input
 * @param {{
 *   driver: import("@jsonbored/gittensory-engine").CodingAgentDriver,
 *   runSlopAssessment: Function,
 *   appendAttemptLogEvent: Function,
 *   claimLedger: object,
 *   fetchLiveIssueSnapshot: Function,
 *   eventLedger: object,
 *   governorLedgerAppend?: Function,
 *   governorState?: import("./governor-state.js").GovernorState,
 *   sessionStartMs?: number,
 *   nowMs: number,
 *   executeLocalWrite: (spec: import("@jsonbored/gittensory-engine").LocalWriteActionSpec) => Promise<unknown>,
 * }} deps
 */
export async function runMinerAttempt(input, deps) {
  assertInput(input);
  assertDeps(deps);

  const loopResult = await runIterateLoop(input.loopInput, {
    driver: deps.driver,
    runSlopAssessment: deps.runSlopAssessment,
    appendAttemptLogEvent: deps.appendAttemptLogEvent,
  });

  if (loopResult.outcome === "abandon") {
    return { outcome: "abandon", loopResult };
  }

  const handoffPacket = loopResult.handoffPacket;

  const freshness = await checkSubmissionFreshness(
    { repoFullName: input.loopInput.repoFullName, issueNumber: input.issueNumber, minerLogin: input.minerLogin },
    { claimLedger: deps.claimLedger, fetchLiveIssueSnapshot: deps.fetchLiveIssueSnapshot, eventLedger: deps.eventLedger },
  );
  if (!freshness.fresh) {
    return { outcome: "stale", reason: freshness.reason, loopResult };
  }

  const submission = await prepareOpenPrSubmission(
    {
      killSwitchScope: input.killSwitchScope,
      repoFullName: input.loopInput.repoFullName,
      handoffPacket,
      slopThreshold: input.slopThreshold,
      mode: input.submissionMode,
      maxConsecutiveGateBlocks: input.maxConsecutiveGateBlocks,
      base: input.base,
      title: input.loopInput.title,
      body: input.loopInput.body ?? "",
      draft: input.draft,
    },
    { eventLedger: deps.eventLedger, sessionStartMs: deps.sessionStartMs },
  );
  if (!submission.ready) {
    return { outcome: "blocked", decision: submission.decision, loopResult };
  }

  const governed = evaluateGovernorChokepointGatePersisted(
    {
      actionClass: "open_pr",
      repoFullName: input.loopInput.repoFullName,
      nowMs: deps.nowMs,
      wouldBeAction: submission.openPrInput,
      ...input.governor,
    },
    {
      ...(deps.governorLedgerAppend ? { append: deps.governorLedgerAppend } : {}),
      ...(deps.governorState ? { governorState: deps.governorState } : {}),
    },
  );
  if (!governed.decision.allowed) {
    return { outcome: "governed", decision: governed.decision, loopResult };
  }

  const spec = buildOpenPrSpec(submission.openPrInput);
  const execResult = await deps.executeLocalWrite(spec);
  return { outcome: "submitted", spec, execResult, loopResult };
}
