import { renderMinerPredictionMetrics } from "@loopover/engine";
import type { MinerPredictionMetricRow } from "@loopover/engine";
import { toOutcomeRecords, toPredictionRecords } from "./calibration-cli.js";
import { normalizeDecision } from "./calibration.js";
import { initEventLedger, resolveEventLedgerDbPath } from "./event-ledger.js";
import type { EventLedger, LedgerEntry } from "./event-ledger.js";
import { initPredictionLedger, resolvePredictionLedgerDbPath } from "./prediction-ledger.js";
import type { PredictionLedger } from "./prediction-ledger.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

// `metrics` (#4838): render the miner's prediction-calibration counters as Prometheus text-exposition to stdout,
// for a scrape wrapper or cron redirect. The counters are produced by the engine's already-built
// renderMinerPredictionMetrics (packages/loopover-engine/src/miner-prediction-metrics.ts) -- this command only
// reads the local prediction ledger + realized `pr_outcome` event stream and feeds them in, never touching the
// renderer itself. Strictly local + offline: no network, no writes.

const METRICS_USAGE = "Usage: loopover-miner metrics";

// Key an outcome/prediction by its (project, targetId) exactly as calibration.ts's own join does, so metrics
// resolves each prediction against the identical (project, targetId) pairing buildCalibrationReport uses.
function recordKey(project: string, targetId: string): string {
  return `${project} ${targetId}`;
}

// Resolve one prediction's realized-outcome pairing against its observed decision (`undefined` when none was
// observed for its (project, targetId)), mirroring buildCalibrationReport's own classification: a prediction is
// scored only when it itself normalizes to `merge`/`close` AND its observed outcome also normalizes to
// `merge`/`close` -- `true` when they match, `false` when they differ. A `hold`/unrecognized prediction, a
// still-pending row (no outcome), or an unclassifiable outcome all stay unresolved (`correct` left unset); an
// undecided row is never fabricated as `false`.
function resolveCorrect(predictedDecision: string, observedDecision: string | undefined): boolean | undefined {
  const predicted = normalizeDecision(predictedDecision);
  if (predicted !== "merge" && predicted !== "close") return undefined;
  if (observedDecision === undefined) return undefined;
  const observed = normalizeDecision(observedDecision);
  if (observed !== "merge" && observed !== "close") return undefined;
  return predicted === observed;
}

/**
 * Project prediction-ledger rows onto the engine renderer's metric-row shape: the predicted `conclusion`, plus the
 * realized-outcome pairing (`correct`) resolved through the SAME join `calibration-cli.ts` already uses (#8315).
 * Each prediction's outcome is looked up by its `(project, targetId)` among the latest `pr_outcome` events
 * (`toOutcomeRecords`) and compared against the prediction (`toPredictionRecords`), both normalized through
 * calibration.ts's `normalizeDecision` exactly as `buildCalibrationReport` does. A row is left unresolved
 * (`correct` omitted) when it is still pending (no realized outcome), when its own conclusion is `hold` (which has
 * no `merged`/`closed` counterpart), or when the realized outcome is unclassifiable -- never fabricating `false`
 * for an undecided row. Resolved rows carry `correct: true` when the normalized prediction matches the realized
 * decision, `false` when they differ.
 */
export function collectPredictionMetricRows(
  ledger: PredictionLedger,
  events: LedgerEntry[] = [],
): MinerPredictionMetricRow[] {
  const outcomeByKey = new Map<string, string>();
  for (const outcome of toOutcomeRecords(events)) {
    outcomeByKey.set(recordKey(outcome.project, outcome.targetId), outcome.outcomeDecision);
  }
  return toPredictionRecords(ledger.readPredictions()).map((prediction) => {
    const correct = resolveCorrect(prediction.predictedDecision, outcomeByKey.get(recordKey(prediction.project, prediction.targetId)));
    return correct === undefined
      ? { conclusion: prediction.predictedDecision }
      : { conclusion: prediction.predictedDecision, correct };
  });
}

// Open the local prediction ledger (or a test-injected one) for the duration of `run`, closing it only when we
// opened it -- an injected ledger is owned by the caller. Mirrors event-ledger-cli.js's withEventLedger.
function withPredictionLedger<T>(
  options: { initPredictionLedger?: () => PredictionLedger },
  env: Record<string, string | undefined>,
  run: (ledger: PredictionLedger) => T,
): T {
  const ownsLedger = options.initPredictionLedger === undefined;
  const ledger = (options.initPredictionLedger ?? (() => initPredictionLedger(resolvePredictionLedgerDbPath(env))))();
  try {
    return run(ledger);
  } finally {
    if (ownsLedger) ledger.close();
  }
}

// Open the local event ledger (or a test-injected one) for the duration of `run`, closing it only when we opened
// it. Mirrors withPredictionLedger above and calibration-cli.ts's bare `calibration` command: open via
// initEventLedger(resolveEventLedgerDbPath(env)), read once, close in a finally -- keeping `metrics` strictly
// read-only and offline with no behavior change to its zero-argument usage contract.
function withEventLedger<T>(
  options: { initEventLedger?: () => EventLedger },
  env: Record<string, string | undefined>,
  run: (ledger: EventLedger) => T,
): T {
  const ownsLedger = options.initEventLedger === undefined;
  const ledger = (options.initEventLedger ?? (() => initEventLedger(resolveEventLedgerDbPath(env))))();
  try {
    return run(ledger);
  } finally {
    if (ownsLedger) ledger.close();
  }
}

export function runMetrics(
  args: string[],
  options: {
    initPredictionLedger?: () => PredictionLedger;
    initEventLedger?: () => EventLedger;
    env?: Record<string, string | undefined>;
  } = {},
): number {
  if (args.length > 0) {
    return reportCliFailure(argsWantJson(args), METRICS_USAGE);
  }

  const env = options.env ?? process.env;
  try {
    return withPredictionLedger(options, env, (ledger) =>
      withEventLedger(options, env, (eventLedger) => {
        // renderMinerPredictionMetrics returns a newline-terminated document; console.log re-adds the terminator,
        // so trim it to emit exactly one trailing newline.
        console.log(renderMinerPredictionMetrics(collectPredictionMetricRows(ledger, eventLedger.readEvents())).trimEnd());
        return 0;
      }),
    );
  } catch (error) {
    return reportCliFailure(argsWantJson(args), describeCliError(error));
  }
}
