import { evaluateHarnessSubmissionTrigger } from "@loopover/engine";

// Harness submission-gate wiring orchestrator (#2337): the real-IO half of connecting the gated-submission
// decision (`shouldSubmit`, wrapped by `evaluateHarnessSubmissionTrigger`, @loopover/engine) to a
// real driving loop's own handoff signal. Reads the session's recent decision history to compute the
// consecutive-block circuit-breaker tally, consults the pure decision, and always records exactly one audit
// event -- regardless of outcome, so a paused-pending-human-review session leaves a full trail of why.
//
// NOT WIRED INTO ANY AUTOMATIC SCHEDULE: per this issue's own "manual owner sign-off on the wiring before this
// ships to any default-on profile" deliverable. `prepareOpenPrSubmission` below is the gate→payload bridge:
// on `allow: true` it shapes the exact input `buildOpenPrSpec` (`@loopover/engine`,
// `packages/loopover-engine/src/miner/local-write-tools.ts`, re-exported from the engine public barrel) expects
// as `openPrInput`. It deliberately does NOT call `buildOpenPrSpec` itself -- that stays the caller's job so
// this module stays a decision-to-payload bridge. The in-package caller is `attempt-runner.js`, which imports
// `buildOpenPrSpec` from `@loopover/engine` and runs it after a `ready: true` result (the pre-#5131/#5132
// "unreachable from root `src/mcp/`" boundary no longer applies, but the layering still does: gate evaluate →
// shape openPrInput here → build the runnable local-write spec in the driver). Equivalent MCP call sites
// (e.g. `loopover_open_pr`) can likewise take `openPrInput` from a `ready: true` result.
//
// SESSION-SCOPED, NOT PER-REPO: the circuit breaker's own "pauses the run entirely" wording means the tally is
// counted across EVERY repo's decisions this session, not scoped to one repo -- distinct from #2338's loop-
// reentry circuit breaker, which is deliberately per-repo (a rejection streak on one repo must not pause
// unrelated repos).

export const HARNESS_SUBMISSION_TRIGGER_DECISION_EVENT = "harness_submission_trigger_decision";

/** Count consecutive `allow: false` decisions recorded at or after `sinceMs`, walking backward from the most
 *  recent decision until an `allow: true` breaks the streak (or history runs out). Session-scoped (not
 *  filtered by repo) to match the circuit breaker's own "pauses the run entirely" semantics. */
export function countConsecutiveGateBlocks(eventLedger, sinceMs) {
  const decisions = eventLedger
    .readEvents({})
    .filter((event) => event.type === HARNESS_SUBMISSION_TRIGGER_DECISION_EVENT && Date.parse(event.createdAt) >= sinceMs);
  let count = 0;
  for (let i = decisions.length - 1; i >= 0; i -= 1) {
    if (decisions[i].payload?.allow === true) break;
    count += 1;
  }
  return count;
}

/**
 * Evaluate the harness submission trigger for one candidate handoff, reading real session history to compute
 * the circuit-breaker tally, and always appending exactly one audit event. Fails closed (throws) on a
 * malformed candidate or missing required dependency.
 *
 * @param {{ killSwitchScope: "global"|"repo"|"none", repoFullName: string, handoffPacket: object, slopThreshold: "clean"|"low"|"elevated"|"high", mode: "observe"|"enforce", maxConsecutiveGateBlocks?: number }} candidate
 * @param {{ eventLedger: object, sessionStartMs?: number }} deps
 */
export function evaluateAndRecordHarnessSubmissionTrigger(candidate, deps) {
  if (!candidate || typeof candidate !== "object") throw new Error("invalid_harness_submission_candidate");
  if (!["global", "repo", "none"].includes(candidate.killSwitchScope)) throw new Error("invalid_kill_switch_scope");
  const repoFullName = typeof candidate.repoFullName === "string" ? candidate.repoFullName.trim() : "";
  if (!repoFullName) throw new Error("invalid_repo_full_name");
  if (!candidate.handoffPacket || typeof candidate.handoffPacket !== "object") throw new Error("invalid_handoff_packet");

  if (!deps || typeof deps !== "object") throw new Error("invalid_harness_submission_deps");
  const { eventLedger, sessionStartMs = 0 } = deps;
  if (!eventLedger || typeof eventLedger.appendEvent !== "function" || typeof eventLedger.readEvents !== "function") {
    throw new Error("invalid_event_ledger");
  }

  const consecutiveGateBlocks = countConsecutiveGateBlocks(eventLedger, sessionStartMs);

  const decision = evaluateHarnessSubmissionTrigger({
    killSwitchScope: candidate.killSwitchScope,
    handoffPacket: candidate.handoffPacket,
    slopThreshold: candidate.slopThreshold,
    mode: candidate.mode,
    consecutiveGateBlocks,
    maxConsecutiveGateBlocks: candidate.maxConsecutiveGateBlocks,
  });

  const event = eventLedger.appendEvent({
    type: HARNESS_SUBMISSION_TRIGGER_DECISION_EVENT,
    repoFullName,
    payload: {
      killSwitchScope: candidate.killSwitchScope,
      allow: decision.allow,
      reasons: decision.reasons,
      circuitBreakerTripped: decision.circuitBreakerTripped,
      consecutiveGateBlocks,
      attemptLogReference: candidate.handoffPacket.attemptLogReference ?? null,
    },
  });

  return { decision, event };
}

/**
 * Bridge one completed handoff through the submission gate to a submission-READY payload -- the exact input
 * shape `buildOpenPrSpec` (`@loopover/engine`) expects (repoFullName/base/head/title/body/draft). On `allow:
 * true` returns `{ ready: true, decision, event, openPrInput }`; otherwise `{ ready: false, decision, event }`
 * -- the block reasons are on `decision.reasons` and already on the ledger via the wrapped call either way.
 * Does NOT call `buildOpenPrSpec` itself: this stays a gate→payload bridge; `attempt-runner.js` (and MCP
 * `loopover_open_pr` equivalents) take `openPrInput` from a `ready: true` result and call
 * `buildOpenPrSpec`. The cross-package "unreachable from root src/" reason no longer applies (#5131/#5132
 * moved the builder into `@loopover/engine`), but the deliberate non-call layering is still necessary.
 *
 * Fails closed (throws) on a malformed candidate, mirroring evaluateAndRecordHarnessSubmissionTrigger's own
 * validation -- a missing PR title/base is a caller bug that must never silently degrade into a garbage spec.
 * The one field evaluateAndRecordHarnessSubmissionTrigger does NOT itself require -- handoffPacket.branchRef,
 * optional there because iterate-loop.ts deliberately does not manage worktrees/branches -- IS required here,
 * but only once the decision is known to be `allow: true`: a PR cannot be opened without a source branch, but a
 * blocked candidate needs no branch at all, and must not throw for a reason unrelated to why it was blocked.
 *
 * @param {{ killSwitchScope: "global"|"repo"|"none", repoFullName: string, handoffPacket: { branchRef?: string, [key: string]: unknown }, slopThreshold: "clean"|"low"|"elevated"|"high", mode: "observe"|"enforce", maxConsecutiveGateBlocks?: number, base: string, title: string, body?: string, draft?: boolean }} candidate
 * @param {{ eventLedger: object, sessionStartMs?: number }} deps
 */
export function prepareOpenPrSubmission(candidate, deps) {
  if (!candidate || typeof candidate !== "object") throw new Error("invalid_harness_submission_candidate");
  const base = typeof candidate.base === "string" ? candidate.base.trim() : "";
  if (!base) throw new Error("invalid_pr_base");
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  if (!title) throw new Error("invalid_pr_title");

  const { decision, event } = evaluateAndRecordHarnessSubmissionTrigger(candidate, deps);
  if (!decision.allow) return { ready: false, decision, event };

  // Only reached once evaluateAndRecordHarnessSubmissionTrigger has already validated handoffPacket is a
  // well-formed object -- safe to read .branchRef directly.
  const head = typeof candidate.handoffPacket.branchRef === "string" ? candidate.handoffPacket.branchRef.trim() : "";
  if (!head) throw new Error("invalid_pr_head_branch");

  return {
    ready: true,
    decision,
    event,
    openPrInput: {
      repoFullName: candidate.repoFullName.trim(),
      base,
      head,
      title,
      body: typeof candidate.body === "string" ? candidate.body : "",
      draft: candidate.draft === true,
    },
  };
}
