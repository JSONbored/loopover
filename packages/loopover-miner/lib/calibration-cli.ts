// `loopover-miner calibration [--json]` (#4849): a read-only report joining the miner's own predicted gate
// verdicts (prediction-ledger) with the realized PR outcomes it later observed (event-ledger `pr_outcome`
// events), via the pure buildCalibrationReport join. Opens both local stores, maps their rows to the
// calibration record shapes, renders, and closes. Never modifies the live scoring/calibration logic.
import type { existsSync, readFileSync } from "node:fs";
import { AMS_GATE_PREDICTION_RULE_ID, buildAmsPredictionCorpus, computeAmsCorpusStats, renderBacktestComparison } from "@loopover/engine";
import type { AmsPredictionRecord, AmsRealizedOutcome } from "@loopover/engine";
import {
  AMS_MIN_RANK_HARD_MAXIMUM,
  AMS_MIN_RANK_SHIPPED,
  applyMinRankOverride,
  backtestMinRankCandidate,
  buildAmsBacktestProposals,
  computeAmsBacktestTrackRecord,
  readAmsThresholdBacktestRuns,
  readMinRankAutotuneEnabled,
  readMinRankOverride,
  recordAmsThresholdBacktestRun,
  revertMinRankOverride,
} from "./ams-calibration.js";
import { buildCalibrationReport } from "./calibration.js";
import { initEventLedger, resolveEventLedgerDbPath } from "./event-ledger.js";
import type { LedgerEntry } from "./event-ledger.js";
import { MINER_PR_OUTCOME_EVENT } from "./pr-outcome.js";
import { initPredictionLedger, resolvePredictionLedgerDbPath } from "./prediction-ledger.js";
import type { PredictionLedgerEntry } from "./prediction-ledger.js";
import type { PredictedVerdictRecord, ObservedOutcomeRecord, CalibrationReport } from "./calibration-types.js";
import { reportCliFailure, describeCliError } from "./cli-error.js";

const CALIBRATION_USAGE =
  "Usage: loopover-miner calibration [--json] | calibration backtest-threshold --candidate <x> [--json] | calibration apply-min-rank --candidate <x> --approve [--json] | calibration revert-min-rank --approve [--json]";

export type CalibrationCliDeps = {
  readFileSync?: typeof readFileSync;
  existsSync?: typeof existsSync;
  nowMs?: number;
};

function parseCandidate(args: string[]): number | null {
  const index = args.indexOf("--candidate");
  if (index === -1 || index + 1 >= args.length) return null;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : null;
}

/** Map prediction-ledger rows to predicted-verdict records: the target id becomes a string key and the recorded
 *  prediction verdict is the `conclusion`. Exported so callers other than this CLI (the MCP calibration-report
 *  tool, #5821) can build the identical join without re-implementing the mapping. */
export function toPredictionRecords(rows: PredictionLedgerEntry[]): PredictedVerdictRecord[] {
  return rows.map((row) => ({
    project: row.repoFullName,
    targetId: String(row.targetId),
    predictedDecision: row.conclusion,
    recordedAt: row.ts,
  }));
}

/** Reduce the append-only `pr_outcome` event stream to the LATEST observed outcome per (repo, PR), as
 *  observed-outcome records. `recordedAt` comes from the event's own timestamp (always present), so an outcome is
 *  never dropped for lacking a `closedAt`. Malformed payloads are skipped. Exported for the same reason as
 *  {@link toPredictionRecords} above. */
export function toOutcomeRecords(events: LedgerEntry[]): ObservedOutcomeRecord[] {
  const latest = new Map<string, ObservedOutcomeRecord>();
  for (const event of events) {
    if (event?.type !== MINER_PR_OUTCOME_EVENT) continue;
    const payload = event.payload;
    if (!payload || !Number.isInteger(payload.prNumber) || typeof payload.decision !== "string") continue;
    latest.set(`${event.repoFullName}:${payload.prNumber}`, {
      // ObservedOutcomeRecord.project is declared non-nullable, but LedgerEntry.repoFullName is `string | null`
      // for other event kinds; a pr_outcome event always carries a real repoFullName in practice, so this passes
      // the value through unchanged rather than substituting a fallback that would be a behavior change.
      project: event.repoFullName as string,
      targetId: String(payload.prNumber),
      outcomeDecision: payload.decision,
      recordedAt: event.createdAt,
    });
  }
  return [...latest.values()];
}

/** Project prediction-ledger rows into the engine adapter's record shape (#8183). Exported for the same
 *  reuse reason as {@link toPredictionRecords}. */
export function toAmsPredictionRecords(rows: PredictionLedgerEntry[]): AmsPredictionRecord[] {
  return rows.map((row) => ({
    repoFullName: row.repoFullName,
    targetId: row.targetId,
    headSha: row.headSha,
    conclusion: row.conclusion,
    readinessScore: row.readinessScore,
    engineVersion: row.engineVersion,
    ts: row.ts,
  }));
}

/** Reduce pr_outcome events to the engine adapter's realized-outcome shape — latest per (repo, PR), the
 *  same reduction contract readPrOutcomes documents (#8183). */
export function toAmsRealizedOutcomes(events: LedgerEntry[]): AmsRealizedOutcome[] {
  const latest = new Map<string, AmsRealizedOutcome>();
  for (const event of events) {
    if (event?.type !== MINER_PR_OUTCOME_EVENT) continue;
    const prNumber = event.payload?.prNumber;
    const decision = event.payload?.decision;
    if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || typeof decision !== "string") continue;
    if (typeof event.repoFullName !== "string" || !event.repoFullName.trim()) continue;
    const key = `${event.repoFullName}:${prNumber}`;
    latest.delete(key); // re-key so a later outcome supersedes in iteration order too (mirrors readPrOutcomes)
    latest.set(key, { repoFullName: event.repoFullName, prNumber, decision, recordedAt: event.createdAt });
  }
  return [...latest.values()];
}

function renderReportText(report: CalibrationReport): void {
  if (!report.hasSignal) {
    console.log("calibration: no decided predictions yet (predictions need a realized merge/close outcome).");
    return;
  }
  for (const row of report.rows) {
    const merge = row.mergePrecision === null ? "n/a" : `${Math.round(row.mergePrecision * 100)}%`;
    const close = row.closePrecision === null ? "n/a" : `${Math.round(row.closePrecision * 100)}%`;
    console.log(
      `${row.project}: ${row.decided} decided | ` +
        `merge ${row.mergeConfirmed}/${row.wouldMerge} (${merge}) | ` +
        `close ${row.closeConfirmed}/${row.wouldClose} (${close}) | hold ${row.hold}`,
    );
  }
}

/** `calibration backtest-threshold --candidate <x>` (#8184): advisory replay of a candidate min-rank skip
 *  threshold against the taken-opportunity corpus. Prints the shared comparison renderer's report and
 *  persists the run event. Exit is nonzero ONLY on operational error -- never on verdict (the #8138
 *  advisory guarantee); an under-floored corpus prints an explicit line and exits 0. */
function runBacktestThreshold(args: string[], env: Record<string, string | undefined>, deps: CalibrationCliDeps): number {
  const json = args.includes("--json");
  const candidate = parseCandidate(args);
  if (candidate === null) return reportCliFailure(json, `Missing or invalid --candidate. ${CALIBRATION_USAGE}`, 1);

  let eventLedger;
  try {
    eventLedger = initEventLedger(resolveEventLedgerDbPath(env));
    const events = eventLedger.readEvents();
    const enabled = readMinRankAutotuneEnabled(env, deps);
    const current = readMinRankOverride(eventLedger, { enabled }) ?? AMS_MIN_RANK_SHIPPED;
    const result = backtestMinRankCandidate(events, current, candidate);
    if (!result) {
      const message = "backtest-threshold: not enough labeled taken opportunities yet (both splits must clear their sample floors); no verdict, nothing persisted.";
      console.log(json ? JSON.stringify({ ran: false, reason: "insufficient_corpus" }) : message);
      return 0;
    }
    recordAmsThresholdBacktestRun(result, { eventLedger });
    if (json) {
      console.log(JSON.stringify({ ran: true, ...result }, null, 2));
    } else {
      console.log(`min-rank skip threshold: current ${result.currentThreshold} -> candidate ${result.candidateThreshold}`);
      console.log(`visible split (${result.visibleCases} case(s)):`);
      console.log(renderBacktestComparison(result.visible));
      console.log(`held-out split (${result.heldOutCases} case(s)):`);
      console.log(renderBacktestComparison(result.heldOut));
      console.log("advisory only: no threshold changed; the run event was persisted for the track record.");
    }
    return 0;
  } catch (error) {
    return reportCliFailure(json, describeCliError(error));
  } finally {
    eventLedger?.close();
  }
}

/** `calibration apply-min-rank --candidate <x> --approve` / `calibration revert-min-rank --approve`
 *  (#8187): the double-gated apply and its one-command revert. Exit 1 when the command did NOT move the
 *  knob (refusal or usage error) so scripts can tell; 0 only on a real apply/revert. */
function runMinRankMutation(kind: "apply" | "revert", args: string[], env: Record<string, string | undefined>, deps: CalibrationCliDeps): number {
  const json = args.includes("--json");
  const approved = args.includes("--approve");
  let eventLedger;
  try {
    eventLedger = initEventLedger(resolveEventLedgerDbPath(env));
    const enabled = readMinRankAutotuneEnabled(env, deps);
    if (kind === "revert") {
      const result = revertMinRankOverride({ eventLedger, approved });
      if (!result.reverted) {
        return reportCliFailure(json, "revert-min-rank refused: pass --approve to confirm (the reversion is itself a knob movement).", 1);
      }
      console.log(json ? JSON.stringify({ reverted: true, restoredValue: AMS_MIN_RANK_SHIPPED }) : `min-rank override reverted; shipped default ${AMS_MIN_RANK_SHIPPED} is live again.`);
      return 0;
    }
    const candidate = parseCandidate(args);
    if (candidate === null) return reportCliFailure(json, `Missing or invalid --candidate. ${CALIBRATION_USAGE}`, 1);
    const result = applyMinRankOverride(candidate, { eventLedger, enabled, approved, ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs } : {}) });
    if (!result.applied) {
      const detail: Record<string, string> = {
        flag_off: "set minRankAutotuneEnabled: true in .loopover-ams.yml first (gate one of two).",
        not_approved: "pass --approve to confirm (gate two of two).",
        out_of_bounds: `candidate must sit inside (${AMS_MIN_RANK_SHIPPED}, ${AMS_MIN_RANK_HARD_MAXIMUM}] -- no evidence may cross the hard bounds.`,
        no_supporting_run: "no recent persisted backtest run cleared this exact candidate -- run calibration backtest-threshold first; evidence is not optional.",
      };
      return reportCliFailure(json, `apply-min-rank refused (${result.reason}): ${detail[result.reason]}`, 1);
    }
    console.log(json ? JSON.stringify({ applied: true, value: candidate }) : `min-rank override ${candidate} applied (evidence recorded on the ledger event); revert any time with calibration revert-min-rank --approve.`);
    return 0;
  } catch (error) {
    return reportCliFailure(json, describeCliError(error));
  } finally {
    eventLedger?.close();
  }
}

/**
 * Run `loopover-miner calibration [--json]` (or one of the #8184/#8187 subcommands -- see
 * CALIBRATION_USAGE). The bare form reads the prediction ledger + PR-outcome events, joins them into a
 * calibration report, and prints it (a JSON dump under `--json`, else a per-project text summary) along
 * with the corpus stats, the backtest track record (#8185), and any current backtest-cleared proposals
 * (#8186). Returns the process exit code: 0 on success, 1 on an unknown option.
 */
export function runCalibrationCli(args: string[] = [], env: Record<string, string | undefined> = process.env, deps: CalibrationCliDeps = {}): number {
  if (args[0] === "backtest-threshold") return runBacktestThreshold(args.slice(1), env, deps);
  if (args[0] === "apply-min-rank") return runMinRankMutation("apply", args.slice(1), env, deps);
  if (args[0] === "revert-min-rank") return runMinRankMutation("revert", args.slice(1), env, deps);
  const json = args.includes("--json");
  // This command takes no positional arguments, so anything that is not `--json` is a mistake -- including a
  // bare positional (`calibration foo`), which a `startsWith("-")` check silently let through (#5834). Mirrors
  // the strict zero-positional discipline `ledger list` (event-ledger-cli.js) already applies.
  const unknown = args.find((token) => token !== "--json");
  if (unknown) {
    return reportCliFailure(json, `Unknown option: ${unknown}. ${CALIBRATION_USAGE}`, 1);
  }

  let predictionStore;
  let eventLedger;
  try {
    predictionStore = initPredictionLedger(resolvePredictionLedgerDbPath(env));
    eventLedger = initEventLedger(resolveEventLedgerDbPath(env));
    const predictionRows = predictionStore.readPredictions();
    const events = eventLedger.readEvents();
    const report = buildCalibrationReport(toPredictionRecords(predictionRows), toOutcomeRecords(events));
    // #8183: the labeled backtest corpus over the same two ledgers — aggregate numbers only, the local
    // evidence base every later AMS backtest (#8184+) replays against. Corpus content never prints.
    const corpusStats = computeAmsCorpusStats(buildAmsPredictionCorpus(toAmsPredictionRecords(predictionRows), toAmsRealizedOutcomes(events)));
    // #8185/#8186: the advisory backtests' own earned-authority view over the persisted run events.
    const runs = readAmsThresholdBacktestRuns(eventLedger);
    const trackRecord = computeAmsBacktestTrackRecord(runs);
    const proposals = buildAmsBacktestProposals(runs, deps.nowMs ?? Date.now());
    if (json) {
      console.log(
        JSON.stringify(
          {
            ...report,
            corpus: { ruleId: AMS_GATE_PREDICTION_RULE_ID, ...corpusStats },
            backtestTrackRecord: { totalRuns: trackRecord.totalRuns, regressedRuns: trackRecord.regressedRuns, regressedRate: trackRecord.regressedRate },
            backtestProposals: proposals,
          },
          null,
          2,
        ),
      );
    } else {
      renderReportText(report);
      console.log(
        corpusStats.cases === 0
          ? "corpus: no labeled cases yet (a case needs a directional prediction AND a realized merge/close outcome)."
          : // engineVersions is never empty alongside cases > 0: appendPrediction refuses a blank
            // engineVersion at the ledger boundary (normalizePredictionInput's invalid_engine_version).
            `corpus (${AMS_GATE_PREDICTION_RULE_ID}): ${corpusStats.cases} case(s) | confirmed ${corpusStats.confirmed} | reversed ${corpusStats.reversed} | engine build(s): ${corpusStats.engineVersions.join(", ")}`,
      );
      // #8185: never a blank -- an empty history says so explicitly.
      console.log(
        trackRecord.totalRuns === 0
          ? "backtest track record: no backtest runs recorded."
          : `backtest track record: ${trackRecord.totalRuns} comparison(s) | REGRESSED ${trackRecord.regressedRuns} (rate ${trackRecord.regressedRate === null ? "n/a" : trackRecord.regressedRate.toFixed(3)})`,
      );
      // #8186: proposals surface with full evidence and the explicit no-autonomy line.
      for (const proposal of proposals) {
        console.log(
          `backtest-cleared proposal: min-rank ${proposal.currentThreshold} -> ${proposal.candidateThreshold} | visible ${proposal.visibleVerdict} (${proposal.visibleCases}) | held-out ${proposal.heldOutVerdict} (${proposal.heldOutCases}) | ${proposal.at ?? "undated"}`,
        );
      }
      if (proposals.length > 0) console.log("nothing applies automatically: apply-min-rank requires the config flag AND --approve.");
    }
    return 0;
  } catch (error) {
    return reportCliFailure(json, describeCliError(error));
  } finally {
    predictionStore?.close();
    eventLedger?.close();
  }
}
