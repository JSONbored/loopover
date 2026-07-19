import { shouldReenter } from "@loopover/engine";

import { readPrOutcomes } from "./pr-outcome.js";

// Closed-loop discovery re-entry orchestrator (#2338): the real-IO half of "on a resolved outcome (merged, or
// rejected-and-disengaged), automatically re-invoke discovery to select the next candidate." The DECISION
// itself (shouldReenter, @loopover/engine) is pure; this module owns everything that decision
// needs real state for -- reading the repo's own pr_outcome history to compute the per-repo consecutive-
// disengagement tally, reading recent re-entry events for the hourly/session rate cap, and (only when allowed)
// actually dequeuing the next candidate and transitioning run-state.
//
// NOT WIRED INTO ANY AUTOMATIC SCHEDULE: per this issue's own "manual owner sign-off before enabling by
// default in any profile" deliverable, this is a callable function ready for that sign-off -- it is not invoked
// by manage-poll.js or any cron/scheduler as part of this change.
//
// AUDITABILITY: every call appends exactly one `loop_reentry_decision` event to the ledger, whether or not the
// decision allowed re-entry, so the full decision trail (including every suppressed re-entry and why) survives
// independently of this function's own return value.

export const LOOP_REENTRY_DECISION_EVENT = "loop_reentry_decision";
const HOUR_MS = 60 * 60 * 1000;

/** A `pr_outcome` "closed" decision is this module's practical proxy for "disengaged" -- pr-outcome.js's own
 *  vocabulary is exactly `"merged" | "closed"` (no separate "disengaged" literal); a PR that closed without
 *  merging IS the rejected/disengaged case rejection-state-machine.js's own `isRejectedPr` checks for. */
function isDisengagedOutcome(outcome) {
  return outcome?.decision === "closed";
}

/**
 * Count a repo's CONSECUTIVE disengaged (closed-without-merge) PR outcomes, walking backward from the most
 * recently recorded PR for that repo until a merged outcome breaks the streak (or history runs out).
 */
export function countConsecutiveDisengagements(eventLedger, repoFullName) {
  const outcomes = [...readPrOutcomes(eventLedger, { repoFullName }).values()];
  let count = 0;
  for (let i = outcomes.length - 1; i >= 0; i -= 1) {
    if (!isDisengagedOutcome(outcomes[i])) break;
    count += 1;
  }
  return count;
}

/** Count prior re-entries (successful, i.e. `reentered: true`) recorded at or after `sinceMs`. */
export function countReentriesSince(eventLedger, sinceMs) {
  return eventLedger
    .readEvents({})
    .filter((event) => event.type === LOOP_REENTRY_DECISION_EVENT && event.payload?.reentered === true && Date.parse(event.createdAt) >= sinceMs)
    .length;
}

/**
 * Evaluate and (if allowed) PERFORM re-entry for one resolved outcome: reads real history to compute the
 * circuit-breaker and rate-cap tallies, consults the pure `shouldReenter` policy, and -- only when it allows --
 * dequeues the next candidate and transitions run-state to `"discovering"`. Always appends exactly one audit
 * event. Fails closed (throws) on a malformed candidate or missing required dependency, mirroring
 * `recordManagePollSnapshot`'s own validation style.
 *
 * @param {{ killSwitchScope: "global"|"repo"|"none", repoFullName: string, outcome: "merged"|"disengaged"|"other", maxConsecutiveDisengagements?: number, maxReentriesPerHour?: number, maxReentriesPerSession?: number }} candidate
 * @param {{ eventLedger: object, portfolioQueue: object, runState?: object, nowMs?: number, sessionStartMs?: number }} deps
 */
export function attemptLoopReentry(candidate, deps) {
  if (!candidate || typeof candidate !== "object") throw new Error("invalid_loop_reentry_candidate");
  if (!["global", "repo", "none"].includes(candidate.killSwitchScope)) throw new Error("invalid_kill_switch_scope");
  const repoFullName = typeof candidate.repoFullName === "string" ? candidate.repoFullName.trim() : "";
  if (!repoFullName) throw new Error("invalid_repo_full_name");
  if (!["merged", "disengaged", "other"].includes(candidate.outcome)) throw new Error("invalid_outcome");

  if (!deps || typeof deps !== "object") throw new Error("invalid_loop_reentry_deps");
  const { eventLedger, portfolioQueue, runState, nowMs = Date.now(), sessionStartMs = 0 } = deps;
  if (!eventLedger || typeof eventLedger.appendEvent !== "function" || typeof eventLedger.readEvents !== "function") {
    throw new Error("invalid_event_ledger");
  }
  if (!portfolioQueue || typeof portfolioQueue.dequeueNext !== "function") {
    throw new Error("invalid_portfolio_queue");
  }

  const consecutiveDisengagements = countConsecutiveDisengagements(eventLedger, repoFullName);
  const reentriesThisHour = countReentriesSince(eventLedger, nowMs - HOUR_MS);
  const reentriesThisSession = countReentriesSince(eventLedger, sessionStartMs);

  const decision = shouldReenter({
    killSwitchScope: candidate.killSwitchScope,
    repoFullName,
    outcome: candidate.outcome,
    consecutiveDisengagements,
    maxConsecutiveDisengagements: candidate.maxConsecutiveDisengagements,
    reentriesThisHour,
    maxReentriesPerHour: candidate.maxReentriesPerHour,
    reentriesThisSession,
    maxReentriesPerSession: candidate.maxReentriesPerSession,
  });

  let dequeued = null;
  if (decision.reenter) {
    dequeued = portfolioQueue.dequeueNext();
    if (runState && typeof runState.setRunState === "function") {
      runState.setRunState(repoFullName, "discovering");
    }
  }

  const event = eventLedger.appendEvent({
    type: LOOP_REENTRY_DECISION_EVENT,
    repoFullName,
    payload: {
      killSwitchScope: candidate.killSwitchScope,
      outcome: candidate.outcome,
      reentered: decision.reenter,
      reasons: decision.reasons,
      consecutiveDisengagements,
      reentriesThisHour,
      reentriesThisSession,
      dequeuedIdentifier: dequeued ? dequeued.identifier : null,
      // The just-completed cycle's read-only summary (loop-closure.js's buildLoopClosureSummary), when the
      // caller supplies one -- threaded through verbatim for audit traceability. Optional: the circuit-breaker
      // and rate-cap tallies above are computed directly from pr-outcome/event-ledger history (a
      // LoopClosureSummary's own byType COUNTS aren't detailed enough to derive a per-repo consecutive-
      // disengagement streak from), so this is context, not a computational input.
      loopSummary: deps.loopSummary ?? null,
    },
  });

  return { decision, dequeued, event };
}
