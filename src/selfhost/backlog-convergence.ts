import type { PullRequestRecord } from "../types";

// Self-host backlog-convergence sweeper: a durable catch-all for open PRs whose public review surface (the
// gate comment/check-run/label) was never published for their CURRENT head — the case the periodic re-gate
// sweep (agent-sweep.ts) can silently miss. That sweep stamps `lastRegatedAt` for every candidate at FAN-OUT
// time, before its downstream per-PR job actually runs (#audit-sweep-dispatch-stamp, deliberately, so the
// in-flight guard engages immediately) — so a per-PR job that then fails, dead-letters, or never completes
// leaves the PR looking "freshly regated" even though its surface was never actually published. Because
// `selectRegateCandidates` sorts by `lastRegatedAt`, such a PR now looks FRESH and won't be re-picked by the
// normal sweep again for a full cycle. This module's ONE signal — `lastPublishedSurfaceSha` mismatched (or
// missing) against the live head — is immune to that blind spot: it is stamped only on a genuinely completed
// publish (`markPullRequestSurfacePublished`), never optimistically. Pure helpers; the queue processor stays a
// thin orchestration shell, mirroring agent-sweep.ts.

// Bounded per repo per sweep, same REST-budget rationale as SWEEP_MAX_PRS (agent-sweep.ts): each fanned-out
// `agent-regate-pr` job costs several GitHub REST calls, and this sweeper's own claim-time priority (see
// queue-fairness.ts, PR2) means its output already competes ahead of fresh webhook work — a large cap here
// would starve fresh PR intake, not just old backlog. Deliberately smaller than SWEEP_MAX_PRS's original
// (pre-#audit-rate-headroom) ceiling: this sweep exists to repair a rarer stranding, not to be the primary
// convergence path.
export const BACKLOG_CONVERGENCE_SWEEP_MAX_PRS = 5;

/**
 * True when `pr`'s current head has never had its public review surface published — either no publish has
 * ever completed (`lastPublishedSurfaceSha` unset) or the live head has moved past the last completed publish.
 * A PR with no known `headSha` cannot be usefully evaluated (nothing to compare against) and is never flagged.
 * Pure.
 */
export function needsSurfaceConvergence(pr: Pick<PullRequestRecord, "headSha" | "lastPublishedSurfaceSha">): boolean {
  if (!pr.headSha) return false;
  return pr.lastPublishedSurfaceSha !== pr.headSha;
}

/**
 * Select the open PRs a single repo's backlog-convergence sweep should re-enqueue: drop drafts and anything
 * whose surface is already published at the current head, then take the `max` PRs that have been open longest
 * (oldest `createdAt` first, falling back to the epoch so a PR with no known creation time still sorts
 * deterministically rather than being silently dropped) — this is the explicit "oldest open PRs first" fairness
 * ordering the backlog-drain lane depends on (see queue-fairness.ts, PR2). Ties broken by PR number. Pure +
 * deterministic: same inputs -> same ordered batch.
 */
export function selectBacklogConvergenceCandidates(input: {
  pulls: PullRequestRecord[];
  max?: number;
}): PullRequestRecord[] {
  const max = input.max ?? BACKLOG_CONVERGENCE_SWEEP_MAX_PRS;
  const ageKey = (pr: PullRequestRecord): number => {
    const created = pr.createdAt ? Date.parse(pr.createdAt) : Number.NaN;
    return Number.isFinite(created) ? created : 0;
  };
  return input.pulls
    .filter((pr) => pr.state === "open" && !pr.isDraft)
    .filter((pr) => needsSurfaceConvergence(pr))
    .sort((a, b) => ageKey(a) - ageKey(b) || a.number - b.number)
    .slice(0, Math.max(0, max));
}
