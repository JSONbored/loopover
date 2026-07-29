// Threshold-backtest orchestration -- the "separate, I/O-touching slice" the pure analysis core
// (./threshold-backtest.ts) explicitly leaves to its caller, mirroring linked-issue-satisfaction-run.ts's own
// "pure core vs. I/O orchestration" split. Reads each affected ruleId's history directly via the already-shipped
// createSignalStore(env) adapter (#7982/#8101/#8104) -- no CLI, no subprocess, no wrangler; this runs inside
// ORB's own Worker request, which already has env.DB.
//
// Hard guarantees (mirrors linked-issue-satisfaction-run.ts's own fail-safe discipline):
//   • No changed threshold in the diff -> no result, never called for nothing.
//   • A SignalStore read failure for one ruleId degrades that ruleId to an empty corpus (a real, if uninformative,
//     backtest result -- null precision/recall, per #8085's own null-when-no-data discipline) rather than
//     aborting the whole advisory. This never blocks the PR either way -- see the epic's own Boundaries.
import { buildBacktestCorpus, checksumCases, type BacktestCase, type BacktestComparison } from "@loopover/engine";
import { createSignalStore } from "../review/signal-tracking-wire";
import { recordAuditEvent } from "../db/repositories";
import { backtestChangedThreshold, detectChangedThresholds, type ChangedThreshold } from "./threshold-backtest";

const CORPUS_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000; // 90 days -- generous enough for a young corpus to matter

export const THRESHOLD_BACKTEST_EVENT_TYPE = "calibration.threshold_backtest_run";

async function fetchCorpus(env: Env, ruleId: string, nowMs: number): Promise<BacktestCase[]> {
  try {
    const { fired, overrides } = await createSignalStore(env).queryRuleHistory(ruleId, nowMs - CORPUS_LOOKBACK_MS);
    return buildBacktestCorpus(ruleId, fired, overrides);
  } catch {
    // Fail open to an empty corpus (null precision/recall downstream), never throw -- a read failure for one
    // ruleId must not abort the whole advisory or, worse, the review pass that triggered it.
    return [];
  }
}

export type ThresholdBacktestRunResult = {
  changed: readonly ChangedThreshold[];
  comparisons: readonly BacktestComparison[];
  /** #9639: the freeze point per ruleId -- `checksumCases` over the corpus slice this run actually
   *  backtested, so the persisted audit event can point at a reproducible input. Keyed by ruleId because each
   *  rule is backtested against its OWN corpus; one checksum for the whole run would be a different rule's
   *  freeze point stamped onto this one. A ruleId whose corpus read failed still appears here, with the empty
   *  corpus's checksum -- that is a true statement about what was backtested, and the reader
   *  (loadPublicRulePrecision) is what declines to treat EMPTY_CORPUS_CHECKSUM as a publishable commitment. */
  corpusChecksumByRuleId: ReadonlyMap<string, string>;
};

/**
 * Detect any known threshold constant changed in `diff` and backtest each affected ruleId against its real
 * history. Returns `{ changed: [], comparisons: [] }` -- never null, never throws -- when nothing changed, so
 * the caller can check `comparisons.length` the same way it checks any other optional advisory result.
 * `diff` must be UNBUDGETED (see detectChangedThresholds's own doc comment) -- pass buildSecretScanDiff's
 * output, not buildAiReviewDiff's.
 */
export async function runThresholdBacktestAdvisory(env: Env, diff: string, nowMs: number = Date.now()): Promise<ThresholdBacktestRunResult> {
  const changed = detectChangedThresholds(diff);
  if (changed.length === 0) return { changed: [], comparisons: [], corpusChecksumByRuleId: new Map() };

  const ruleIds = [...new Set(changed.flatMap((change) => change.ruleIds))];
  const corpusByRuleId = new Map<string, BacktestCase[]>();
  for (const ruleId of ruleIds) corpusByRuleId.set(ruleId, await fetchCorpus(env, ruleId, nowMs));

  // Checksummed HERE, over the same map backtestChangedThreshold is about to score -- not re-read from the
  // store afterwards. A second read could return a different corpus (a new override landing mid-run), and a
  // freeze point that does not match the cases actually scored is worse than none: it invites a reader to
  // re-derive different numbers and conclude the published ones are wrong.
  const corpusChecksumByRuleId = new Map<string, string>();
  for (const [ruleId, cases] of corpusByRuleId) corpusChecksumByRuleId.set(ruleId, checksumCases(cases));

  const comparisons = changed.flatMap((change) => backtestChangedThreshold(change, corpusByRuleId));
  return { changed, comparisons, corpusChecksumByRuleId };
}

/** Persist each comparison for #8140's future track-record tool -- structured data via the shared
 *  audit_events table (recordAuditEvent, already used by every other write site in this epic), never a raw
 *  SQL string. Best-effort: `.catch(() => undefined)` at each call site, matching every other calibration
 *  write in this epic -- a persistence failure must never affect the review pass that produced the result. */
export async function persistThresholdBacktestRuns(
  env: Env,
  repoFullName: string,
  prNumber: number,
  changed: readonly ChangedThreshold[],
  comparisons: readonly BacktestComparison[],
  // #9639: optional so existing call sites that only have `changed`/`comparisons` keep compiling, but every
  // in-tree caller passes it -- without a checksum the event is exactly the one loadPublicRulePrecision
  // filters out with `corpusChecksum IS NOT NULL`, which is the bug this closes.
  corpusChecksumByRuleId: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  const comparisonsByRuleId = new Map(comparisons.map((comparison) => [comparison.ruleId, comparison]));
  for (const change of changed) {
    for (const ruleId of change.ruleIds) {
      const comparison = comparisonsByRuleId.get(ruleId);
      if (!comparison) continue;
      const corpusChecksum = corpusChecksumByRuleId.get(ruleId);
      await recordAuditEvent(env, {
        eventType: THRESHOLD_BACKTEST_EVENT_TYPE,
        actor: "loopover",
        targetKey: `${repoFullName}#${prNumber}`,
        // AuditEventRecord.outcome is a fixed enum (success/denied/error/queued/completed) -- it's not where
        // the backtest verdict goes. "completed" means "this run recorded successfully"; the real verdict
        // (improved/regressed/unchanged) lives in `detail` and `metadata.comparison.verdict` instead, mirroring
        // how every other telemetry-shaped audit event in this codebase uses "completed" for "happened, see detail".
        outcome: "completed",
        detail: `${change.constantName} threshold backtest for ${ruleId}: ${comparison.verdict}`,
        // corpusChecksum is a SIBLING of the existing keys, in the same position and under the same name
        // buildLogicBacktestAuditInsertSql writes it (scripts/backtest-logic-check-core.ts) -- the two writers
        // are siblings by design and loadPublicRulePrecision reads them through one query. `comparison` and
        // `constantName` are untouched: rule-calibration-trend.ts reads `$.comparison.verdict` off these rows.
        // Omitted rather than written as null when absent, so the reader's `IS NOT NULL` filter stays the
        // single place that decides whether a run is a usable freeze point.
        metadata: {
          comparison,
          constantName: change.constantName,
          ...(corpusChecksum === undefined ? {} : { corpusChecksum }),
        },
      }).catch(() => undefined);
    }
  }
}
