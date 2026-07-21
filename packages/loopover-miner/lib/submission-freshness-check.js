// Late-binding freshness check before open_pr fires (#3007). A soft-claim made at the start of a long
// create/iterate loop can go stale by the time a candidate reaches submission: the target issue may have been
// closed, already fixed by another author, or the miner's own claim may have been released/expired in the
// interim. This is a FINAL, read-only check immediately before open_pr spec construction -- complementing, not
// replacing, the claim-time check (src/miner/soft-claim.ts) -- so a stale submission never reaches the Governor
// chokepoint (governor-chokepoint.js) as a live write attempt: check freshness first, THEN prepareOpenPrSubmission
// (harness-submission-trigger.js), THEN the Governor. These are separate, sequentially-composed units, not nested
// calls -- attempt-runner.js (#2337) is the real call site that wires them together in that order.
//
// READ-ONLY BY CONTRACT: never writes anything except its own abort-reason audit event (on staleness only, not
// on every check -- mirrors this issue's own "log the abort reason" wording, not a per-decision audit trail).
// The live-state fetch is an injected dependency so this stays testable without real network I/O and agnostic
// to HOW the caller sources issue/PR state (raw GitHub API, loopover's own cached MCP data, etc.).
//
// FAIL CLOSED: an unreachable/failed live-state fetch is treated as stale (aborts), never as "no evidence of
// staleness, so proceed" -- mirrors this package's fail-closed convention elsewhere (harness-submission-
// trigger.js's predicted_gate_unavailable/slop_assessment_unavailable, iterate-loop.ts's ambiguous-on-error).
// That fail-closed OUTCOME is unchanged; a single transient blip just gets a bounded retry-with-backoff to
// resolve itself FIRST (#7089) -- the same window claim-conflict-resolver.js's resolveClaimConflict (#6058)
// already gives its own call to this identical fetchLiveIssueSnapshot, reusing http-retry.js's shared backoff.
// Aborting here discards a fully-completed create/iterate loop's local work, so riding out a brief 5xx /
// GraphQL-index propagation lag before failing closed matters more here than in the post-submission case.
//
// NOT a rejection outcome: staleness is caught BEFORE any PR exists, so it is not the same lifecycle event as
// rejection-state-machine.js's DISENGAGED_OUTCOME (which handles an EXISTING PR a maintainer closed). "No PR,
// no noisy failure" here just means: return a quiet not-fresh result, same shape as any other blocked gate
// decision in this package -- never throw, never surface anything to the target repo.
import { defaultRetryBackoffMs } from "./http-retry.js";
export const SUBMISSION_FRESHNESS_ABORT_EVENT = "submission_freshness_abort";
// Bounded retry for the pre-submission live-state fetch (#7089), mirroring claim-conflict-resolver.js's
// resolveClaimConflict (#6058): a few attempts with exponential backoff let a transient GitHub blur (a brief
// 5xx, or GraphQL-index propagation lag) resolve itself before we fail closed, without an unbounded loop.
const DEFAULT_SNAPSHOT_MAX_ATTEMPTS = 3;
const defaultSnapshotSleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
/**
 * Evaluate whether a submission candidate's live repo state is still fresh enough to proceed toward open_pr.
 * Checks the miner's own claim-ledger status first (local, free) before spending a network round-trip on the
 * live issue/PR snapshot. Fails closed (throws) on a malformed candidate or missing dependency.
 *
 * Bounded retry for the live-state snapshot fetch (#7089): up to `maxAttempts` (default 3) attempts with
 * `backoffMs(attempt)` backoff between them, returning as soon as a real (non-null, well-formed) snapshot is
 * obtained. Optional -- every existing caller works unchanged. Pure over the injected `sleepFn`/`backoffMs`
 * -- no real timers in tests. Only the fetch itself is retried; a well-formed snapshot's own signals
 * (issue_closed / already_addressed) are decided once, never retried.
 */
export async function checkSubmissionFreshness(candidate, deps, options = {}) {
    if (!candidate || typeof candidate !== "object")
        throw new Error("invalid_freshness_candidate");
    const repoFullName = typeof candidate.repoFullName === "string" ? candidate.repoFullName.trim() : "";
    if (!repoFullName)
        throw new Error("invalid_repo_full_name");
    if (!Number.isInteger(candidate.issueNumber) || candidate.issueNumber < 1)
        throw new Error("invalid_issue_number");
    const minerLogin = typeof candidate.minerLogin === "string" ? candidate.minerLogin.trim() : "";
    if (!minerLogin)
        throw new Error("invalid_miner_login");
    if (!deps || typeof deps !== "object")
        throw new Error("invalid_freshness_deps");
    const { claimLedger, fetchLiveIssueSnapshot, eventLedger } = deps;
    if (!claimLedger || typeof claimLedger.listClaims !== "function")
        throw new Error("invalid_claim_ledger");
    if (typeof fetchLiveIssueSnapshot !== "function")
        throw new Error("invalid_live_state_fetcher");
    if (!eventLedger || typeof eventLedger.appendEvent !== "function")
        throw new Error("invalid_event_ledger");
    const maxAttempts = Number.isFinite(options.maxAttempts) && options.maxAttempts >= 1
        ? Math.floor(options.maxAttempts)
        : DEFAULT_SNAPSHOT_MAX_ATTEMPTS;
    const sleepFn = typeof options.sleepFn === "function" ? options.sleepFn : defaultSnapshotSleep;
    const backoffMs = typeof options.backoffMs === "function" ? options.backoffMs : defaultRetryBackoffMs;
    const claim = claimLedger.listClaims({ repoFullName }).find((c) => c.issueNumber === candidate.issueNumber);
    if (!claim || claim.status !== "active") {
        return abort(eventLedger, repoFullName, candidate.issueNumber, "claim_superseded");
    }
    let snapshot = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let current;
        try {
            current = await fetchLiveIssueSnapshot(repoFullName, candidate.issueNumber);
        }
        catch {
            current = null;
        }
        if (current && typeof current === "object") {
            // A real, well-formed snapshot resolves the transient window: stop retrying and decide on it now.
            snapshot = current;
            break;
        }
        // Back off before the next attempt (transient 5xx / index-propagation lag); never after the last one.
        if (attempt < maxAttempts)
            await sleepFn(backoffMs(attempt));
    }
    if (!snapshot) {
        // Retry budget exhausted with no usable snapshot -- fail closed exactly as before (#7089 only widens the window).
        return abort(eventLedger, repoFullName, candidate.issueNumber, "live_state_unavailable");
    }
    if (snapshot.state === "closed") {
        return abort(eventLedger, repoFullName, candidate.issueNumber, "issue_closed");
    }
    // GitHub logins are case-insensitive for identity purposes (the same account can be echoed back with
    // different casing by different API responses), so a strict `!==` would misclassify the miner's own
    // referencing PR as "another author" whenever the casing happens to differ -- compare case-normalized.
    const minerLoginKey = minerLogin.toLowerCase();
    const referencingPrs = Array.isArray(snapshot.referencingPrs) ? snapshot.referencingPrs : [];
    const addressedByAnotherAuthor = referencingPrs.some((pr) => (pr.state === "merged" || pr.state === "open") &&
        (typeof pr.authorLogin !== "string" || pr.authorLogin.trim().toLowerCase() !== minerLoginKey));
    if (addressedByAnotherAuthor) {
        return abort(eventLedger, repoFullName, candidate.issueNumber, "already_addressed");
    }
    return { fresh: true };
}
function abort(eventLedger, repoFullName, issueNumber, reason) {
    eventLedger.appendEvent({
        type: SUBMISSION_FRESHNESS_ABORT_EVENT,
        repoFullName,
        payload: { issueNumber, reason },
    });
    return { fresh: false, reason };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3VibWlzc2lvbi1mcmVzaG5lc3MtY2hlY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzdWJtaXNzaW9uLWZyZXNobmVzcy1jaGVjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxzR0FBc0c7QUFDdEcsOEdBQThHO0FBQzlHLDBHQUEwRztBQUMxRywrR0FBK0c7QUFDL0csZ0hBQWdIO0FBQ2hILG1IQUFtSDtBQUNuSCxrSEFBa0g7QUFDbEgsbUdBQW1HO0FBQ25HLEVBQUU7QUFDRiwrR0FBK0c7QUFDL0csOEdBQThHO0FBQzlHLDhHQUE4RztBQUM5RyxtR0FBbUc7QUFDbkcsRUFBRTtBQUNGLDZHQUE2RztBQUM3Ryx5R0FBeUc7QUFDekcsOEdBQThHO0FBQzlHLDJHQUEyRztBQUMzRyw0R0FBNEc7QUFDNUcsK0dBQStHO0FBQy9HLHlHQUF5RztBQUN6RywwR0FBMEc7QUFDMUcsRUFBRTtBQUNGLDhHQUE4RztBQUM5Ryw4R0FBOEc7QUFDOUcsMkdBQTJHO0FBQzNHLHNGQUFzRjtBQUV0RixPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUV4RCxNQUFNLENBQUMsTUFBTSxnQ0FBZ0MsR0FBRyw0QkFBcUMsQ0FBQztBQXFDdEYsd0dBQXdHO0FBQ3hHLDZHQUE2RztBQUM3RywwR0FBMEc7QUFDMUcsTUFBTSw2QkFBNkIsR0FBRyxDQUFDLENBQUM7QUFDeEMsTUFBTSxvQkFBb0IsR0FBRyxDQUFDLE9BQWUsRUFBaUIsRUFBRSxDQUFDLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxVQUFVLENBQUMsT0FBTyxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFFeEg7Ozs7Ozs7Ozs7R0FVRztBQUNILE1BQU0sQ0FBQyxLQUFLLFVBQVUsd0JBQXdCLENBQzVDLFNBQXVDLEVBQ3ZDLElBQTZCLEVBQzdCLFVBQTJDLEVBQUU7SUFFN0MsSUFBSSxDQUFDLFNBQVMsSUFBSSxPQUFPLFNBQVMsS0FB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