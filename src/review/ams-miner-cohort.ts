// AMS-vs-human contributor-mix dashboard panel (#6488), per #6210's decided design: for one repo, classify each
// recent submitter as "has AMS track-record data" (via the ORB/AMS reputation bridge's pull path, #6485/#6208)
// vs. not, then compare acceptance rate / review-cycle count / time-to-merge / PR volume between the two
// cohorts. Reuses `submitter-reputation.ts`'s existing outcome classification (`listSubmitterCohortRows`, #9136:
// repointed off the orphaned `review_targets` table onto the live `review_audit`/`pull_requests` ledgers — this
// module needed no changes of its own to pick that up) for the metrics, and `ams-reputation-bridge.ts`'s
// existing fail-safe, timeout-bounded pull for AMS membership — no new identity system, no new network path.
//
// BOUNDED, NOT EXHAUSTIVE: classifying membership needs one live call per distinct submitter login (there is no
// cached "is this login an AMS miner" flag anywhere yet). An unbounded per-dashboard-load fan-out over every
// submitter a repo has ever seen would be real added latency/cost, so this checks only the
// AMS_MINER_COHORT_CHECK_CAP most active submitters (by submission volume) in the window; every other submitter
// is counted in the human cohort by default (an unchecked submitter is never assumed to be an AMS miner —
// "not classified" always falls to the conservative side, same discipline as the bridge's own upgrade-only
// rule). `checkedSubmitterCount`/`totalSubmitterCount` disclose the cap so a caller never silently reads
// "covered everyone" from a capped result.
//
// Bearer-gated, maintainer-only (see the API route this feeds) — matches submitter-reputation.ts's own /stats
// access model. STRICTLY INTERNAL: no wallet/hotkey/reward/trust-score wording, matching every other reputation
// surface in this codebase, public or private.

import { fetchAmsTrackRecord, type AmsTrackRecordFetch } from "./ams-reputation-bridge";
import { isAmsReputationBridgeEnabled, resolveAmsTrackRecordEndpoint } from "./ams-reputation-bridge-wire";
import { listSubmitterCohortRows, REPUTATION_WINDOW_DAYS, type SubmitterCohortRow } from "./submitter-reputation";

/** How many of a repo's most active submitters (by submission volume) get a live AMS track-record check.
 *  Bounds per-dashboard-load network fan-out; see this module's own header comment for the classification
 *  fallback when a repo has more distinct submitters than this. */
export const AMS_MINER_COHORT_CHECK_CAP = 25;

export type AmsMinerCohortMetrics = {
  submitterCount: number;
  prVolume: number;
  /** merged / (merged + closed) over the cohort's terminal rows, `null` when the cohort has no terminal rows
   *  to divide by (never fabricated as 0, which would misleadingly read as "0% acceptance"). */
  acceptanceRate: number | null;
  /** Mean of each submitter's own average review-cycle-count proxy per #6488's requirements — `null` when
   *  the cohort is empty. Sourced from `pull_requests.merge_attempt_count` (#9136: the pre-repoint
   *  `review_targets.attempt_count`, the gate's own re-review counter, has no live equivalent; see
   *  `SubmitterCohortRow.avgAttemptCount`'s own doc comment in submitter-reputation.ts for the documented,
   *  narrower substitution this reuses). */
  avgReviewCycleCount: number | null;
  /** Mean time-to-merge in ms across the cohort's MERGED rows only, `null` when the cohort has no merges. */
  avgTimeToMergeMs: number | null;
};

export type AmsMinerCohortComparison = {
  present: boolean;
  windowDays: number;
  totalSubmitterCount: number;
  checkedSubmitterCount: number;
  amsCohort: AmsMinerCohortMetrics;
  humanCohort: AmsMinerCohortMetrics;
};

const EMPTY_METRICS: AmsMinerCohortMetrics = { submitterCount: 0, prVolume: 0, acceptanceRate: null, avgReviewCycleCount: null, avgTimeToMergeMs: null };

const ABSENT_COMPARISON: AmsMinerCohortComparison = {
  present: false,
  windowDays: 0,
  totalSubmitterCount: 0,
  checkedSubmitterCount: 0,
  amsCohort: EMPTY_METRICS,
  humanCohort: EMPTY_METRICS,
};

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** PURE: aggregate one cohort's rows into the four #6488-required metrics. */
export function computeCohortMetrics(rows: readonly SubmitterCohortRow[]): AmsMinerCohortMetrics {
  if (rows.length === 0) return EMPTY_METRICS;
  const prVolume = rows.reduce((sum, row) => sum + row.submissions, 0);
  const merged = rows.reduce((sum, row) => sum + row.merged, 0);
  const closed = rows.reduce((sum, row) => sum + row.closed, 0);
  const terminal = merged + closed;
  const mergeDurations = rows.filter((row) => row.avgMergeMs !== null).map((row) => row.avgMergeMs as number);
  return {
    submitterCount: rows.length,
    prVolume,
    acceptanceRate: terminal > 0 ? merged / terminal : null,
    avgReviewCycleCount: average(rows.map((row) => row.avgAttemptCount)),
    avgTimeToMergeMs: average(mergeDurations),
  };
}

/** PURE: split cohort rows by AMS-track-record membership. `amsLogins` is case-insensitive, matching GitHub
 *  login semantics (mirrors `ams-reputation-bridge.ts`'s own `outcomesForLogin`). */
export function splitCohortRows(rows: readonly SubmitterCohortRow[], amsLogins: ReadonlySet<string>): { ams: SubmitterCohortRow[]; human: SubmitterCohortRow[] } {
  const ams: SubmitterCohortRow[] = [];
  const human: SubmitterCohortRow[] = [];
  for (const row of rows) {
    (amsLogins.has(row.submitter.trim().toLowerCase()) ? ams : human).push(row);
  }
  return { ams, human };
}

export type AmsMinerCohortOptions = {
  windowDays?: number | undefined;
  fetchImpl?: AmsTrackRecordFetch | undefined;
  timeoutMs?: number | undefined;
};

/**
 * Build the AMS-vs-human cohort comparison for one repo (#6488). `present: false` — never an error state — when
 * the bridge feature is off, no AMS endpoint is configured, or the repo has no submitter activity in the
 * window: every one of those reads as "no identifiable AMS activity" to the caller, exactly per this issue's
 * required empty state. Never throws: `listSubmitterCohortRows`/`fetchAmsTrackRecord` are already fail-safe.
 */
export async function buildAmsMinerCohortComparison(env: Env, repoFullName: string, options: AmsMinerCohortOptions = {}): Promise<AmsMinerCohortComparison> {
  if (!isAmsReputationBridgeEnabled(env)) return ABSENT_COMPARISON;
  const endpoint = resolveAmsTrackRecordEndpoint(env);
  if (!endpoint) return ABSENT_COMPARISON;

  const windowDays = options.windowDays ?? REPUTATION_WINDOW_DAYS;
  const rows = await listSubmitterCohortRows(env, repoFullName, windowDays);
  if (rows.length === 0) return { ...ABSENT_COMPARISON, windowDays };

  const checked = [...rows].sort((a, b) => b.submissions - a.submissions).slice(0, AMS_MINER_COHORT_CHECK_CAP);
  const bridgeOptions = { endpoint, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs };
  const lookups = await Promise.all(checked.map((row) => fetchAmsTrackRecord(row.submitter, bridgeOptions)));
  const amsLogins = new Set<string>();
  checked.forEach((row, index) => {
    const outcomes = lookups[index];
    if (outcomes !== null && outcomes !== undefined && outcomes.length > 0) amsLogins.add(row.submitter.trim().toLowerCase());
  });

  const { ams, human } = splitCohortRows(rows, amsLogins);
  return {
    present: true,
    windowDays,
    totalSubmitterCount: rows.length,
    checkedSubmitterCount: checked.length,
    amsCohort: computeCohortMetrics(ams),
    humanCohort: computeCohortMetrics(human),
  };
}
