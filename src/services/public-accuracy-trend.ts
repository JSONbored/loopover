// Public "Decision accuracy %" weekly trend (#4447, part of epic #4445). The homepage already shows a LIVE,
// lifetime accuracyPct (public-stats.ts's own reversal-grounded formula: 1 - reversed/(merged+closed), over the
// SAME own-ledger allowlist + registered Orb fleet the rest of that payload uses) but no history, so there's no
// way to see whether accuracy is improving, stable, or degrading.
//
// DELIBERATELY NOT a persisted/cron rollup: `audit_events`, `pull_requests`, and `orb_pr_outcomes` are already
// durable, so a live weekly re-bucketing of those SAME rows (mirroring buildPublicQualityTrend's already-shipped
// #2568 pattern for the sibling per-repo quality trend) can recompute any historical week correctly on every
// request -- no cron-miss gap risk, no second copy of the number to keep in sync, and the SAME formula as the
// live figure by construction, so the two can never silently diverge or read as inconsistent to a public viewer.
import { PUBLISHED_PR_KEYS, publicStatsProjects, safeAll } from "../review/public-stats";
import { isoWeekStart } from "./public-quality-metrics";

export const PUBLIC_ACCURACY_TREND_WEEKS = 8;
/** Below this many decided (merged+closed) PRs in a week, that week's accuracy is too noisy to publish. */
export const MIN_ACCURACY_TREND_SAMPLE = 3;

export type PublicAccuracyTrendWeek = {
  /** UTC Monday (YYYY-MM-DD) that starts the bucket. */
  weekStart: string;
  merged: number;
  closed: number;
  reversed: number;
  accuracyPct: number | null;
};

type DayRow = { day: string; merged: number; closed: number; reversed: number };

const MS_PER_WEEK = 7 * 86_400_000;

function roundPct(value: number): number {
  return Math.round(value * 1000) / 10;
}

/** Same formula as public-stats.ts's accuracyPct, reused so the trend and the live number can never drift
 *  apart into two competing definitions of "accuracy". */
function accuracyPctOf(merged: number, closed: number, reversed: number): number | null {
  const decided = merged + closed;
  if (decided < MIN_ACCURACY_TREND_SAMPLE) return null;
  const reversalRate = Math.min(1, reversed / decided);
  return roundPct(1 - reversalRate);
}

/** Fold day-granularity rows into `weeks` trailing UTC-Monday buckets ending in the week containing `nowMs`.
 *  Pure -- mirrors buildPublicQualityTrend's own bucketing shape (public-quality-metrics.ts). */
export function buildPublicAccuracyTrend(dayRows: DayRow[], nowMs: number, weeks: number = PUBLIC_ACCURACY_TREND_WEEKS): PublicAccuracyTrendWeek[] {
  const currentStartMs = Date.parse(isoWeekStart(nowMs));
  const oldestStartMs = currentStartMs - (weeks - 1) * MS_PER_WEEK;
  const buckets = Array.from({ length: weeks }, () => ({ merged: 0, closed: 0, reversed: 0 }));

  for (const row of dayRows) {
    const dayMs = Date.parse(`${row.day}T00:00:00.000Z`);
    if (!Number.isFinite(dayMs)) continue;
    const weekOffset = Math.floor((dayMs - oldestStartMs) / MS_PER_WEEK);
    if (weekOffset < 0 || weekOffset >= weeks) continue;
    const bucket = buckets[weekOffset]!;
    bucket.merged += row.merged;
    bucket.closed += row.closed;
    bucket.reversed += row.reversed;
  }

  return buckets.map((bucket, offset) => ({
    weekStart: isoWeekStart(oldestStartMs + offset * MS_PER_WEEK),
    merged: bucket.merged,
    closed: bucket.closed,
    reversed: bucket.reversed,
    accuracyPct: accuracyPctOf(bucket.merged, bucket.closed, bucket.reversed),
  }));
}

/** Day-bucketed own-ledger merged/closed, matching public-stats.ts's `dispositions` query exactly except for the
 *  added `GROUP BY day` -- `closed` uses `pr.updated_at` as the close-date proxy (no dedicated closed_at column
 *  exists), the same convention buildPublicQualityTrend already established for the sibling quality trend. */
async function loadOwnLedgerDayRows(env: Env, projects: string[], sinceIso: string): Promise<Map<string, { merged: number; closed: number }>> {
  const map = new Map<string, { merged: number; closed: number }>();
  if (projects.length === 0) return map;
  const inList = projects.map(() => "?").join(", ");
  const [mergedRows, closedRows] = await Promise.all([
    safeAll<{ day: string; n: number }>(
      env,
      `SELECT date(pr.merged_at) AS day, COUNT(*) AS n
         FROM (SELECT DISTINCT repo, number FROM (${PUBLISHED_PR_KEYS})) ev
         JOIN pull_requests pr ON pr.repo_full_name = ev.repo AND pr.number = ev.number
        WHERE LOWER(ev.repo) IN (${inList}) AND pr.merged_at IS NOT NULL AND pr.merged_at >= ?
        GROUP BY day`,
      ...projects,
      sinceIso,
    ),
    safeAll<{ day: string; n: number }>(
      env,
      `SELECT date(pr.updated_at) AS day, COUNT(*) AS n
         FROM (SELECT DISTINCT repo, number FROM (${PUBLISHED_PR_KEYS})) ev
         JOIN pull_requests pr ON pr.repo_full_name = ev.repo AND pr.number = ev.number
        WHERE LOWER(ev.repo) IN (${inList}) AND pr.state = 'closed' AND pr.merged_at IS NULL AND pr.updated_at >= ?
        GROUP BY day`,
      ...projects,
      sinceIso,
    ),
  ]);
  for (const row of mergedRows) map.set(row.day, { merged: row.n, closed: (map.get(row.day)?.closed ?? 0) });
  for (const row of closedRows) map.set(row.day, { merged: (map.get(row.day)?.merged ?? 0), closed: row.n });
  return map;
}

/** Day-bucketed reversal count, matching public-stats.ts's `reversalRows` query exactly except bucketed by the
 *  ORIGINAL auto-action's own created_at (not the later reversal's timestamp) so a reversal always credits the
 *  week the decision was actually made, and never retroactively shifts a past week's published trend. */
async function loadReversalDayRows(env: Env, projects: string[], sinceIso: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (projects.length === 0) return map;
  const inList = projects.map(() => "?").join(", ");
  const rows = await safeAll<{ day: string; n: number }>(
    env,
    `SELECT date(ev.created_at) AS day, COUNT(DISTINCT ev.pr_number) AS n FROM (
        SELECT substr(target_key, 1, instr(target_key, '#') - 1) AS project,
               CAST(substr(target_key, instr(target_key, '#') + 1) AS INTEGER) AS pr_number,
               event_type, created_at
          FROM audit_events
         WHERE event_type IN ('agent.action.close', 'agent.action.merge')
           AND outcome = 'completed' AND instr(target_key, '#') > 0
           AND COALESCE(json_extract(metadata_json, '$.mode'), 'live') <> 'dry_run'
           AND created_at >= ?
      ) ev
      JOIN pull_requests pr ON pr.repo_full_name = ev.project AND pr.number = ev.pr_number
      WHERE LOWER(ev.project) IN (${inList})
        AND ( (ev.event_type = 'agent.action.close' AND (pr.state = 'open' OR pr.merged_at IS NOT NULL))
           OR (ev.event_type = 'agent.action.merge' AND pr.state = 'open') )
      GROUP BY day`,
    sinceIso,
    ...projects,
  );
  for (const row of rows) map.set(row.day, row.n);
  return map;
}

/** Day-bucketed Orb-fleet merged/closed, matching getOrbGlobalStats (orb/outcomes.ts) exactly except for the
 *  added `GROUP BY day`. No excludeAccount here, mirroring getPublicStats's own choice not to exclude any
 *  account from the homepage total (see public-stats.ts's file header). */
async function loadOrbDayRows(env: Env, sinceIso: string): Promise<Map<string, { merged: number; closed: number }>> {
  const map = new Map<string, { merged: number; closed: number }>();
  const rows = await safeAll<{ day: string; merged: number; closed: number }>(
    env,
    `SELECT date(o.occurred_at) AS day,
            SUM(CASE WHEN o.outcome = 'merged' THEN 1 ELSE 0 END) AS merged,
            SUM(CASE WHEN o.outcome = 'closed' THEN 1 ELSE 0 END) AS closed
       FROM orb_pr_outcomes o
       JOIN orb_github_installations i ON i.installation_id = o.installation_id AND i.registered = 1
      WHERE o.occurred_at >= ?
      GROUP BY day`,
    sinceIso,
  );
  /* v8 ignore next -- SUM(CASE WHEN ... THEN 1 ELSE 0 END) over an existing GROUP BY day always yields a defined
   *  integer (0 or more), never SQL NULL, so the ?? 0 fallback can't currently be exercised; kept for defense
   *  against a future query-shape change. */
  for (const row of rows) map.set(row.day, { merged: row.merged ?? 0, closed: row.closed ?? 0 });
  return map;
}

/** Assemble the public accuracy trend from the SAME live tables getPublicStats already reads. Fail-safe: each
 *  underlying query degrades to [] on error (safeAll), so a single bad query yields under-counted weeks rather
 *  than throwing the whole public stats payload. */
export async function loadPublicAccuracyTrend(env: Env, nowMs: number = Date.now()): Promise<PublicAccuracyTrendWeek[]> {
  const projects = publicStatsProjects(env);
  const sinceIso = new Date(Date.parse(isoWeekStart(nowMs)) - (PUBLIC_ACCURACY_TREND_WEEKS - 1) * MS_PER_WEEK).toISOString();

  const [ownLedger, reversals, orb] = await Promise.all([
    loadOwnLedgerDayRows(env, projects, sinceIso),
    loadReversalDayRows(env, projects, sinceIso),
    loadOrbDayRows(env, sinceIso),
  ]);

  const days = new Set([...ownLedger.keys(), ...reversals.keys(), ...orb.keys()]);
  const dayRows: DayRow[] = [...days].map((day) => ({
    day,
    merged: (ownLedger.get(day)?.merged ?? 0) + (orb.get(day)?.merged ?? 0),
    closed: (ownLedger.get(day)?.closed ?? 0) + (orb.get(day)?.closed ?? 0),
    reversed: reversals.get(day) ?? 0,
  }));

  return buildPublicAccuracyTrend(dayRows, nowMs);
}
