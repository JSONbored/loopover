// Rule/AI-judgment calibration trend (#8113, epic #8082). The fired+override history (#8101/#8104) and the
// persisted backtest runs (#8138/#8139) previously had no aggregate view — only per-PR advisory comments —
// so "is precision for rule X trending up or down" meant manually re-running CLIs. This is the maintainer-
// facing sibling of public-accuracy-trend.ts (#4447): the SAME deliberate no-cron posture (audit_events is
// already durable, so a live weekly re-bucketing recomputes any historical week correctly on every request —
// no rollup copy to drift), served from the /v1/internal/* operator surface, NOT the public stats payload
// (rule-level precision is operator observability, not homepage material).
//
// Precision semantics, deliberately trend-grained: a week's `decided` counts the human override events whose
// own created_at falls in that week (the DECISION week), and precisionPct = confirmed/decided over them.
// This is intentionally NOT computeRulePrecision's per-target fired↔override pairing (that corpus-exact
// pairing needs full event metadata, not day rollups) — the two answer different questions ("how are humans
// judging this rule's calls lately" vs "score this exact corpus") and must not be conflated.
import { safeAll } from "../review/public-stats";
import { isoWeekStart } from "./public-quality-metrics";

export const CALIBRATION_TREND_WEEKS = 8;
/** Below this many decided (confirmed+reversed) verdicts in a week, that week's precision is too noisy to
 *  report — mirrors MIN_ACCURACY_TREND_SAMPLE's role in the public trend. */
export const MIN_CALIBRATION_TREND_SAMPLE = 3;

const RULE_FIRED_EVENT_TYPE_PREFIX = "signal.rule_fired:";
const HUMAN_OVERRIDE_EVENT_TYPE_PREFIX = "signal.human_override:";
// Mirrors THRESHOLD_BACKTEST_EVENT_TYPE (src/services/threshold-backtest-run.ts) and the CI writer's
// LOGIC_BACKTEST_EVENT_TYPE (scripts/backtest-logic-check-core.ts) — the same hand-mirrored posture
// scripts/backtest-track-record.ts documents for why the scripts-side constant isn't imported here.
const BACKTEST_RUN_EVENT_TYPES = ["calibration.threshold_backtest_run", "calibration.logic_backtest_run"] as const;

export type CalibrationRuleTrendWeek = {
  /** UTC Monday (YYYY-MM-DD) that starts the bucket. */
  weekStart: string;
  fired: number;
  confirmed: number | null;
  reversed: number | null;
  precisionPct: number | null;
  /** Overrides whose `$.verdict` was missing or neither `'reversed'` nor `'confirmed'` -- a data-quality
   *  signal, always visible regardless of the publication floor (never folded into `confirmed`). */
  unrecognized: number;
};

export type CalibrationRuleTrend = { ruleId: string; weeks: CalibrationRuleTrendWeek[] };

export type BacktestRunTrendWeek = {
  weekStart: string;
  runs: number;
  regressed: number;
  improved: number;
  unchanged: number;
};

export type CalibrationTrendReport = {
  rules: CalibrationRuleTrend[];
  backtestRuns: BacktestRunTrendWeek[];
};

export type FiredDayRow = { ruleId: string; day: string; fired: number };
export type OverrideDayRow = { ruleId: string; day: string; confirmed: number; reversed: number; unrecognized: number };
export type BacktestRunDayRow = { day: string; regressed: number; improved: number; unchanged: number };

const MS_PER_WEEK = 7 * 86_400_000;

function roundPct(value: number): number {
  return Math.round(value * 1000) / 10;
}

/** Week offset of a day row inside the trailing window, or null when the day is unparseable or outside it. */
function weekOffsetOf(day: string, oldestStartMs: number, weeks: number): number | null {
  const dayMs = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(dayMs)) return null;
  const offset = Math.floor((dayMs - oldestStartMs) / MS_PER_WEEK);
  return offset < 0 || offset >= weeks ? null : offset;
}

/**
 * Fold day-granularity calibration rows into `weeks` trailing UTC-Monday buckets ending in the week
 * containing `nowMs`. Pure — mirrors buildPublicAccuracyTrend's bucketing shape exactly. Rules are sorted
 * by ruleId for byte-stable output; a week with fewer than {@link MIN_CALIBRATION_TREND_SAMPLE} decided
 * verdicts reports null confirmed/reversed/precisionPct (unknown stays unknown, never a fake 0 or 100).
 */
export function buildCalibrationTrend(
  firedRows: readonly FiredDayRow[],
  overrideRows: readonly OverrideDayRow[],
  runRows: readonly BacktestRunDayRow[],
  nowMs: number,
  weeks: number = CALIBRATION_TREND_WEEKS,
): CalibrationTrendReport {
  const currentStartMs = Date.parse(isoWeekStart(nowMs));
  const oldestStartMs = currentStartMs - (weeks - 1) * MS_PER_WEEK;

  const ruleBuckets = new Map<string, Array<{ fired: number; confirmed: number; reversed: number; unrecognized: number }>>();
  const bucketsFor = (ruleId: string) => {
    const existing = ruleBuckets.get(ruleId);
    if (existing) return existing;
    const created = Array.from({ length: weeks }, () => ({ fired: 0, confirmed: 0, reversed: 0, unrecognized: 0 }));
    ruleBuckets.set(ruleId, created);
    return created;
  };
  for (const row of firedRows) {
    const offset = weekOffsetOf(row.day, oldestStartMs, weeks);
    if (offset === null) continue;
    bucketsFor(row.ruleId)[offset]!.fired += row.fired;
  }
  for (const row of overrideRows) {
    const offset = weekOffsetOf(row.day, oldestStartMs, weeks);
    if (offset === null) continue;
    const bucket = bucketsFor(row.ruleId)[offset]!;
    bucket.confirmed += row.confirmed;
    bucket.reversed += row.reversed;
    bucket.unrecognized += row.unrecognized;
  }

  const runBuckets = Array.from({ length: weeks }, () => ({ regressed: 0, improved: 0, unchanged: 0 }));
  for (const row of runRows) {
    const offset = weekOffsetOf(row.day, oldestStartMs, weeks);
    if (offset === null) continue;
    const bucket = runBuckets[offset]!;
    bucket.regressed += row.regressed;
    bucket.improved += row.improved;
    bucket.unchanged += row.unchanged;
  }

  const rules: CalibrationRuleTrend[] = [...ruleBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ruleId, buckets]) => ({
      ruleId,
      weeks: buckets.map((bucket, offset) => {
        const decided = bucket.confirmed + bucket.reversed;
        const publishable = decided >= MIN_CALIBRATION_TREND_SAMPLE;
        return {
          weekStart: isoWeekStart(oldestStartMs + offset * MS_PER_WEEK),
          fired: bucket.fired,
          confirmed: publishable ? bucket.confirmed : null,
          reversed: publishable ? bucket.reversed : null,
          precisionPct: publishable ? roundPct(bucket.confirmed / decided) : null,
          unrecognized: bucket.unrecognized,
        };
      }),
    }));

  const backtestRuns: BacktestRunTrendWeek[] = runBuckets.map((bucket, offset) => ({
    weekStart: isoWeekStart(oldestStartMs + offset * MS_PER_WEEK),
    runs: bucket.regressed + bucket.improved + bucket.unchanged,
    regressed: bucket.regressed,
    improved: bucket.improved,
    unchanged: bucket.unchanged,
  }));

  return { rules, backtestRuns };
}

/** Day-bucketed rule firings — the ruleId is recovered from the event_type suffix (signal-tracking-wire.ts
 *  folds it into the type: `signal.rule_fired:<ruleId>`). */
async function loadFiredDayRows(env: Env, sinceIso: string): Promise<FiredDayRow[]> {
  const rows = await safeAll<{ rule_id: string; day: string; n: number }>(
    env,
    `SELECT substr(event_type, ${RULE_FIRED_EVENT_TYPE_PREFIX.length + 1}) AS rule_id, date(created_at) AS day, COUNT(*) AS n
       FROM audit_events
      WHERE event_type LIKE '${RULE_FIRED_EVENT_TYPE_PREFIX}%' AND created_at >= ?
      GROUP BY rule_id, day`,
    sinceIso,
  );
  return rows.map((row) => ({ ruleId: row.rule_id, day: row.day, fired: row.n }));
}

/** Day-bucketed human verdicts, split confirmed/reversed via the recorded `$.verdict` (signal-tracking-wire's
 *  recordHumanOverride writes it) — bucketed by the override's OWN created_at: this trend reports how humans
 *  are judging a rule's calls per decision week (see the module doc's precision-semantics note). */
async function loadOverrideDayRows(env: Env, sinceIso: string): Promise<OverrideDayRow[]> {
  const rows = await safeAll<{ rule_id: string; day: string; confirmed: number; reversed: number; unrecognized: number }>(
    env,
    `SELECT substr(event_type, ${HUMAN_OVERRIDE_EVENT_TYPE_PREFIX.length + 1}) AS rule_id, date(created_at) AS day,
            SUM(CASE WHEN json_extract(metadata_json, '$.verdict') = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
            SUM(CASE WHEN json_extract(metadata_json, '$.verdict') = 'reversed' THEN 1 ELSE 0 END) AS reversed,
            SUM(CASE WHEN json_extract(metadata_json, '$.verdict') NOT IN ('confirmed', 'reversed') OR json_extract(metadata_json, '$.verdict') IS NULL THEN 1 ELSE 0 END) AS unrecognized
       FROM audit_events
      WHERE event_type LIKE '${HUMAN_OVERRIDE_EVENT_TYPE_PREFIX}%' AND created_at >= ?
      GROUP BY rule_id, day`,
    sinceIso,
  );
  return rows.map((row) => ({
    ruleId: row.rule_id,
    day: row.day,
    /* v8 ignore next -- SUM(CASE ...) over a GROUP BY always yields a defined integer, never SQL NULL; the
     * ?? 0 fallbacks guard a future query-shape change, mirroring loadOrbDayRows' identical note. */
    confirmed: row.confirmed ?? 0,
    /* v8 ignore next */
    reversed: row.reversed ?? 0,
    /* v8 ignore next */
    unrecognized: row.unrecognized ?? 0,
  }));
}

/** Day-bucketed backtest runs across BOTH sibling event types, verdict read from the persisted
 *  `$.comparison.verdict` (the field backtest-track-record.ts's reader also anchors on). A row whose verdict
 *  is missing/unrecognized counts as `unchanged` — a malformed run must not vanish from `runs` entirely. */
async function loadBacktestRunDayRows(env: Env, sinceIso: string): Promise<BacktestRunDayRow[]> {
  const inList = BACKTEST_RUN_EVENT_TYPES.map((eventType) => `'${eventType}'`).join(", ");
  const rows = await safeAll<{ day: string; regressed: number; improved: number; unchanged: number }>(
    env,
    `SELECT date(created_at) AS day,
            SUM(CASE WHEN json_extract(metadata_json, '$.comparison.verdict') = 'regressed' THEN 1 ELSE 0 END) AS regressed,
            SUM(CASE WHEN json_extract(metadata_json, '$.comparison.verdict') = 'improved' THEN 1 ELSE 0 END) AS improved,
            SUM(CASE WHEN json_extract(metadata_json, '$.comparison.verdict') NOT IN ('regressed', 'improved') OR json_extract(metadata_json, '$.comparison.verdict') IS NULL THEN 1 ELSE 0 END) AS unchanged
       FROM audit_events
      WHERE event_type IN (${inList}) AND created_at >= ?
      GROUP BY day`,
    sinceIso,
  );
  /* v8 ignore next 2 -- same SUM(CASE)-never-NULL note as loadOverrideDayRows above. */
  return rows.map((row) => ({ day: row.day, regressed: row.regressed ?? 0, improved: row.improved ?? 0, unchanged: row.unchanged ?? 0 }));
}

/** Assemble the calibration trend live from audit_events. Fail-safe: each query degrades to [] on error
 *  (safeAll), so a single bad query yields under-counted weeks rather than a thrown operator endpoint. */
export async function loadCalibrationTrend(env: Env, nowMs: number = Date.now()): Promise<CalibrationTrendReport> {
  const sinceIso = new Date(Date.parse(isoWeekStart(nowMs)) - (CALIBRATION_TREND_WEEKS - 1) * MS_PER_WEEK).toISOString();
  const [firedRows, overrideRows, runRows] = await Promise.all([
    loadFiredDayRows(env, sinceIso),
    loadOverrideDayRows(env, sinceIso),
    loadBacktestRunDayRows(env, sinceIso),
  ]);
  return buildCalibrationTrend(firedRows, overrideRows, runRows, nowMs);
}
