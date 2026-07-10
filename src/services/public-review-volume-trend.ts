// Public "PRs reviewed" / "Filtered without merge %" weekly trend (#4445 follow-up, sibling to #4447's
// accuracy trend and #4448's reuse-rate trend). The homepage already shows LIVE lifetime totals.reviewed and
// totals.filteredPct (public-stats.ts's own formula: (reviewed - merged) / reviewed) but no history.
//
// DELIBERATELY a per-week COHORT, not an independent per-day event count (unlike accuracyTrend, which buckets
// merged/closed by their OWN respective event dates as two independent series): filteredPct only means anything
// evaluated against a FIXED set of reviewed PRs, so each week's bucket is "of the PRs first published THAT
// week, how many are (as of now) merged" -- mirrors getPublicStats's own weeklyRows subquery (own-ledger side),
// just grouped by day instead of filtered by a single `sinceIso` threshold. A side effect worth knowing: the
// most recent 1-2 weeks' cohorts include PRs still in flight (not yet merged or closed), so their filteredPct
// can read lower than it will once those PRs resolve -- an honest "not enough time has passed yet" artifact,
// not a bug.
//
// DELIBERATELY NOT a persisted/cron rollup, mirroring #4447/#4448's own design: audit_events and pull_requests
// are already durable, so a live weekly re-bucketing of the SAME rows can recompute any historical week
// correctly on every request -- no cron-miss gap risk, no second copy of the number to keep in sync, and the
// SAME formula as the live figure by construction.
import { publicStatsProjects, safeAll } from "../review/public-stats";
import { isoWeekStart } from "./public-quality-metrics";
import { loadOrbDayRows } from "./public-accuracy-trend";

export const PUBLIC_REVIEW_VOLUME_TREND_WEEKS = 8;
/** Below this many reviewed PRs in a week, that week's filteredPct is too noisy to publish (the raw `reviewed`
 *  count itself is always shown -- a count needs no sample-size guard the way a ratio does). */
export const MIN_REVIEW_VOLUME_TREND_SAMPLE = 3;

export type PublicReviewVolumeTrendWeek = {
  /** UTC Monday (YYYY-MM-DD) that starts the bucket. */
  weekStart: string;
  reviewed: number;
  merged: number;
  filteredPct: number | null;
};

type DayRow = { day: string; reviewed: number; merged: number };

const MS_PER_WEEK = 7 * 86_400_000;

function roundPct(value: number): number {
  return Math.round(value * 1000) / 10;
}

/** Same formula as public-stats.ts's filteredPct, reused so the trend and the live number can never drift
 *  apart into two competing definitions of "filtered". */
function filteredPctOf(reviewed: number, merged: number): number | null {
  if (reviewed < MIN_REVIEW_VOLUME_TREND_SAMPLE) return null;
  return roundPct((reviewed - merged) / reviewed);
}

/** Fold day-granularity rows into `weeks` trailing UTC-Monday buckets ending in the week containing `nowMs`.
 *  Pure -- mirrors buildPublicAccuracyTrend's own bucketing shape (public-accuracy-trend.ts, #4447). */
export function buildPublicReviewVolumeTrend(dayRows: DayRow[], nowMs: number, weeks: number = PUBLIC_REVIEW_VOLUME_TREND_WEEKS): PublicReviewVolumeTrendWeek[] {
  const currentStartMs = Date.parse(isoWeekStart(nowMs));
  const oldestStartMs = currentStartMs - (weeks - 1) * MS_PER_WEEK;
  const buckets = Array.from({ length: weeks }, () => ({ reviewed: 0, merged: 0 }));

  for (const row of dayRows) {
    const dayMs = Date.parse(`${row.day}T00:00:00.000Z`);
    if (!Number.isFinite(dayMs)) continue;
    const weekOffset = Math.floor((dayMs - oldestStartMs) / MS_PER_WEEK);
    if (weekOffset < 0 || weekOffset >= weeks) continue;
    const bucket = buckets[weekOffset]!;
    bucket.reviewed += row.reviewed;
    bucket.merged += row.merged;
  }

  return buckets.map((bucket, offset) => ({
    weekStart: isoWeekStart(oldestStartMs + offset * MS_PER_WEEK),
    reviewed: bucket.reviewed,
    merged: bucket.merged,
    filteredPct: filteredPctOf(bucket.reviewed, bucket.merged),
  }));
}

/** Day-bucketed own-ledger reviewed/merged COHORTS: for each PR first published on a given day, `reviewed`
 *  credits that day and `merged` credits it too IF the PR is (as of now) merged -- regardless of which day the
 *  merge itself happened on. Matches getPublicStats's own weeklyRows subquery (the same "first published,
 *  current disposition" concept), just grouped by day instead of filtered by a single sinceIso threshold.
 *
 *  Two-step, index-bound query (#4723) -- NOT a naive single-pass scan of the whole publish-event history:
 *  1. `recent_keys`: which PRs had *any* publish event in the trailing window. Index-accelerated via the
 *     existing `audit_events_type_created_idx (event_type, created_at)` -- an equality-then-range scan, cost
 *     proportional to recent activity, not total history.
 *  2. `true_first_seen`: for JUST those candidates, the TRUE first-publish date across ALL of a PR's publish
 *     events (not just the recent one) -- via the new `audit_events_target_key_created_idx (target_key,
 *     created_at)` (migrations/0142), an index lookup per candidate rather than a full-table scan.
 *  Splitting it this way (instead of filtering step 1's raw rows by sinceIso BEFORE taking MIN) matters for
 *  correctness, not just speed: a PR whose true first-publish is OLDER than the window but which also got a
 *  legitimate re-publish (e.g. a fresh push triggering re-review) INSIDE the window must still resolve to its
 *  true (out-of-window) first-publish date and be excluded -- not get misattributed to the re-publish's week.
 *  Step 2 always looks at a candidate's FULL history precisely to get this right; only step 1 is time-bounded. */
async function loadOwnLedgerDayRows(env: Env, projects: string[], sinceIso: string): Promise<Map<string, { reviewed: number; merged: number }>> {
  const map = new Map<string, { reviewed: number; merged: number }>();
  if (projects.length === 0) return map;
  const inList = projects.map(() => "?").join(", ");
  const rows = await safeAll<{ day: string; reviewed: number; merged: number }>(
    env,
    `WITH recent_keys AS (
       SELECT DISTINCT target_key
         FROM audit_events
        WHERE event_type = 'github_app.pr_public_surface_published'
          AND instr(target_key, '#') > 0
          AND created_at >= ?
          AND LOWER(substr(target_key, 1, instr(target_key, '#') - 1)) IN (${inList})
     ),
     true_first_seen AS (
       SELECT
         substr(ae.target_key, 1, instr(ae.target_key, '#') - 1) AS repo,
         CAST(substr(ae.target_key, instr(ae.target_key, '#') + 1) AS INTEGER) AS number,
         MIN(ae.created_at) AS first_seen
         FROM audit_events ae
         JOIN recent_keys rk ON rk.target_key = ae.target_key
        WHERE ae.event_type = 'github_app.pr_public_surface_published'
        GROUP BY ae.target_key
     )
     SELECT date(t.first_seen) AS day,
            COUNT(*) AS reviewed,
            SUM(CASE WHEN pr.merged_at IS NOT NULL THEN 1 ELSE 0 END) AS merged
       FROM true_first_seen t
       LEFT JOIN pull_requests pr ON pr.repo_full_name = t.repo AND pr.number = t.number
      WHERE date(t.first_seen) >= date(?)
      GROUP BY day`,
    sinceIso,
    ...projects,
    sinceIso,
  );
  /* v8 ignore next -- SUM(CASE WHEN ... THEN 1 ELSE 0 END) over an existing GROUP BY day always yields a
   *  defined integer (0 or more), never SQL NULL, so the ?? 0 fallback can't currently be exercised; kept for
   *  defense against a future query-shape change (mirrors public-accuracy-trend.ts's identical guard). */
  for (const row of rows) map.set(row.day, { reviewed: row.reviewed ?? 0, merged: row.merged ?? 0 });
  return map;
}

/** Assemble the public review-volume trend from the SAME live tables getPublicStats already reads, folding the
 *  Orb fleet's per-day merged+closed into `reviewed`/`merged` exactly as getPublicStats folds orb.total/
 *  orb.merged into totals.handled/totals.merged for the lifetime figure. Fail-safe: each underlying query
 *  degrades to [] on error (safeAll), so a single bad query yields under-counted weeks rather than throwing the
 *  whole public stats payload. */
export async function loadPublicReviewVolumeTrend(env: Env, nowMs: number = Date.now()): Promise<PublicReviewVolumeTrendWeek[]> {
  const projects = publicStatsProjects(env);
  const sinceIso = new Date(Date.parse(isoWeekStart(nowMs)) - (PUBLIC_REVIEW_VOLUME_TREND_WEEKS - 1) * MS_PER_WEEK).toISOString();

  const [ownLedger, orb] = await Promise.all([
    loadOwnLedgerDayRows(env, projects, sinceIso),
    loadOrbDayRows(env, sinceIso),
  ]);

  const days = new Set([...ownLedger.keys(), ...orb.keys()]);
  const dayRows: DayRow[] = [...days].map((day) => {
    const orbDay = orb.get(day);
    const orbReviewed = orbDay ? orbDay.merged + orbDay.closed : 0;
    return {
      day,
      reviewed: (ownLedger.get(day)?.reviewed ?? 0) + orbReviewed,
      merged: (ownLedger.get(day)?.merged ?? 0) + (orbDay?.merged ?? 0),
    };
  });

  return buildPublicReviewVolumeTrend(dayRows, nowMs);
}
