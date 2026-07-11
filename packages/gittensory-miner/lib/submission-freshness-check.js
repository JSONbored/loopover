// Late-binding freshness check before open_pr fires (#3007). A soft-claim made at the start of a long
// create/iterate loop can go stale by the time a candidate reaches submission: the target issue may have been
// closed, already fixed by another author, or the miner's own claim may have been released/expired in the
// interim. This is a FINAL, read-only check immediately before open_pr spec construction -- complementing, not
// replacing, the claim-time check (src/miner/soft-claim.ts) -- so a stale submission never reaches the Governor
// chokepoint (governor-chokepoint.js) as a live write attempt: check freshness first, THEN prepareOpenPrSubmission
// (harness-submission-trigger.js), THEN the Governor. These are separate, sequentially-composed units, not nested
// calls -- a future real call site wires them together in that order.
//
// READ-ONLY BY CONTRACT: never writes anything except its own abort-reason audit event (on staleness only, not
// on every check -- mirrors this issue's own "log the abort reason" wording, not a per-decision audit trail).
// The live-state fetch is an injected dependency so this stays testable without real network I/O and agnostic
// to HOW the caller sources issue/PR state (raw GitHub API, gittensory's own cached MCP data, etc.).
//
// FAIL CLOSED: an unreachable/failed live-state fetch is treated as stale (aborts), never as "no evidence of
// staleness, so proceed" -- mirrors this package's fail-closed convention elsewhere (harness-submission-
// trigger.js's predicted_gate_unavailable/slop_assessment_unavailable, iterate-loop.ts's ambiguous-on-error).
//
// NOT a rejection outcome: staleness is caught BEFORE any PR exists, so it is not the same lifecycle event as
// rejection-state-machine.js's DISENGAGED_OUTCOME (which handles an EXISTING PR a maintainer closed). "No PR,
// no noisy failure" here just means: return a quiet not-fresh result, same shape as any other blocked gate
// decision in this package -- never throw, never surface anything to the target repo.

export const SUBMISSION_FRESHNESS_ABORT_EVENT = "submission_freshness_abort";

/**
 * Evaluate whether a submission candidate's live repo state is still fresh enough to proceed toward open_pr.
 * Checks the miner's own claim-ledger status first (local, free) before spending a network round-trip on the
 * live issue/PR snapshot. Fails closed (throws) on a malformed candidate or missing dependency.
 *
 * @param {{ repoFullName: string, issueNumber: number, minerLogin: string }} candidate
 * @param {{
 *   claimLedger: { listClaims(filter: { repoFullName?: string, status?: string }): Array<{ repoFullName: string, issueNumber: number, status: string }> },
 *   fetchLiveIssueSnapshot: (repoFullName: string, issueNumber: number) => Promise<{ state: "open"|"closed", referencingPrs: Array<{ number: number, state: "open"|"closed"|"merged", authorLogin: string }> } | null>,
 *   eventLedger: { appendEvent(event: { type: string, repoFullName?: string, payload: Record<string, unknown> }): unknown },
 * }} deps
 */
export async function checkSubmissionFreshness(candidate, deps) {
  if (!candidate || typeof candidate !== "object") throw new Error("invalid_freshness_candidate");
  const repoFullName = typeof candidate.repoFullName === "string" ? candidate.repoFullName.trim() : "";
  if (!repoFullName) throw new Error("invalid_repo_full_name");
  if (!Number.isInteger(candidate.issueNumber) || candidate.issueNumber < 1) throw new Error("invalid_issue_number");
  const minerLogin = typeof candidate.minerLogin === "string" ? candidate.minerLogin.trim() : "";
  if (!minerLogin) throw new Error("invalid_miner_login");

  if (!deps || typeof deps !== "object") throw new Error("invalid_freshness_deps");
  const { claimLedger, fetchLiveIssueSnapshot, eventLedger } = deps;
  if (!claimLedger || typeof claimLedger.listClaims !== "function") throw new Error("invalid_claim_ledger");
  if (typeof fetchLiveIssueSnapshot !== "function") throw new Error("invalid_live_state_fetcher");
  if (!eventLedger || typeof eventLedger.appendEvent !== "function") throw new Error("invalid_event_ledger");

  const claim = claimLedger.listClaims({ repoFullName }).find((c) => c.issueNumber === candidate.issueNumber);
  if (!claim || claim.status !== "active") {
    return abort(eventLedger, repoFullName, candidate.issueNumber, "claim_superseded");
  }

  let snapshot;
  try {
    snapshot = await fetchLiveIssueSnapshot(repoFullName, candidate.issueNumber);
  } catch {
    snapshot = null;
  }
  if (!snapshot || typeof snapshot !== "object") {
    return abort(eventLedger, repoFullName, candidate.issueNumber, "live_state_unavailable");
  }

  if (snapshot.state === "closed") {
    return abort(eventLedger, repoFullName, candidate.issueNumber, "issue_closed");
  }

  const referencingPrs = Array.isArray(snapshot.referencingPrs) ? snapshot.referencingPrs : [];
  const addressedByAnotherAuthor = referencingPrs.some(
    (pr) => pr.authorLogin !== minerLogin && (pr.state === "merged" || pr.state === "open"),
  );
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
