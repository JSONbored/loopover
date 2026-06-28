import type { PullRequestRecord } from "../types";

// The scheduled re-gate sweep (#777) recomputes the gate verdict for OPEN PRs that no webhook is refreshing —
// the verdict can drift silently when the world changes under a static PR (the base advances, a sibling
// duplicate merges, the focus manifest or settings change). These pure helpers decide WHICH PRs a sweep
// recomputes so the processor stays a thin orchestration shell.

// Rate-aware ceiling: never recompute more than this many PRs per repo per sweep, so a repo with a large
// open queue cannot blow the queue-message budget. The stalest are picked first.
//
// REST-budget sizing (#audit-rate-headroom): all managed repos share ONE GitHub App installation = ONE ~5000/hr
// REST bucket. Each fanned-out per-PR re-review costs ~9 REST GETs (1 resync `GET /pulls/{n}`, then required-
// contexts + CI aggregate in prReadyForReview, then required-contexts + merge-state + CI aggregate + files in
// auto-maintain). The sweep re-arms every ~2 min (≈30 ticks/hr) and fans out per repo, so the worst-case hourly
// sweep cost is `SWEEP_MAX_PRS × repos × 9 × 30`. At the old cap of 25 over 3 self-host repos that is ~200k/hr —
// far over budget, the cause of the `regate_sweep_throttled` exhaustion. A cap of 6 bounds the worst case to
// `6 × 3 × 9 × 30 ≈ 4.9k/hr` (and steady state is far lower — the freshness skip + the in-flight drain guard stop
// re-regating just-touched PRs), reserving headroom for webhooks. A 30-PR backlog still fully converges in
// ceil(30/6)=5 sweeps (~10 min), so no PR's merge/close is meaningfully delayed.
export const SWEEP_MAX_PRS = 6;

// Skip-if-fresh window: a PR touched within this span was almost certainly just gated by its webhook, so the
// sweep leaves it alone for that brief moment to avoid racing the in-flight webhook review. Kept SHORT (2 min)
// because the sweep is now LIGHT (re-gate + act, no AI) and runs every ~2 min — a just-approved PR must be
// re-evaluated within minutes so it MERGES once its approval registers (BLOCKED→CLEAN). One hour stranded
// approved PRs unmerged for up to an hour.
export const SWEEP_FRESHNESS_MS = 2 * 60 * 1000;

// Fan-out dedup window (#audit-fanout-dedup): a burst of fan-out jobs within this window collapses to ONE
// effective fan-out. Kept BELOW the ~2-min cron cadence so a legitimate next-tick fan-out is never skipped, but
// well above the few-seconds spread of a burst (a deploy-restart cron catch-up, or fan-out jobs that queued
// behind a per-PR backlog and drained together).
export const SWEEP_FANOUT_DEDUP_MS = 90 * 1000;

/**
 * Select the open PRs a single repo sweep should recompute: drop drafts and anything a webhook touched within
 * `freshnessWindowMs` of `now` (don't race an in-flight review), then take the `max` PRs the sweep has gone
 * longest WITHOUT re-gating — ordered by `lastRegatedAt` ascending, NOT GitHub's `updatedAt`.
 *
 * Why two different timestamps (#audit-sweep-converge): the review WRITE that bumps GitHub's `updatedAt` is
 * SUPPRESSED under dry-run / pause, so ordering the sweep by `updatedAt` pins the stalest PRs forever and it
 * never advances. The sweep instead stamps its own `lastRegatedAt` marker on every pass (a D1 write, never
 * suppressed), so a just-regated PR sorts freshest and the next pass covers the next-stalest — full coverage of
 * all open PRs in ceil(open/max) sweeps. GitHub's `updatedAt` is used ONLY for the freshness skip (a PR a
 * webhook is actively gating), never for the sort. Pure + deterministic: same inputs → same ordered batch.
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
  // Don't-race-webhook guard: a PR whose GitHub `updatedAt` is within the window was almost certainly just gated
  // by its webhook. A missing/unparseable timestamp = not recently touched = eligible (epoch).
  const webhookFreshness = (pr: PullRequestRecord): number => {
    const updated = pr.updatedAt ? Date.parse(pr.updatedAt) : Number.NaN;
    return Number.isFinite(updated) ? updated : 0;
  };
  // Progress key: when the SWEEP last re-gated this PR. Falls back to createdAt, then epoch, so a never-regated
  // PR sorts maximally stale and is picked first; ties broken by PR number. This is the convergence key — it
  // advances on every sweep regardless of whether GitHub writes are suppressed.
  const regateProgress = (pr: PullRequestRecord): number => {
    const regated = pr.lastRegatedAt ? Date.parse(pr.lastRegatedAt) : Number.NaN;
    if (Number.isFinite(regated)) return regated;
    const created = pr.createdAt ? Date.parse(pr.createdAt) : Number.NaN;
    return Number.isFinite(created) ? created : 0;
  };
  return input.pulls
    .filter((pr) => pr.state === "open" && !pr.isDraft)
    .filter((pr) => {
      if (!Number.isFinite(freshCutoff)) return true;
      return webhookFreshness(pr) <= freshCutoff;
    })
    .sort((a, b) => regateProgress(a) - regateProgress(b) || a.number - b.number)
    .slice(0, Math.max(0, max));
}

/**
 * In-flight guard for the per-PR fan-out (#audit-sweep-fanout): is a re-gate sweep still draining for this repo?
 * sweepRepoRegate fans out one staggered per-PR job per candidate, each of which stamps `last_regated_at` as it
 * runs — so the MOST RECENT stamp across the repo's open PRs (`latestRegatedAt`) being within `windowMs` of `now`
 * means a sweep is actively working through its queue. The cron re-arms every ~2 min, far faster than a sweep
 * drains, so without this guard a second full sweep would pile duplicate per-PR jobs onto the unfinished one. A
 * missing/never-regated/unparseable timestamp means no sweep is in flight (proceed). Pure + deterministic.
 */
export function isRegateSweepDraining(latestRegatedAt: string | null | undefined, now: string, windowMs: number = SWEEP_FRESHNESS_MS): boolean {
  if (!latestRegatedAt) return false;
  const stampedMs = Date.parse(latestRegatedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(stampedMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - stampedMs < windowMs;
}
