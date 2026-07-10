// Public "AI-work reuse rate" weekly trend (#4448, part of epic #4445). An honest engineering-competence
// number, not a cost claim: how often the review engine correctly reused a prior result instead of redoing the
// same work -- across every AI-touching capability that has a cache to hit or miss (grounding, review-memory,
// impact-map, repo-culture-profile, ai_review, ai_slop, linked_issue_satisfaction, miner_detection). Deliberately
// NOT a cost/token-rate metric (out of scope per the parent epic).
//
// DELIBERATELY NOT a persisted/cron rollup, mirroring #4447's own public-accuracy-trend.ts design: audit_events
// is already durable, so a live weekly re-bucketing of the SAME rows can recompute any historical week correctly
// on every request -- no cron-miss gap risk, and no second copy of the number to keep in sync.
//
// DELIBERATELY GLOBAL, not scoped to the public-stats repo allowlist: unlike accuracy/handled-PR counts, a
// cache-hit/miss event carries no PR content, author, or repo-specific outcome -- the aggregate reuse rate
// doesn't reveal anything about any one repo's activity, and target_key isn't uniformly shaped across all eight
// capabilities (some key by bare repoFullName, others by repoFullName#prNumber), so allowlist-filtering it would
// need a fragile per-capability parser for no real privacy benefit.
//
// NAMING CONVENTION, not a hardcoded capability list: every instrumented capability already follows
// `github_app.<name>_cache_hit` / `github_app.<name>_cache_miss` (confirmed via a full-repo grep before writing
// this), so a single LIKE-pattern query picks up all eight today AND any future capability that follows the
// same convention, with zero code change here. ai_review's three additional REUSE variants (frozen/paused/
// one-shot) don't fit that exact suffix -- each is a genuine "skipped a redundant AI call" event, so they're
// folded into "hit" alongside the plain ai_review_cache_hit.
import { safeAll } from "../review/public-stats";
import { isoWeekStart } from "./public-quality-metrics";

export const PUBLIC_REUSE_RATE_TREND_WEEKS = 8;
/** Below this many total attempts (hits+misses) in a week, that week's reuse rate is too noisy to publish. */
export const MIN_REUSE_RATE_TREND_SAMPLE = 5;

/** ai_review reuse events that don't follow the `_cache_hit` suffix convention but are the SAME "avoided a
 *  redundant AI call" signal -- each one means the review pass reused a prior state instead of re-running. */
const AI_REVIEW_REUSE_EVENT_TYPES = ["github_app.ai_review_frozen_reuse", "github_app.ai_review_paused_reuse", "github_app.ai_review_one_shot_reuse"] as const;

export type PublicReuseRateTrendWeek = {
  /** UTC Monday (YYYY-MM-DD) that starts the bucket. */
  weekStart: string;
  hits: number;
  misses: number;
  reuseRatePct: number | null;
};

type DayRow = { day: string; hits: number; misses: number };

const MS_PER_WEEK = 7 * 86_400_000;

function roundPct(value: number): number {
  return Math.round(value * 1000) / 10;
}

function reuseRatePctOf(hits: number, misses: number): number | null {
  const attempts = hits + misses;
  if (attempts < MIN_REUSE_RATE_TREND_SAMPLE) return null;
  return roundPct(hits / attempts);
}

/** Fold day-granularity rows into `weeks` trailing UTC-Monday buckets ending in the week containing `nowMs`.
 *  Pure -- mirrors buildPublicAccuracyTrend's own bucketing shape (public-accuracy-trend.ts, #4447). */
export function buildPublicReuseRateTrend(dayRows: DayRow[], nowMs: number, weeks: number = PUBLIC_REUSE_RATE_TREND_WEEKS): PublicReuseRateTrendWeek[] {
  const currentStartMs = Date.parse(isoWeekStart(nowMs));
  const oldestStartMs = currentStartMs - (weeks - 1) * MS_PER_WEEK;
  const buckets = Array.from({ length: weeks }, () => ({ hits: 0, misses: 0 }));

  for (const row of dayRows) {
    const dayMs = Date.parse(`${row.day}T00:00:00.000Z`);
    if (!Number.isFinite(dayMs)) continue;
    const weekOffset = Math.floor((dayMs - oldestStartMs) / MS_PER_WEEK);
    if (weekOffset < 0 || weekOffset >= weeks) continue;
    const bucket = buckets[weekOffset]!;
    bucket.hits += row.hits;
    bucket.misses += row.misses;
  }

  return buckets.map((bucket, offset) => ({
    weekStart: isoWeekStart(oldestStartMs + offset * MS_PER_WEEK),
    hits: bucket.hits,
    misses: bucket.misses,
    reuseRatePct: reuseRatePctOf(bucket.hits, bucket.misses),
  }));
}

/** Day-bucketed hit/miss counts across every `github_app.<name>_cache_hit` / `_cache_miss` event, plus
 *  ai_review's three non-suffix-conforming reuse variants (see file header). Fail-safe: degrades to [] on any
 *  query error (safeAll), yielding under-counted weeks rather than throwing the whole public stats payload. */
async function loadReuseRateDayRows(env: Env, sinceIso: string): Promise<DayRow[]> {
  const reuseTypePlaceholders = AI_REVIEW_REUSE_EVENT_TYPES.map(() => "?").join(", ");
  const rows = await safeAll<{ day: string; hits: number; misses: number }>(
    env,
    `SELECT date(created_at) AS day,
            SUM(CASE WHEN event_type LIKE 'github_app.%cache_hit' OR event_type IN (${reuseTypePlaceholders}) THEN 1 ELSE 0 END) AS hits,
            SUM(CASE WHEN event_type LIKE 'github_app.%cache_miss' THEN 1 ELSE 0 END) AS misses
       FROM audit_events
      WHERE (event_type LIKE 'github_app.%cache_hit' OR event_type LIKE 'github_app.%cache_miss' OR event_type IN (${reuseTypePlaceholders}))
        AND created_at >= ?
      GROUP BY day`,
    ...AI_REVIEW_REUSE_EVENT_TYPES,
    ...AI_REVIEW_REUSE_EVENT_TYPES,
    sinceIso,
  );
  /* v8 ignore next -- SUM(CASE WHEN ... THEN 1 ELSE 0 END) over an existing GROUP BY day always yields a
   *  defined integer (0 or more), never SQL NULL, so the ?? 0 fallback can't currently be exercised; kept for
   *  defense against a future query-shape change (mirrors public-accuracy-trend.ts's identical guard). */
  return rows.map((row) => ({ day: row.day, hits: row.hits ?? 0, misses: row.misses ?? 0 }));
}

/** Assemble the public reuse-rate trend from the SAME live audit_events ledger every instrumented capability
 *  already writes to. */
export async function loadPublicReuseRateTrend(env: Env, nowMs: number = Date.now()): Promise<PublicReuseRateTrendWeek[]> {
  const sinceIso = new Date(Date.parse(isoWeekStart(nowMs)) - (PUBLIC_REUSE_RATE_TREND_WEEKS - 1) * MS_PER_WEEK).toISOString();
  const dayRows = await loadReuseRateDayRows(env, sinceIso);
  return buildPublicReuseRateTrend(dayRows, nowMs);
}
