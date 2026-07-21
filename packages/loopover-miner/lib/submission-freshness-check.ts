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

export const SUBMISSION_FRESHNESS_ABORT_EVENT = "submission_freshness_abort" as const;

export type FreshnessAbortReason = "issue_closed" | "already_addressed" | "claim_superseded" | "live_state_unavailable";

export type SubmissionFreshnessCandidate = {
  repoFullName: string;
  issueNumber: number;
  minerLogin: string;
};

export type LiveIssueSnapshot = {
  state: "open" | "closed";
  referencingPrs: Array<{ number: number; state: "open" | "closed" | "merged"; authorLogin: string; createdAt: string | null }>;
};

export type SubmissionFreshnessClaimLedger = {
  listClaims(filter: { repoFullName?: string; status?: string }): Array<{ repoFullName: string; issueNumber: number; status: string }>;
};

export type SubmissionFreshnessEventLedger = {
  appendEvent(event: { type: string; repoFullName?: string; payload: Record<string, unknown> }): unknown;
};

export type SubmissionFreshnessDeps = {
  claimLedger: SubmissionFreshnessClaimLedger;
  fetchLiveIssueSnapshot: (repoFullName: string, issueNumber: number) => Promise<LiveIssueSnapshot | null>;
  eventLedger: SubmissionFreshnessEventLedger;
};

export type SubmissionFreshnessResult = { fresh: true } | { fresh: false; reason: FreshnessAbortReason };

export type SubmissionFreshnessRetryOptions = {
  maxAttempts?: number;
  sleepFn?: (ms: number) => Promise<unknown>;
  backoffMs?: (attempt: number) => number;
};

// Bounded retry for the pre-submission live-state fetch (#7089), mirroring claim-conflict-resolver.js's
// resolveClaimConflict (#6058): a few attempts with exponential backoff let a transient GitHub blur (a brief
// 5xx, or GraphQL-index propagation lag) resolve itself before we fail closed, without an unbounded loop.
const DEFAULT_SNAPSHOT_MAX_ATTEMPTS = 3;
const defaultSnapshotSleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

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
export async function checkSubmissionFreshness(
  candidate: SubmissionFreshnessCandidate,
  deps: SubmissionFreshnessDeps,
  options: SubmissionFreshnessRetryOptions = {},
): Promise<SubmissionFreshnessResult> {
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

  const maxAttempts =
    Number.isFinite(options.maxAttempts) && (options.maxAttempts as number) >= 1
      ? Math.floor(options.maxAttempts as number)
      : DEFAULT_SNAPSHOT_MAX_ATTEMPTS;
  const sleepFn = typeof options.sleepFn === "function" ? options.sleepFn : defaultSnapshotSleep;
  const backoffMs = typeof options.backoffMs === "function" ? options.backoffMs : defaultRetryBackoffMs;

  const claim = claimLedger.listClaims({ repoFullName }).find((c) => c.issueNumber === candidate.issueNumber);
  if (!claim || claim.status !== "active") {
    return abort(eventLedger, repoFullName, candidate.issueNumber, "claim_superseded");
  }

  let snapshot: LiveIssueSnapshot | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let current: LiveIssueSnapshot | null;
    try {
      current = await fetchLiveIssueSnapshot(repoFullName, candidate.issueNumber);
    } catch {
      current = null;
    }
    if (current && typeof current === "object") {
      // A real, well-formed snapshot resolves the transient window: stop retrying and decide on it now.
      snapshot = current;
      break;
    }
    // Back off before the next attempt (transient 5xx / index-propagation lag); never after the last one.
    if (attempt < maxAttempts) await sleepFn(backoffMs(attempt));
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
  const addressedByAnotherAuthor = referencingPrs.some(
    (pr) =>
      (pr.state === "merged" || pr.state === "open") &&
      (typeof pr.authorLogin !== "string" || pr.authorLogin.trim().toLowerCase() !== minerLoginKey),
  );
  if (addressedByAnotherAuthor) {
    return abort(eventLedger, repoFullName, candidate.issueNumber, "already_addressed");
  }

  return { fresh: true };
}

function abort(
  eventLedger: SubmissionFreshnessEventLedger,
  repoFullName: string,
  issueNumber: number,
  reason: FreshnessAbortReason,
): { fresh: false; reason: FreshnessAbortReason } {
  eventLedger.appendEvent({
    type: SUBMISSION_FRESHNESS_ABORT_EVENT,
    repoFullName,
    payload: { issueNumber, reason },
  });
  return { fresh: false, reason };
}
