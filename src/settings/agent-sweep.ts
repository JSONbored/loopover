import type { PullRequestRecord } from "../types";

// The scheduled re-gate sweep (#777) recomputes the gate verdict for OPEN PRs that no webhook is refreshing —
// the verdict can drift silently when the world changes under a static PR (the base advances, a sibling
// duplicate merges, the focus manifest or settings change). These pure helpers decide WHICH PRs a sweep
// recomputes so the processor stays a thin orchestration shell.

// Rate-aware ceiling: never recompute more than this many PRs per repo per sweep, so a repo with a large
// open queue cannot blow the queue-message budget. The stalest are picked first.
export const SWEEP_MAX_PRS = 25;

// Skip-if-fresh window: a PR touched within this span was almost certainly just gated by its webhook, so the
// sweep leaves it alone for that brief moment to avoid racing the in-flight webhook review. Kept SHORT (2 min)
// because the sweep is now LIGHT (re-gate + act, no AI) and runs every ~2 min — a just-approved PR must be
// re-evaluated within minutes so it MERGES once its approval registers (BLOCKED→CLEAN). One hour stranded
// approved PRs unmerged for up to an hour.
export const SWEEP_FRESHNESS_MS = 2 * 60 * 1000;

/**
 * Select the open PRs a single repo sweep should recompute: drop drafts and anything updated within
 * `freshnessWindowMs` of `now` (recently active → already gated), then take the `max` STALEST by `updatedAt`
 * ascending (a missing `updatedAt` sorts oldest — it has gone longest without a recorded refresh). Pure and
 * deterministic: same inputs → same ordered batch, which is what makes the sweep idempotent.
 */
export function selectRegateCandidates(input: {
  pulls: PullRequestRecord[];
  now: string;
  freshnessWindowMs?: number;
  max?: number;
}): PullRequestRecord[] {
  const freshnessWindowMs = input.freshnessWindowMs ?? SWEEP_FRESHNESS_MS;
  const max = input.max ?? SWEEP_MAX_PRS;
  const nowMs = Date.parse(input.now);
  const freshCutoff = Number.isFinite(nowMs) ? nowMs - freshnessWindowMs : Number.NaN;
  const staleness = (pr: PullRequestRecord): number => {
    const updated = pr.updatedAt ? Date.parse(pr.updatedAt) : Number.NaN;
    // A missing/unparseable timestamp is treated as maximally stale (epoch) so it is never starved.
    return Number.isFinite(updated) ? updated : 0;
  };
  return input.pulls
    .filter((pr) => pr.state === "open" && !pr.isDraft)
    .filter((pr) => {
      if (!Number.isFinite(freshCutoff)) return true;
      return staleness(pr) <= freshCutoff;
    })
    .sort((a, b) => staleness(a) - staleness(b) || a.number - b.number)
    .slice(0, Math.max(0, max));
}
