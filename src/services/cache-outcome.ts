// One vocabulary for "a cache avoided work" (#10208).
//
// Eight cache-like surfaces each report avoidance under their OWN event name, in three different
// vocabularies -- `*_cache_hit`, `*_reuse`, and `*_one_shot_skip`. No single query knows all of them, so the
// obvious question ("is our caching working?") is answered wrongly by the obvious query. Measured on the Orb:
// asking `%cache_hit%` vs `%cache_miss%` over 24h reports the AI review cache at **0.44%** (1 hit, 228 misses)
// when its real rate is **78.1%** -- the 811 avoided runs live in `ai_review_one_shot_reuse` and
// `ai_review_frozen_reuse`, which contain neither the word "cache" nor the word "hit". A 177x understatement,
// and the kind that sends someone optimising a cache that already works.
//
// Rather than renaming events (every one is load-bearing in dashboards, alerts and existing queries), this
// maps each event to a shared `(cache_surface, cache_outcome)` pair that is stamped into its audit metadata.
// The event names are untouched and fully back-compatible; one query now aggregates all of them:
//
//   SELECT metadata_json->>'cache_surface', metadata_json->>'cache_outcome', count(*) FROM audit_events ...
//
// STAMPED CENTRALLY, in recordAuditEvent, NOT at the ~20 call sites. A field each call site must remember to
// add is a field a future call site forgets -- the same "two or more places that must agree, with nothing
// enforcing it" shape #10170 catalogues and #10127 fixed by making the omission unrepresentable. Here the call
// sites are not involved at all: they emit the event they always did, and the classification happens once.

/** The cache-like surfaces that report avoidance. `grounding` is deliberately included but is NOT comparable
 *  to the others -- see {@link CACHE_SURFACE_NOTES}. */
export const CACHE_SURFACES = [
  "ai_review",
  "ai_slop",
  "linked_issue_satisfaction",
  "miner_detection",
  "grounding",
  "impact_map",
  "review_memory",
  "repo_culture_profile",
] as const;

export type CacheSurface = (typeof CACHE_SURFACES)[number];

/** `hit` = work avoided, by any mechanism. `miss` = the work was done. */
export type CacheOutcome = "hit" | "miss";

/**
 * `grounding` keys on `(repo, path, head_sha)` and fetches the files the PR CHANGED, whose content differs at
 * every head SHA by construction. Its only possible hit is the same file grounded twice at the same commit, so
 * its rate measures RE-EVALUATION CHURN, not cache health -- it fell from 27-61% to ~0% because same-SHA
 * re-evaluation was deliberately driven down, i.e. because the system got better. Measured against the Orb:
 * re-keying on blob content would collapse 1146 rows to 1047, only 8.6% reuse, so there is no fix to apply
 * either. Included here so one query still sees every surface, flagged so nobody reads it as a peer of the
 * fingerprint-keyed caches above it or "optimises" it.
 */
export const CACHE_SURFACE_NOTES: Partial<Record<CacheSurface, string>> = {
  grounding: "per-commit blob cache; hit rate tracks re-evaluation churn, not cache effectiveness (#10208)",
};

/**
 * Every audit event that reports a cache outcome, and what it means. Exhaustive by construction: the
 * "every cache-shaped audit event is classified" test in test/unit/cache-outcome.test.ts scans the source for
 * event types matching the three vocabularies and fails if any is missing here, so a ninth surface (or a
 * fourth word for "hit") cannot be added without being classified.
 */
export const CACHE_OUTCOME_EVENTS: Readonly<Record<string, { surface: CacheSurface; outcome: CacheOutcome }>> = Object.freeze({
  "github_app.ai_review_cache_hit": { surface: "ai_review", outcome: "hit" },
  "github_app.ai_review_cache_miss": { surface: "ai_review", outcome: "miss" },
  // The #regate-churn cooldown, not the durable cache: the durable one is bypassed by design for
  // dynamic-context repos (see the `features` comment in src/review/ai-review-cache-input.ts), so on those
  // repos these two ARE the reuse path and the durable cache legitimately reports almost nothing.
  "github_app.ai_review_one_shot_reuse": { surface: "ai_review", outcome: "hit" },
  "github_app.ai_review_frozen_reuse": { surface: "ai_review", outcome: "hit" },
  "github_app.ai_slop_cache_hit": { surface: "ai_slop", outcome: "hit" },
  "github_app.ai_slop_cache_miss": { surface: "ai_slop", outcome: "miss" },
  "github_app.ai_slop_one_shot_skip": { surface: "ai_slop", outcome: "hit" },
  "github_app.linked_issue_satisfaction_cache_hit": { surface: "linked_issue_satisfaction", outcome: "hit" },
  "github_app.linked_issue_satisfaction_cache_miss": { surface: "linked_issue_satisfaction", outcome: "miss" },
  "github_app.linked_issue_satisfaction_one_shot_skip": { surface: "linked_issue_satisfaction", outcome: "hit" },
  "github_app.miner_detection_cache_hit": { surface: "miner_detection", outcome: "hit" },
  "github_app.miner_detection_cache_miss": { surface: "miner_detection", outcome: "miss" },
  "github_app.grounding_cache_hit": { surface: "grounding", outcome: "hit" },
  "github_app.grounding_cache_miss": { surface: "grounding", outcome: "miss" },
  "github_app.impact_map_cache_hit": { surface: "impact_map", outcome: "hit" },
  "github_app.impact_map_cache_miss": { surface: "impact_map", outcome: "miss" },
  "github_app.review_memory_cache_hit": { surface: "review_memory", outcome: "hit" },
  "github_app.review_memory_cache_miss": { surface: "review_memory", outcome: "miss" },
  "github_app.repo_culture_profile_cache_hit": { surface: "repo_culture_profile", outcome: "hit" },
  "github_app.repo_culture_profile_cache_miss": { surface: "repo_culture_profile", outcome: "miss" },
});

/**
 * The shared classification for `eventType`, or `undefined` when it does not report a cache outcome.
 *
 * DELIBERATELY returns undefined rather than guessing from the name: an event called `*_cache_hit` that nobody
 * registered is exactly the drift this module exists to catch, and the guard test catches it at build time.
 * Silently inferring it would make the guard unfalsifiable.
 */
export function cacheOutcomeMetadata(eventType: string): { cache_surface: CacheSurface; cache_outcome: CacheOutcome } | undefined {
  const entry = CACHE_OUTCOME_EVENTS[eventType];
  return entry ? { cache_surface: entry.surface, cache_outcome: entry.outcome } : undefined;
}
