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
    // Runtime guards retained from the JS (tests may cast malformed inputs past the public types).
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
    // Cast: public optional fields omit `| undefined`; engine accepts `number | undefined` under EOPT.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9vcC1yZWVudHJ5LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9vcC1yZWVudHJ5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUVqRCxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFFakQsOEdBQThHO0FBQzlHLDBHQUEwRztBQUMxRyw4RkFBOEY7QUFDOUYseUdBQXlHO0FBQ3pHLCtHQUErRztBQUMvRyxxRUFBcUU7QUFDckUsRUFBRTtBQUNGLHdHQUF3RztBQUN4RyxnSEFBZ0g7QUFDaEgsa0VBQWtFO0FBQ2xFLEVBQUU7QUFDRiwrR0FBK0c7QUFDL0csK0dBQStHO0FBQy9HLHFEQUFxRDtBQUVyRCxNQUFNLENBQUMsTUFBTSwyQkFBMkIsR0FBRyx1QkFBZ0MsQ0FBQztBQUM1RSxNQUFNLE9BQU8sR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLElBQUksQ0FBQztBQWlGL0I7OzBHQUUwRztBQUMxRyxTQUFTLG1CQUFtQixDQUFDLE9BQWtEO0lBQzdFLE9BQU8sT0FBTyxFQUFFLFFBQVEsS0FBSyxRQUFRLENBQUM7QUFDeEMsQ0FBQztBQUVEOzs7R0FHRztBQUNILE1BQU0sVUFBVSw4QkFBOEIsQ0FDNUMsV0FBbUMsRUFDbkMsWUFBb0I7SUFFcEIsTUFBTSxRQUFRLEdBQUcsQ0FBQyxHQUFHLGNBQWMsQ0FBQyxXQUFXLEVBQUUsRUFBRSxZQUFZLEVBQUUsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDN0UsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDO0lBQ2QsS0FBSyxJQUFJLENBQUMsR0FBRyxRQUFRLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNqRCxJQUFJLENBQUMsbUJBQW1CLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lB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