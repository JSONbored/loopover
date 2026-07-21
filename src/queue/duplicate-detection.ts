// Duplicate-cluster winner adjudication and live-sibling reconciliation (#4013 step 3 -- extracted from
// processors.ts, third step of the file's own module-split sequence, after transient-locks.ts and
// signal-snapshot.ts). Pure move; the one admission-key computation reconcileLiveDuplicateSiblings needs is
// inlined directly from githubRateLimitAdmissionKeyForToken rather than importing processors.ts's own
// wrapper (githubAdmissionKeyForToken, still used at its other ~13 call sites there) -- that wrapper is a
// one-line arg-reorder with no logic of its own, and importing it back would have made this file and
// processors.ts circularly dependent on each other.

import { createInstallationToken } from "../github/app";
import { fetchLivePullRequestState } from "../github/backfill";
import { githubRateLimitAdmissionKeyForToken } from "../github/client";
import { isDuplicateClusterWinnerByClaim, resolveDuplicateClusterWinnerNumber } from "../signals/duplicate-winner";
import { isDuplicateWinnerEnabledGlobally, resolveDuplicateWinnerEnabled } from "../settings/duplicate-winner-mode";
import type { PullRequestRecord, RepositorySettings } from "../types";
import { mapWithConcurrency } from "./map-with-concurrency";

/** Same order of magnitude as processors.ts's other per-item live GitHub fan-outs (#5835). */
const DUPLICATE_SIBLING_LIVE_RECONCILE_CONCURRENCY = 10;

/**
 * Duplicate-winner adjudication (#dup-winner) seam for the close-reason disposition. Given a PR's open
 * duplicate-sibling numbers (from {@link linkedIssueDuplicatePullRequestsForGate}, open-only), return the
 * `linkedDuplicateCount` the agent planner reads. When the flag is ON and this PR is the cluster winner, return
 * 0 so the winner's close reason OMITS the "duplicate of another open PR" cause (agent-actions only adds it
 * when count > 0). Flag-OFF (default) returns the real sibling count — byte-identical to today.
 */
export function dupWinnerLinkedDuplicateCount(
  openSiblings: Pick<PullRequestRecord, "number" | "linkedIssueClaimedAt" | "createdAt">[],
  prNumber: number,
  linkedIssueClaimedAt: string | null | undefined,
  duplicateWinnerEnabled: boolean,
  createdAt?: string | null | undefined,
): number {
  if (
    duplicateWinnerEnabled &&
    isDuplicateClusterWinnerByClaim({ number: prNumber, linkedIssueClaimedAt, createdAt }, openSiblings)
  )
    return 0;
  return openSiblings.length;
}

/**
 * Duplicate-winner adjudication (#dup-winner-credit) seam for naming the cluster's actual winner in a loser's
 * close comment. Returns `null` (generic "duplicate of another open PR" wording, byte-identical to before this
 * existed) when the flag is off, this PR IS the winner (nothing to name — its close reason omits the cause
 * entirely via {@link dupWinnerLinkedDuplicateCount}), or the election is too ambiguous to name a specific
 * winner ({@link resolveDuplicateClusterWinnerNumber}'s fail-closed `null`).
 */
export function dupWinnerLinkedDuplicateWinnerNumber(
  openSiblings: Pick<PullRequestRecord, "number" | "linkedIssueClaimedAt" | "createdAt">[],
  prNumber: number,
  linkedIssueClaimedAt: string | null | undefined,
  duplicateWinnerEnabled: boolean,
  createdAt?: string | null | undefined,
): number | null {
  if (!duplicateWinnerEnabled) return null;
  const winner = resolveDuplicateClusterWinnerNumber({ number: prNumber, linkedIssueClaimedAt, createdAt }, openSiblings);
  return winner === null || winner === prNumber ? null : winner;
}

/**
 * Live-reconcile the duplicate cluster's open siblings before the winner is elected (#dup-winner / audit #15).
 *
 * The stored open-PR cache ({@link listOtherOpenPullRequests}) lags GitHub: a sibling that was closed/merged on
 * GitHub but is still cached `open` would keep "winning" the duplicate cluster, demoting the true earliest
 * claimant to a loser and auto-closing it via the `duplicate_pr_risk` blocker. Duplicate-winner election is
 * claim-time based ({@link resolveDuplicateClusterWinnerNumber}, #3816): any overlapping sibling — lower or
 * higher PR number — can demote this PR if it claimed the linked issue earlier, so re-fetch the LIVE state of
 * all overlapping siblings and drop any that are no longer open. Then the downstream election
 * ({@link isDuplicateClusterWinnerByClaim}) reflects ground truth.
 *
 * FAIL-OPEN to the stored state: a sibling is dropped ONLY on a positive "not open" confirmation — an unreadable
 * live fetch keeps it, so a transient GitHub hiccup never newly spares a real loser. Flag-OFF (default), no
 * linked issues, or no overlapping sibling ⇒ returns the input unchanged with no extra API calls.
 */
export async function reconcileLiveDuplicateSiblings(
  env: Env,
  installationId: number | null,
  repoFullName: string,
  pr: PullRequestRecord,
  otherOpenPullRequests: PullRequestRecord[],
  settings: Pick<RepositorySettings, "duplicateWinnerMode">,
): Promise<PullRequestRecord[]> {
  if (!resolveDuplicateWinnerEnabled(isDuplicateWinnerEnabledGlobally(env), settings.duplicateWinnerMode)) return otherOpenPullRequests;
  const linkedIssues = new Set(pr.linkedIssues);
  if (linkedIssues.size === 0) return otherOpenPullRequests;
  const overlapping = otherOpenPullRequests.filter(
    (other) =>
      other.state === "open" &&
      other.linkedIssues.some((issue) => linkedIssues.has(issue)),
  );
  if (overlapping.length === 0) return otherOpenPullRequests;
  const installationToken =
    installationId === null
      ? undefined
      : await createInstallationToken(env, installationId).catch(
          () => undefined,
        );
  const token = installationToken ?? env.GITHUB_PUBLIC_TOKEN;
  const admissionKey = githubRateLimitAdmissionKeyForToken(env, token, installationId);
  const staleClosed = new Set<number>();
  await mapWithConcurrency(overlapping, DUPLICATE_SIBLING_LIVE_RECONCILE_CONCURRENCY, async (sibling) => {
      // #2537: deliberately NOT durable-cached (flagged by the gate's own review) -- despite recomputing every
      // delivery, this reconcile feeds duplicate-winner selection, which can auto-CLOSE the CURRENT PR when
      // duplicateWinnerEnabled. A cached "open" read up to PR_STATE_CACHE_MAX_AGE_MS stale after a missed
      // `closed` webhook would keep an already-closed sibling eligible as the winner, wrongly closing this PR
      // as the loser. That is the same class of irreversible-actuation risk the merge/close decision and
      // gate-override guard against, so this stays on the raw live fetch like they do.
      /* v8 ignore next -- fetchLivePullRequestState already catches its own errors internally (returns undefined, never rejects), so this .catch is unreachable defense-in-depth, not a live path any test can exercise. */
      const liveState = await fetchLivePullRequestState(
        env,
        repoFullName,
        sibling.number,
        token,
        admissionKey,
      ).catch(() => undefined);
      if (liveState !== undefined && liveState !== "open")
        staleClosed.add(sibling.number);
    });
  if (staleClosed.size === 0) return otherOpenPullRequests;
  return otherOpenPullRequests.filter(
    (other) => !staleClosed.has(other.number),
  );
}

export function linkedIssueDuplicatePullRequestsForGate(
  pr: PullRequestRecord,
  pullRequests: PullRequestRecord[],
): number[] {
  return linkedIssueDuplicatePullRequestRecordsForGate(pr, pullRequests).map((otherPr) => otherPr.number);
}

export function linkedIssueDuplicatePullRequestRecordsForGate(
  pr: PullRequestRecord,
  pullRequests: PullRequestRecord[],
): PullRequestRecord[] {
  const linkedIssues = new Set(pr.linkedIssues);
  if (linkedIssues.size === 0) return [];
  return [
    ...new Map(
      pullRequests.flatMap((otherPr) => {
        if (otherPr.number === pr.number || otherPr.state !== "open") return [];
        return otherPr.linkedIssues.some((issue) => linkedIssues.has(issue)) ? [[otherPr.number, otherPr] as const] : [];
      }),
    ).values(),
  ].sort((left, right) => left.number - right.number);
}
