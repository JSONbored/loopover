import { listLatestGitHubRateLimitObservations } from "../db/repositories";

// All managed repos share ONE GitHub App installation → ONE hourly REST bucket. To keep heavy maintenance work
// from draining the budget real-time contributor-PR-review traffic needs, maintenance yields while there is
// still headroom:
//   - webhooks AND current-head agent-regate-pr reconciliation (a trailing coalesced re-review, an over-cap
//     sibling wake, a linked-issue-change re-review, an outage-repair enqueue -- see
//     isScheduledRegateSweepJob/#selfhost-queue-liveness) yield at LOW_REST_RATE_LIMIT_REMAINING: this is
//     LIVE work someone is waiting on, not maintenance, regardless of which one of these triggered it;
//   - the re-gate SWEEP's own stale-candidate fan-out (deliveryId prefixed "regate-sweep:") yields EARLIER, at
//     MAINTENANCE_RESERVED_HEADROOM, reserving the budget between the two floors for the live work above —
//     this is genuinely deferrable periodic maintenance, not a response to anything happening on a PR right now;
//   - historical/scheduled hydration that isn't needed for any CURRENT PR (e.g. backfilling file lists for old
//     merged pull requests) yields EARLIEST, at HISTORICAL_BACKFILL_RESERVED_HEADROOM — it is the least urgent
//     GitHub REST consumer, so it must never be the reason a live review or an open-PR convergence pass stalls.
// Self-host queues also use the latest persisted observation for admission control, so a known-exhausted bucket
// delays webhook jobs before they start and avoids burning the first live delivery just to discover the limit.
// (#audit-rate-headroom)
export const LOW_REST_RATE_LIMIT_REMAINING = 75;
export const MAINTENANCE_RESERVED_HEADROOM = 150;
export const HISTORICAL_BACKFILL_RESERVED_HEADROOM = 300;

/** The REST rate-limit reset time to wait until when the latest recorded REST budget is at/below `floor`, or
 *  undefined when there is headroom, no usable observation, or the reset is already in the past. Reads the latest
 *  recorded observation (recordGitHubRateLimitObservation writes one per GitHub call) — no live GitHub call.
 *
 *  `admissionKey`, when given, scopes the read to that bucket ONLY (#audit-rate-scoping) — every installation and
 *  the shared public/registry token draw from DIFFERENT GitHub-side REST buckets, so checking the caller's own
 *  bucket instead of "whichever bucket was most recently observed" avoids one bucket's health masking or falsely
 *  throttling an unrelated one. Omitted (as at a few call sites with no natural single bucket to check, e.g. a
 *  pre-dispatch scheduler tick) preserves the prior globally-newest-observation behavior unchanged. */
export async function shouldWaitForGitHubRateLimit(env: Env, floor: number = LOW_REST_RATE_LIMIT_REMAINING, admissionKey?: string): Promise<string | undefined> {
  const observations = await listLatestGitHubRateLimitObservations(env, 10, admissionKey);
  // Type-guard the find so `remaining` narrows to a number — null/undefined observations are excluded here, so the
  // headroom check below needs no further nullish guard.
  const rest = observations.find((observation): observation is typeof observation & { remaining: number } => observation.resource === "rest" && observation.remaining !== null && observation.remaining !== undefined);
  if (!rest?.resetAt || rest.remaining > floor) return undefined;
  return Date.parse(rest.resetAt) > Date.now() ? rest.resetAt : undefined;
}

/** Seconds to defer a job until a GitHub rate-limit reset, clamped to [30, 900] with a 15s safety margin. An
 *  unparseable reset uses a conservative 60s. */
export function delayUntil(iso: string): number {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return 60;
  return Math.max(30, Math.min(900, Math.ceil(ms / 1000) + 15));
}
