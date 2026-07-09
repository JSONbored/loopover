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
// sweep cost is `SWEEP_MAX_PRS × repos × 9 × 30`. At the old cap of 25 over 3 self-host repos that is ~200k/hr.
// A cap of 6 still consumed nearly the whole REST bucket across three active repos, so scheduled sweeps now run
// at a smaller source budget and also skip while prior regate work is queued. A cap of 3 bounds the raw worst case
// to `3 × 3 × 9 × 30 ≈ 2.4k/hr`, leaving budget for live webhooks, cache misses, and branch-protection reads.
export const SWEEP_MAX_PRS = 3;

// Issue-side wake budget (#3989 review): SWEEP_MAX_PRS (3) is sized for a sweep that RECURS every ~2 minutes,
// so its ceiling has to survive being multiplied by ~30 ticks/hr. This handler instead fires ONCE per issue
// label/assignment webhook, so a larger one-shot source budget is safe -- but it still must be bounded, or a
// popular/tracking issue linked from hundreds of PRs would enqueue hundreds of ~9-REST-GET re-gates from a
// single event. 25 reuses this file's own prior sweep ceiling (see SWEEP_MAX_PRS comment) as a one-shot budget:
// worst case ~25 x 9 = 225 REST calls, staggered by the same delaySeconds window the caller already uses.
export const ISSUE_WAKE_MAX_PRS = 25;

// Sibling-merge wake budget (#4005): companion to the merge-train gate -- when a PR MERGES, every OTHER open PR's
// verdict can be invalidated (a newly-conflicting base, a duplicate cluster missing its winner, a linked-issue cap
// that just freed up) with nothing proactively re-checking it until the next sweep tick. This handler fires ONCE
// per merge, same one-shot shape as ISSUE_WAKE_MAX_PRS, but a merge is a far MORE common trigger than an issue
// label/assignment change -- a busy repo can merge many PRs an hour, each firing this fan-out, so reusing
// ISSUE_WAKE_MAX_PRS's 25 would let repeated merges inside one rate-limit window compound in a way the rarer
// issue-wake trigger never does. 15 keeps each merge's worst case at 15 x 9 ≈ 135 REST calls (same ~9-REST-GET
// per-PR re-review cost as the other agent-regate-pr fan-outs), staggered by the same delaySeconds window.
export const MERGE_WAKE_MAX_PRS = 15;

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

// Candidate ordering mode (#3815, RepositorySettings["regateSweepOrderMode"]). "staleness" (default) is
// selectRegateCandidates' original ordering; "oldest-first" is opt-in per repo. See the function doc comment
// for the convergence-guarantee rationale each preserves.
export type RegateSweepOrderMode = "staleness" | "oldest-first";

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
 *
 * `orderMode` (#3815, default `"staleness"`): an opt-in `"oldest-first"` mode instead orders candidates by
 * `createdAt` ascending, for an operator who wants deterministic creation-order draining over the staleness
 * sort's own convergence property. Unlike `regateProgress` above, a PR's `createdAt` never changes, so
 * `oldest-first`'s sort key alone cannot advance past an already-dispatched PR — without something else, the
 * same oldest `max` PRs would recur every sweep forever.
 *
 * `oldest-first` therefore drains never-regated PRs before cycling already-regated ones: while any eligible
 * non-priority PR lacks `lastRegatedAt`, the candidate pool is narrowed to those never-regated PRs (plus any
 * priority repairs). That preserves deterministic creation-order backlog recovery and covers a large initial
 * backlog in ceil(open/max) sweeps. Once every eligible PR has been swept at least once, it falls back to the
 * staleness key so continued periodic re-gating keeps converging instead of pinning the oldest PRs forever.
 * Selection-time only: real-time webhook-driven review is not gated by this sort and can still process any PR
 * out of order at any moment.
 *
 * `priorityPullNumbers` (outage repair -- surfaceRepairPriorityPullNumbers, processors.ts) affects ELIGIBILITY
 * only, never final order (#selfhost-fifo-ordering): a repair candidate bypasses the freshness guard
 * (`priorityBypassesFreshness`) and stays in the oldest-first pool even once it already has a `lastRegatedAt`
 * stamp (`hasRepairPriority` in the pool filter below) -- but it is NOT sorted ahead of the rest of the queue.
 * An earlier revision additionally sorted repair candidates first, which let a newer PR needing repair (e.g.
 * opened during an extended pause, so it has never published anything) jump ahead of older PRs that merely
 * went stale -- observed live as PRs dispatching out of their creation/staleness order ("spraying") whenever a
 * repo had a mixed backlog of repaired and ordinary candidates. Every eligible PR -- repair or not -- is now
 * ordered by the SAME `orderKey` (+ PR-number tiebreak), so a sweep processes its queue in one deterministic
 * order every time, regardless of how many candidates happen to need repair.
 */
export function selectRegateCandidates(input: {
  pulls: PullRequestRecord[];
  now: string;
  priorityPullNumbers?: readonly number[] | ReadonlySet<number> | undefined;
  priorityBypassesFreshness?: boolean;
  freshnessWindowMs?: number;
  max?: number;
  orderMode?: RegateSweepOrderMode;
}): PullRequestRecord[] {
  const freshnessWindowMs = input.freshnessWindowMs ?? SWEEP_FRESHNESS_MS;
  const max = input.max ?? SWEEP_MAX_PRS;
  const orderMode = input.orderMode ?? "staleness";
  const nowMs = Date.parse(input.now);
  const freshCutoff = Number.isFinite(nowMs)
    ? nowMs - freshnessWindowMs
    : Number.NaN;
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
    const regated = pr.lastRegatedAt
      ? Date.parse(pr.lastRegatedAt)
      : Number.NaN;
    if (Number.isFinite(regated)) return regated;
    const created = pr.createdAt ? Date.parse(pr.createdAt) : Number.NaN;
    return Number.isFinite(created) ? created : 0;
  };
  // Creation-order key (#3815, "oldest-first" mode): always the PR's own createdAt, never lastRegatedAt — a
  // repeatedly-regated PR must NOT sort as if newly created. A missing/unparseable createdAt falls back to
  // epoch (same convention as regateProgress above), so it sorts oldest; ties (including every missing-createdAt
  // PR) are broken by PR number, same as every other mode.
  const creationOrder = (pr: PullRequestRecord): number => {
    const created = pr.createdAt ? Date.parse(pr.createdAt) : Number.NaN;
    return Number.isFinite(created) ? created : 0;
  };
  const priorityPullNumbers =
    input.priorityPullNumbers instanceof Set
      ? input.priorityPullNumbers
      : new Set(input.priorityPullNumbers ?? []);
  const eligible = input.pulls
    .filter((pr) => pr.state === "open" && !pr.isDraft)
    .filter((pr) => {
      if (input.priorityBypassesFreshness && priorityPullNumbers.has(pr.number))
        return true;
      if (!Number.isFinite(freshCutoff)) return true;
      return webhookFreshness(pr) <= freshCutoff;
    });
  const hasBeenRegated = (pr: PullRequestRecord): boolean => {
    const regated = pr.lastRegatedAt
      ? Date.parse(pr.lastRegatedAt)
      : Number.NaN;
    return Number.isFinite(regated);
  };
  const hasRepairPriority = (pr: PullRequestRecord): boolean =>
    priorityPullNumbers.has(pr.number);
  // Keep already-swept PRs eligible: the scheduled sweep is the same-head drift backstop for base, sibling,
  // manifest, and settings changes that do not emit a PR webhook. `lastRegatedAt` is only a progress/sort marker,
  // not a permanent deny-list; repair priority still affects freshness eligibility above and initial-drain pooling
  // below, but never final ordering.
  const candidates = eligible;
  const oldestFirstInitialDrain =
    orderMode === "oldest-first" &&
    candidates.some((pr) => !hasBeenRegated(pr) && !hasRepairPriority(pr));
  const orderKey =
    orderMode === "oldest-first" && oldestFirstInitialDrain
      ? creationOrder
      : regateProgress;
  const orderingPool = oldestFirstInitialDrain
    ? candidates.filter((pr) => !hasBeenRegated(pr) || hasRepairPriority(pr))
    : candidates;
  return orderingPool
    .sort((a, b) => orderKey(a) - orderKey(b) || a.number - b.number)
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
export function isRegateSweepDraining(
  latestRegatedAt: string | null | undefined,
  now: string,
  windowMs: number = SWEEP_FRESHNESS_MS,
): boolean {
  if (!latestRegatedAt) return false;
  const stampedMs = Date.parse(latestRegatedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(stampedMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - stampedMs < windowMs;
}
