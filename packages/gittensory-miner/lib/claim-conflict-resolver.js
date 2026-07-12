// Real claim-conflict resolution (#4848): the missing piece over claim-adjudication.js's own adjudicator,
// which is correct and well-tested in isolation but has no caller that assembles a REAL competing-claims set.
// checkSubmissionFreshness (submission-freshness-check.js) already catches the common case pre-submission --
// aborting before open_pr if another author's PR already references the issue -- but that check can only see
// what's PUBLIC at the moment it runs. Two miners racing closely enough that BOTH pass their own freshness
// check before either's PR exists yet is a genuine TOCTOU window freshness cannot close. This module is the
// POST-submission reconciliation for exactly that window: once THIS miner's PR is real and public, check
// whether ANOTHER open PR also claims the same issue and, if this miner's claim loses the election, close its
// own just-opened PR (never anyone else's) -- the write action the contributor-vs-maintainer safety framework
// keeps maintainer-only (#4833's own scope note), since it means the autonomous loop acts on a race-resolution
// decision with no human review.
//
// CLAIM-TIME ASYMMETRY (documented, not accidental): `self`'s claimedAt is the miner's OWN real local
// claim-ledger timestamp (claim-ledger.js, recorded before work even started). A competing PR's claimedAt uses
// its real GitHub `createdAt` instead -- the maintainer gate's own duplicate-winner election uses gittensory
// server's "first observed this PR's linked-issue set" timestamp, but that requires a continuous, persistent
// observation history this stateless client-side tool does not have for a PR it doesn't own. `createdAt` is
// the best real, publicly-observable proxy available for someone else's PR -- live-issue-snapshot.js's own
// comment on `createdAt` explains this in more detail.
//
// EVENTUAL CONSISTENCY: this checks GitHub's live state immediately after submission. A competing PR that
// exists but hasn't yet propagated through GitHub's own search/GraphQL indexing in that instant would be
// invisible to this one-shot check -- there is no retry/backoff here, which would be its own separate scope.

import { adjudicateSoftClaim } from "./claim-adjudication.js";
import { buildClosePrSpec } from "@jsonbored/gittensory-engine";

/**
 * Assemble the real competing-claims set from a fetched LiveIssueSnapshot: every OTHER open PR referencing
 * the issue, excluding `selfPrNumber` and any PR authored by `minerLogin` itself (case-insensitive, mirrors
 * checkSubmissionFreshness's own author comparison -- a login can be echoed back with different casing).
 * Pure given its inputs.
 *
 * @param {import("./submission-freshness-check.js").LiveIssueSnapshot | null | undefined} snapshot
 * @param {number} selfPrNumber
 * @param {string} minerLogin
 * @returns {import("./claim-adjudication.js").ObservedClaim[]}
 */
export function assembleCompetingClaims(snapshot, selfPrNumber, minerLogin) {
  const minerLoginKey = minerLogin.trim().toLowerCase();
  const referencingPrs = Array.isArray(snapshot?.referencingPrs) ? snapshot.referencingPrs : [];
  return referencingPrs
    .filter((pr) => pr.state === "open" && pr.number !== selfPrNumber)
    .filter((pr) => typeof pr.authorLogin !== "string" || pr.authorLogin.trim().toLowerCase() !== minerLoginKey)
    .map((pr) => ({ number: pr.number, claimedAt: pr.createdAt ?? null }));
}

/**
 * Resolve a real claim conflict for an already-submitted PR. Fails OPEN (never closes anything) when the live
 * snapshot can't be fetched -- an unavailable check is not evidence of a lost claim.
 *
 * @param {{ repoFullName: string, issueNumber: number, selfPrNumber: number, selfClaimedAt: string | null, minerLogin: string }} input
 * @param {{
 *   fetchLiveIssueSnapshot: (repoFullName: string, issueNumber: number) => Promise<import("./submission-freshness-check.js").LiveIssueSnapshot | null>,
 *   executeLocalWrite: (spec: import("@jsonbored/gittensory-engine").LocalWriteActionSpec) => Promise<unknown>,
 * }} deps
 * @returns {Promise<{
 *   checked: boolean,
 *   reason?: "live_state_unavailable",
 *   isWinner?: boolean,
 *   winnerNumber?: number | null,
 *   competingCount?: number,
 *   closeResult?: unknown,
 * }>}
 */
export async function resolveClaimConflict(input, deps) {
  let snapshot;
  try {
    snapshot = await deps.fetchLiveIssueSnapshot(input.repoFullName, input.issueNumber);
  } catch {
    snapshot = null;
  }
  if (!snapshot || typeof snapshot !== "object") {
    return { checked: false, reason: "live_state_unavailable" };
  }

  const competing = assembleCompetingClaims(snapshot, input.selfPrNumber, input.minerLogin);
  const adjudication = adjudicateSoftClaim({ number: input.selfPrNumber, claimedAt: input.selfClaimedAt }, competing);

  if (adjudication.isWinner) {
    return { checked: true, isWinner: true, winnerNumber: adjudication.winnerNumber, competingCount: competing.length };
  }

  const comment = adjudication.winnerNumber
    ? `Closing this PR: pull request #${adjudication.winnerNumber} claimed this issue first. This is an automated soft-claim conflict resolution -- no action needed from you.`
    : `Closing this PR: another open pull request already claims this issue. This is an automated soft-claim conflict resolution -- no action needed from you.`;
  const spec = buildClosePrSpec({ repoFullName: input.repoFullName, number: input.selfPrNumber, comment });
  const closeResult = await deps.executeLocalWrite(spec);

  return {
    checked: true,
    isWinner: false,
    winnerNumber: adjudication.winnerNumber,
    competingCount: competing.length,
    closeResult,
  };
}
