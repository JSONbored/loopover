import { evaluateHarnessSubmissionTrigger } from "@jsonbored/gittensory-engine";

// Harness submission-gate wiring orchestrator (#2337): the real-IO half of connecting the gated-submission
// decision (`shouldSubmit`, wrapped by `evaluateHarnessSubmissionTrigger`, @jsonbored/gittensory-engine) to a
// real driving loop's own handoff signal. Reads the session's recent decision history to compute the
// consecutive-block circuit-breaker tally, consults the pure decision, and always records exactly one audit
// event -- regardless of outcome, so a paused-pending-human-review session leaves a full trail of why.
//
// NOT WIRED INTO ANY AUTOMATIC SCHEDULE: per this issue's own "manual owner sign-off on the wiring before this
// ships to any default-on profile" deliverable. A real call site (root-side server/CLI integration) invokes
// this function with a real `HandoffPacket`; on `allow: true` it may then build the `open_pr` local-write spec
// itself -- this module does not, and cannot, do that (the spec builder lives in the private root `src/` tree,
// unreachable from this package -- same cross-package-boundary reason self-review-adapter.ts's slop injection
// exists).
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
 * @param {{ repoFullName: string, handoffPacket: object, slopThreshold: "clean"|"low"|"elevated"|"high", mode: "observe"|"enforce", maxConsecutiveGateBlocks?: number }} candidate
 * @param {{ eventLedger: object, sessionStartMs?: number }} deps
 */
export function evaluateAndRecordHarnessSubmissionTrigger(candidate, deps) {
  if (!candidate || typeof candidate !== "object") throw new Error("invalid_harness_submission_candidate");
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
      allow: decision.allow,
      reasons: decision.reasons,
      circuitBreakerTripped: decision.circuitBreakerTripped,
      consecutiveGateBlocks,
      attemptLogReference: candidate.handoffPacket.attemptLogReference ?? null,
    },
  });

  return { decision, event };
}
