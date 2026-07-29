// Public fleet accuracy trend (#9676). The own-ledger weekly trend (public-accuracy-trend.ts) is
// reversal-grounded over `audit_events`, and that ledger is frozen: the hosted Worker does not execute
// reviews, so every recent week correctly reports `null` while Orb volume keeps growing. A table of nulls
// beside a rising volume column is honest but tells a reader nothing about how the gate behaves TODAY.
//
// `orb_signals` already carries what is needed, with no new ingest, no new column and no new secret:
// self-host runtimes export `gate_verdict`, `outcome` and `reversal_flag` per PR (src/selfhost/orb-collector.ts),
// the hosted side validates and stores them (src/orb/ingest.ts), and computeFleetAnalytics already turns them
// into the 90-day headline. This module buckets the SAME rows weekly.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO:
//
//   1. It never blends with the own-ledger series. `orb_signals` is keyed by per-instance HMACs of repo/PR;
//      `orb_pr_outcomes` and `audit_events` are keyed by raw `owner/repo#number`. The two count different
//      populations and cannot be joined, so a reversal from one can never be attributed to a decided row in
//      the other. Publishing one number over a mixed denominator is exactly the class of bug #9676 exists to
//      fix -- so this is a SEPARATE series with its own numerator and denominator.
//
//   2. It does not use `1 - reversalRate`. #8820 established that the fleet number is `decisionAccuracy` --
//      the share of the gate's own merge/close verdicts the realized outcome confirmed, holds excluded --
//      because the reversal formula both divides by deferrals that cannot be right or wrong and misses
//      outright mispredictions that carry no reversal marker. Publishing a weekly series on a different
//      estimand than the headline it sits under would make the page disagree with itself.
//
// The weekly fold calls `foldInstance` rather than reimplementing the confusion-matrix accounting. That
// function's own doc comment already warns that a second copy silently makes comparisons
// apples-to-oranges (it was exported for the federated bundle for the same reason), and the accounting is
// subtle: `policy_action` rows are excluded from scoring but still count as activity, and a `superseded`
// close is disconfirmed exactly like a literal reopen.
import { foldInstance, type Cell } from "../orb/analytics";
import { safeAll } from "../review/public-stats";
import { isoWeekStart } from "./public-quality-metrics";

export const PUBLIC_FLEET_TREND_WEEKS = 8;

/** Below this many scored verdicts in a week, that week's accuracy is too noisy to publish. Mirrors
 *  MIN_ACCURACY_TREND_SAMPLE's role on the own-ledger series -- a public percentage over one or two
 *  decisions is a coin flip wearing a number. */
export const MIN_FLEET_TREND_VERDICTS = 5;

export type PublicFleetAccuracyTrendWeek = {
  /** UTC Monday (YYYY-MM-DD) that starts the bucket. */
  weekStart: string;
  /** Scored merge/close verdicts in the week -- holds and policy actions excluded, matching the estimand. */
  verdicts: number | null;
  /** Share of those verdicts the realized outcome confirmed; null below the sample floor. */
  accuracyPct: number | null;
};

/** One `orb_signals` confusion-matrix cell, bucketed to a week. */
export type FleetTrendCell = Cell & { weekStart: string };

/** The raw query shape: the same cell dimensions, bucketed to a UTC day by SQL. */
type FleetTrendDayCell = Cell & { day: string };

const MS_PER_WEEK = 7 * 86_400_000;

function roundPct(value: number): number {
  return Math.round(value * 1000) / 10;
}

/**
 * PURE. Fold week-bucketed cells into `weeks` trailing UTC-Monday buckets ending in the week containing
 * `nowMs`. Mirrors buildPublicAccuracyTrend's bucketing shape so the two series line up row-for-row on the
 * page even though they measure different populations.
 */
export function buildPublicFleetAccuracyTrend(
  cells: readonly FleetTrendCell[],
  nowMs: number,
  weeks: number = PUBLIC_FLEET_TREND_WEEKS,
): PublicFleetAccuracyTrendWeek[] {
  const currentStartMs = Date.parse(isoWeekStart(nowMs));
  const oldestStartMs = currentStartMs - (weeks - 1) * MS_PER_WEEK;
  const buckets: Cell[][] = Array.from({ length: weeks }, () => []);

  for (const cell of cells) {
    const weekMs = Date.parse(`${cell.weekStart}T00:00:00.000Z`);
    if (!Number.isFinite(weekMs)) continue;
    const offset = Math.round((weekMs - oldestStartMs) / MS_PER_WEEK);
    if (offset < 0 || offset >= weeks) continue;
    buckets[offset]!.push(cell);
  }

  return buckets.map((bucketCells, offset) => {
    const weekStart = isoWeekStart(oldestStartMs + offset * MS_PER_WEEK);
    if (bucketCells.length === 0) return { weekStart, verdicts: null, accuracyPct: null };
    // Pooled across every registered instance in the week, matching how the headline pools (#9068): one
    // synthetic id, because this series is a fleet aggregate and not a per-instance figure.
    const folded = foldInstance("fleet", bucketCells);
    const verdicts = folded.counts.mergeVerdicts + folded.counts.closeVerdicts;
    if (verdicts < MIN_FLEET_TREND_VERDICTS || folded.decisionAccuracy === null) {
      return { weekStart, verdicts: null, accuracyPct: null };
    }
    return { weekStart, verdicts, accuracyPct: roundPct(folded.decisionAccuracy) };
  });
}

/**
 * Load the weekly fleet accuracy series. Fail-safe: `safeAll` swallows a read error into an empty result, so
 * a bad query yields all-null weeks rather than throwing the whole public stats payload.
 *
 * Only REGISTERED instances count, matching computeFleetAnalytics' own trust gate: the ingest is open, so a
 * stranger's signals must not move a published number until a human opts them in.
 */
export async function loadPublicFleetAccuracyTrend(env: Env, nowMs: number = Date.now()): Promise<PublicFleetAccuracyTrendWeek[]> {
  const sinceIso = new Date(Date.parse(isoWeekStart(nowMs)) - (PUBLIC_FLEET_TREND_WEEKS - 1) * MS_PER_WEEK).toISOString();
  // Bucket by when the gate DECIDED, not when the row arrived: a batch exported late would otherwise pile
  // weeks of decisions into the week it was received. `received_at` is the fallback only because
  // `decision_timestamp` is nullable in the schema.
  const cells = await safeAll<FleetTrendDayCell>(
    env,
    // instance_id is selected and grouped even though this series is a fleet aggregate: it keeps the rows a
    // genuine `Cell`, which is what foldInstance consumes, and summing per-instance cells within a week
    // yields exactly the pooled figure anyway. Narrowing the projection would mean hand-rolling a
    // near-Cell type and re-deriving the accounting -- the duplication foldInstance is exported to prevent.
    `SELECT substr(COALESCE(s.decision_timestamp, s.received_at), 1, 10) AS day, s.instance_id,
            s.gate_verdict AS verdict, s.outcome, s.reversal_flag, s.gate_reasoncode_bucket, COUNT(*) AS n
       FROM orb_signals s
       JOIN orb_instances i ON i.instance_id = s.instance_id AND i.registered = 1
      WHERE COALESCE(s.decision_timestamp, s.received_at) >= ?
      GROUP BY day, s.instance_id, s.gate_verdict, s.outcome, s.reversal_flag, s.gate_reasoncode_bucket`,
    sinceIso,
  );
  // isoWeekStart is applied here rather than in SQL: SQLite's strftime('%W') is not ISO-8601 week numbering,
  // and the own-ledger trend already owns this exact conversion in JS.
  const weekly: FleetTrendCell[] = [];
  for (const cell of cells) {
    const dayMs = Date.parse(`${cell.day}T00:00:00.000Z`);
    // A row whose timestamp column is unparseable is dropped rather than bucketed to the epoch, which would
    // silently land it outside the window anyway -- explicit is better than accidentally-correct.
    if (!Number.isFinite(dayMs)) continue;
    weekly.push({ ...cell, weekStart: isoWeekStart(dayMs) });
  }
  return buildPublicFleetAccuracyTrend(weekly, nowMs);
}
