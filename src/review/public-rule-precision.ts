// Public measured-accuracy surface (#8230, epic #8211 track G): per-rule precision over the trailing
// window, computed from the SAME human-verdict events the internal calibration reads — the public claim
// and the internal number can never diverge because they are one number. Aggregates and rule ids ONLY:
// no target keys, no repos, no confidence distributions, no corpus content (the issue's own exclusion
// list). Sparse rules report null precision, never a misreadable 0% — the same N/A-over-zero discipline
// as the #8085 scorer and the calibration trend.
//
// The `latestBacktestRun` block is the reproducibility hook (#8136's conclusion, operationalized): the
// most recent persisted backtest run's corpus checksum + timestamp is the freeze point a skeptic needs to
// independently re-run the comparison and verify the reported numbers are real.
import { safeAll } from "./public-stats";

/** Trailing window the public precision claim covers. Mirrors the 90-day corpus lookback the loosening
 *  loops evaluate over — the public number describes the same evidence the system acts on. */
export const PUBLIC_PRECISION_WINDOW_DAYS = 90;

/** Below this many decided cases a rule's precision is null on the public surface. Deliberately stiffer
 *  than the internal trend's weekly floor (MIN_CALIBRATION_TREND_SAMPLE = 3): a public percentage carries
 *  more weight than an operator chart, so it needs more evidence before it exists at all. */
export const PUBLIC_PRECISION_MIN_DECIDED = 10;

// Mirror signal-tracking-wire.ts's event-type folding (`signal.human_override:<ruleId>`) — the same local
// duplication rule-calibration-trend.ts documents for its identical queries.
const HUMAN_OVERRIDE_EVENT_TYPE_PREFIX = "signal.human_override:";

export type PublicRulePrecisionRow = {
  ruleId: string;
  decided: number;
  /** confirmed / decided, rounded to 3 decimals; null below {@link PUBLIC_PRECISION_MIN_DECIDED}. */
  precision: number | null;
};

export type PublicRulePrecision = {
  windowDays: number;
  rules: PublicRulePrecisionRow[];
  /** All three reversal shapes counted over the window — the "counted against ourselves" number. */
  reversals: { reopened: number; reverted: number; superseded: number };
  /** The latest persisted backtest run carrying a corpus checksum — the independently-verifiable freeze
   *  point — or null when no run has been recorded yet. */
  latestBacktestRun: { corpusChecksum: string; at: string } | null;
};

/**
 * Load the public per-rule precision block. Fail-safe per section (the same degradation contract as
 * loadCalibrationTrend): a read error yields an empty/absent section, never a thrown public endpoint.
 */
export async function loadPublicRulePrecision(env: Env, nowMs: number = Date.now()): Promise<PublicRulePrecision> {
  const sinceIso = new Date(nowMs - PUBLIC_PRECISION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const overrideRows = await safeAll<{ rule_id: string; decided: number; reversed: number }>(
    env,
    `SELECT substr(event_type, ${HUMAN_OVERRIDE_EVENT_TYPE_PREFIX.length + 1}) AS rule_id, COUNT(*) AS decided,
            SUM(CASE WHEN json_extract(metadata_json, '$.verdict') = 'reversed' THEN 1 ELSE 0 END) AS reversed
       FROM audit_events
      WHERE event_type LIKE '${HUMAN_OVERRIDE_EVENT_TYPE_PREFIX}%' AND created_at >= ?
      GROUP BY rule_id`,
    sinceIso,
  );
  const rules: PublicRulePrecisionRow[] = overrideRows
    .map((row) => {
      /* v8 ignore next 2 -- SUM(CASE) over a GROUP BY always yields a defined integer; the ?? guards a
       * future query-shape change, mirroring loadOverrideDayRows' identical note. */
      const reversed = row.reversed ?? 0;
      const decided = row.decided;
      return {
        ruleId: row.rule_id,
        decided,
        precision: decided >= PUBLIC_PRECISION_MIN_DECIDED ? Math.round(((decided - reversed) / decided) * 1000) / 1000 : null,
      };
    })
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId));

  const reversalRows = await safeAll<{ event_type: string; n: number }>(
    env,
    `SELECT event_type, COUNT(*) AS n FROM audit_events
      WHERE event_type IN ('reversal_reopened', 'reversal_reverted', 'reversal_superseded') AND created_at >= ?
      GROUP BY event_type`,
    sinceIso,
  );
  const reversalCount = (eventType: string) => reversalRows.find((row) => row.event_type === eventType)?.n ?? 0;

  const runRows = await safeAll<{ checksum: string; created_at: string }>(
    env,
    `SELECT json_extract(metadata_json, '$.corpusChecksum') AS checksum, created_at FROM audit_events
      WHERE event_type IN ('calibration.threshold_backtest_run', 'calibration.logic_backtest_run')
        AND json_extract(metadata_json, '$.corpusChecksum') IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
  );
  const latest = runRows[0];

  return {
    windowDays: PUBLIC_PRECISION_WINDOW_DAYS,
    rules,
    reversals: {
      reopened: reversalCount("reversal_reopened"),
      reverted: reversalCount("reversal_reverted"),
      superseded: reversalCount("reversal_superseded"),
    },
    latestBacktestRun: latest && typeof latest.checksum === "string" && latest.checksum !== "" ? { corpusChecksum: latest.checksum, at: latest.created_at } : null,
  };
}
