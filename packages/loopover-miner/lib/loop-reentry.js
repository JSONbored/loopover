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
        if (!isDisengagedOutcome(outcomes[i]))
            break;
        count += 1;
    }
    return count;
}
/** Count prior re-entries (successful, i.e. `reentered: true`) recorded at or after `sinceMs`. */
export function countReentriesSince(eventLedger, sinceMs) {
    return eventLedger
        .readEvents({})
        .filter((event) => event.type === LOOP_REENTRY_DECISION_EVENT &&
        event.payload?.reentered === true &&
        Date.parse(event.createdAt) >= sinceMs).length;
}
/**
 * Evaluate and (if allowed) PERFORM re-entry for one resolved outcome: reads real history to compute the
 * circuit-breaker and rate-cap tallies, consults the pure `shouldReenter` policy, and -- only when it allows --
 * dequeues the next candidate and transitions run-state to `"discovering"`. Always appends exactly one audit
 * event. Fails closed (throws) on a malformed candidate or missing required dependency, mirroring
 * `recordManagePollSnapshot`'s own validation style.
 */
export function attemptLoopReentry(candidate, deps) {
    if (!candidate || typeof candidate !== "object")
        throw new Error("invalid_loop_reentry_candidate");
    if (!["global", "repo", "none"].includes(candidate.killSwitchScope))
        throw new Error("invalid_kill_switch_scope");
    const repoFullName = typeof candidate.repoFullName === "string" ? candidate.repoFullName.trim() : "";
    if (!repoFullName)
        throw new Error("invalid_repo_full_name");
    if (!["merged", "disengaged", "other"].includes(candidate.outcome))
        throw new Error("invalid_outcome");
    if (!deps || typeof deps !== "object")
        throw new Error("invalid_loop_reentry_deps");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9vcC1yZWVudHJ5LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9vcC1yZWVudHJ5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUVqRCxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFHakQsOEdBQThHO0FBQzlHLDBHQUEwRztBQUMxRyw4RkFBOEY7QUFDOUYseUdBQXlHO0FBQ3pHLCtHQUErRztBQUMvRyxxRUFBcUU7QUFDckUsRUFBRTtBQUNGLHdHQUF3RztBQUN4RyxnSEFBZ0g7QUFDaEgsa0VBQWtFO0FBQ2xFLEVBQUU7QUFDRiwrR0FBK0c7QUFDL0csK0dBQStHO0FBQy9HLHFEQUFxRDtBQUVyRCxNQUFNLENBQUMsTUFBTSwyQkFBMkIsR0FBRyx1QkFBZ0MsQ0FBQztBQUM1RSxNQUFNLE9BQU8sR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLElBQUksQ0FBQztBQWlFL0I7OzBHQUUwRztBQUMxRyxTQUFTLG1CQUFtQixDQUFDLE9BQStDO0lBQzFFLE9BQU8sT0FBTyxFQUFFLFFBQVEsS0FBSyxRQUFRLENBQUM7QUFDeEMsQ0FBQztBQUVEOzs7R0FHRztBQUNILE1BQU0sVUFBVSw4QkFBOEIsQ0FBQyxXQUFtQyxFQUFFLFlBQW9CO0lBQ3RHLE1BQU0sUUFBUSxHQUFHLENBQUMsR0FBRyxjQUFjLENBQUMsV0FBVyxFQUFFLEVBQUUsWUFBWSxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0lBQzdFLElBQUksS0FBSyxHQUFHLENBQUMsQ0FBQztJQUNkLEtBQUssSUFBSSxDQUFDLEdBQUcsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDakQsSUFBSSxDQUFDLG1CQUFtQixDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUFF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