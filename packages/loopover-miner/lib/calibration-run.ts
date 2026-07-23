// Phase 7 calibration runner (#4248): the miner-side runner that finally CONNECTS the two finished-but-unwired
// halves #3014 left apart. #3014 landed the engine's pure calibration *combine* contract
// (`computePhase7CalibrationLoop`, packages/loopover-engine/src/phase7-calibration-loop.ts) and #3012 landed the
// deterministic replay *scorer* (`computeObjectiveAnchor`, ./replay-objective-anchor.js), but nothing ever called
// one with the other -- #3014's issue claimed "wired" while only the engine side shipped. This module is the
// missing runner: it scores a completed historical-replay run with the objective-anchor scorer, folds the
// resulting composite into the `HistoricalReplayCalibrationInput` shape the engine expects, calls the combine with
// the existing pr_outcome signal, and PERSISTS the combined snapshot to the local append-only event ledger (a typed
// event layered on event-ledger.js exactly like pr-outcome.js's MINER_PR_OUTCOME_EVENT), queryable via
// `loopover-miner ledger list --type calibration_snapshot`.
//
// SCOPE: this runner is read/measure-only. It produces and persists the tracked calibration metric; it NEVER acts
// on it (no autonomy-level bump, no gate-threshold tune) -- that enforcement is maintainer-only and fail-closed
// (see docs/miner-selfimprove-calibration.md's maintainer-only boundary). The engine owns the deterministic
// combine/freshness/threshold/hold-reason logic; this module owns scheduling the score and persisting the row.

import { computePhase7CalibrationLoop } from "@loopover/engine";
import type {
  HistoricalReplayCalibrationInput,
  Phase7CalibrationConfig,
  Phase7CalibrationLoopResult,
  Phase7CalibrationManifest,
  PrOutcomeCalibrationInput,
  ReplayHarnessStatus,
} from "@loopover/engine";
import { computeObjectiveAnchor } from "./replay-objective-anchor.js";
import type {
  ObjectiveAnchorResult,
  ReplayPlanInput,
  RevealedHistoryEntry,
} from "./replay-objective-anchor.js";
import type { AppendEventInput, LedgerEntry } from "./event-ledger.js";

/** Event-ledger vocabulary for a persisted Phase 7 calibration snapshot (mirrors MINER_PR_OUTCOME_EVENT). */
export const MINER_CALIBRATION_SNAPSHOT_EVENT = "calibration_snapshot";

/** One completed replay-run task result: what the replay targeted, and the revealed post-T history to score it. */
export interface ReplayTaskResult {
  replayPlan?: ReplayPlanInput | null;
  revealedHistory?: RevealedHistoryEntry[] | RevealedHistoryEntry | null;
}

export interface ScoreCompositeOptions {
  computeObjectiveAnchor?: (
    input: { replayPlan?: ReplayPlanInput | null; revealedHistory?: RevealedHistoryEntry[] | RevealedHistoryEntry | null },
  ) => ObjectiveAnchorResult;
}

export interface HistoricalReplayCompositeScore {
  compositeScore: number | null;
  sampleSize: number;
  scores: number[];
}

/** A completed replay run's descriptor: its per-task results plus the run's identity/freshness/harness health. */
export interface ReplayRunDescriptor {
  replayResults?: readonly ReplayTaskResult[] | null;
  replayRunId?: string;
  observedAt?: string;
  harnessStatus?: ReplayHarnessStatus;
}

export interface BuiltHistoricalReplayInput {
  historicalReplay: HistoricalReplayCalibrationInput | null;
  compositeScore: number | null;
  sampleSize: number;
  scores: number[];
}

/** The persisted, public-safe projection of a Phase7CalibrationLoopResult. */
export interface CalibrationSnapshotPayload {
  enabled: boolean;
  combinedAccuracy: number | null;
  baselineAccuracy: number;
  deltaFromBaseline: number | null;
  autonomyIncreasePermitted: boolean;
  replayHarnessHold: boolean;
  replayHarnessStatus: string;
  replayRunDue: boolean;
  holdReasons: string[];
  contributingSources: string[];
  replayRunId: string | null;
  observedAt: string | null;
  replaySampleSize: number;
  /** #8185: the AMS backtest loop's REGRESSED-verdict track record at snapshot time (aggregated from the
   *  persisted ams_threshold_backtest_run events), so authority-earning history is queryable from the
   *  ledger alone. Null when the writer had no track record to attach (including every pre-#8185 row). */
  backtestTrackRecord: { totalRuns: number; regressedRuns: number; regressedRate: number | null } | null;
}

export interface SnapshotMeta {
  replayRunId?: string | null;
  observedAt?: string | null;
  sampleSize?: number;
  backtestTrackRecord?: { totalRuns: number; regressedRuns: number; regressedRate: number | null } | null;
}

export interface RecordCalibrationSnapshotOptions {
  /** Optional at the type level so a caller can pass an unusable ledger to exercise the fail-closed guard; the
   *  writer throws `invalid_event_ledger` at runtime when this is absent or lacks `appendEvent`. */
  eventLedger?: { appendEvent(event: AppendEventInput): LedgerEntry };
  repoFullName?: string;
}

export interface CalibrationSnapshotReader {
  readEvents(filter?: { since?: number | null; repoFullName?: string | null }): unknown[];
}

export interface CalibrationSnapshotFilter {
  since?: number | null;
  repoFullName?: string | null;
}

export interface PersistedCalibrationSnapshot extends CalibrationSnapshotPayload {
  repoFullName: string | null;
  seq: number | null;
  createdAt: string | null;
}

export interface RunCalibrationCycleInput {
  config?: Phase7CalibrationConfig | Phase7CalibrationManifest | Record<string, unknown> | null;
  prOutcome?: PrOutcomeCalibrationInput | null;
  replayRun?: ReplayRunDescriptor | null;
  now?: string | Date | null;
  observedAt?: string | null;
  repoFullName?: string;
}

export interface RunCalibrationCycleDeps extends ScoreCompositeOptions {
  computeLoop?: (input: {
    config?: Phase7CalibrationConfig | Phase7CalibrationManifest | Record<string, unknown> | null;
    prOutcome?: PrOutcomeCalibrationInput | null;
    historicalReplay?: HistoricalReplayCalibrationInput | null;
    now?: string | Date | null;
  }) => Phase7CalibrationLoopResult;
  eventLedger?: { appendEvent(event: AppendEventInput): LedgerEntry };
}

export interface RunCalibrationCycleResult {
  result: Phase7CalibrationLoopResult;
  snapshot: CalibrationSnapshotPayload;
  recorded: LedgerEntry | null;
  historicalReplay: HistoricalReplayCalibrationInput | null;
  compositeScore: number | null;
  sampleSize: number;
  scores: number[];
}

const SCORE_PRECISION = 1e6;

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * SCORE_PRECISION) / SCORE_PRECISION;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Score a completed replay run's per-task results with the deterministic objective-anchor scorer and reduce them to
 * one composite `[0, 1]` accuracy (the mean of the per-task scores). `replayResults` is a list of
 * `{ replayPlan, revealedHistory }` pairs; each non-object entry is defensively skipped. Returns `compositeScore:
 * null` (never a fabricated 0) when there is no scorable task. Pure aside from the injected scorer.
 */
export function scoreHistoricalReplayComposite(
  replayResults: readonly ReplayTaskResult[] | null | undefined,
  options: ScoreCompositeOptions = {},
): HistoricalReplayCompositeScore {
  const scoreOne = options.computeObjectiveAnchor ?? computeObjectiveAnchor;
  const list = Array.isArray(replayResults) ? replayResults : [];
  const scores: number[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { score } = scoreOne({ replayPlan: entry.replayPlan, revealedHistory: entry.revealedHistory });
    if (isFiniteNumber(score)) scores.push(score);
  }
  const sampleSize = scores.length;
  const compositeScore = sampleSize === 0 ? null : roundScore(scores.reduce((sum, s) => sum + s, 0) / sampleSize);
  return { compositeScore, sampleSize, scores };
}

/**
 * Build the engine's `HistoricalReplayCalibrationInput` from a replay run descriptor
 * (`{ replayResults, replayRunId, observedAt, harnessStatus }`). Returns `historicalReplay: null` when no run
 * descriptor is supplied (the engine then holds `no_historical_replay_signal` when the loop is enabled). When a run
 * IS supplied its `harnessStatus` flows through verbatim so a degraded/unavailable harness still reaches the
 * engine's fail-closed hold path even if it scored zero tasks; a null composite becomes `0` only for the engine's
 * numeric contract (the un-fabricated `compositeScore`/`sampleSize` are returned alongside for the snapshot).
 */
export function buildHistoricalReplayCalibrationInput(
  replayRun: ReplayRunDescriptor | null | undefined,
  options: ScoreCompositeOptions = {},
): BuiltHistoricalReplayInput {
  if (!replayRun || typeof replayRun !== "object" || Array.isArray(replayRun)) {
    return { historicalReplay: null, compositeScore: null, sampleSize: 0, scores: [] };
  }
  const composite = scoreHistoricalReplayComposite(replayRun.replayResults, options);
  return {
    historicalReplay: {
      compositeScore: composite.compositeScore ?? 0,
      replayRunId: replayRun.replayRunId,
      observedAt: replayRun.observedAt,
      harnessStatus: replayRun.harnessStatus,
    } as HistoricalReplayCalibrationInput,
    compositeScore: composite.compositeScore,
    sampleSize: composite.sampleSize,
    scores: composite.scores,
  };
}

/**
 * Derive a JSON-safe, public-safe snapshot payload from a computed `Phase7CalibrationLoopResult`. Only accuracies,
 * the documented baseline, hold-reason CODES, and provenance are surfaced -- never raw replay scores or rewards.
 * Every field is a number/null, boolean, string/null, or string[] so it round-trips through the event ledger's
 * verbatim-JSON serializer unchanged.
 */
export function snapshotPayloadFromResult(result: Phase7CalibrationLoopResult, meta: SnapshotMeta = {}): CalibrationSnapshotPayload {
  return {
    enabled: result.enabled === true,
    combinedAccuracy: numberOrNull(result.combinedAccuracy),
    baselineAccuracy: isFiniteNumber(result.baselineAccuracy) ? result.baselineAccuracy : 0,
    deltaFromBaseline: numberOrNull(result.deltaFromBaseline),
    autonomyIncreasePermitted: result.autonomyIncreasePermitted === true,
    replayHarnessHold: result.replayHarnessHold === true,
    replayHarnessStatus: optionalString(result.replayHarnessStatus) ?? "missing",
    replayRunDue: result.replayRunDue === true,
    holdReasons: Array.isArray(result.holdReasons) ? result.holdReasons.map(String) : [],
    contributingSources: Array.isArray(result.audit?.contributingSources)
      ? result.audit.contributingSources.map(String)
      : [],
    replayRunId: optionalString(meta.replayRunId),
    observedAt: optionalString(meta.observedAt),
    replaySampleSize: Number.isInteger(meta.sampleSize) && (meta.sampleSize as number) >= 0 ? (meta.sampleSize as number) : 0,
    backtestTrackRecord: normalizeBacktestTrackRecord(meta.backtestTrackRecord),
  };
}

/** Tolerant #8185 section normalizer: a malformed shape degrades to null (the pre-#8185 reading), never
 *  rejecting the whole snapshot -- the Phase 7 metric is still real without the AMS track record. */
function normalizeBacktestTrackRecord(value: unknown): CalibrationSnapshotPayload["backtestTrackRecord"] {
  const record = value as Record<string, unknown> | null | undefined;
  if (!record || typeof record !== "object") return null;
  if (!Number.isInteger(record.totalRuns) || (record.totalRuns as number) < 0) return null;
  if (!Number.isInteger(record.regressedRuns) || (record.regressedRuns as number) < 0) return null;
  const rate = record.regressedRate;
  if (rate !== null && !(typeof rate === "number" && Number.isFinite(rate))) return null;
  return { totalRuns: record.totalRuns as number, regressedRuns: record.regressedRuns as number, regressedRate: rate as number | null };
}

/**
 * Validate + normalize a calibration-snapshot payload, returning `null` on any malformed shape (mirrors
 * pr-outcome.js's `normalizePrOutcomePayload`, so a corrupted row can neither be written nor read back). Skipped
 * rows are dropped by the reader rather than throwing.
 */
export function normalizeCalibrationSnapshotPayload(payload: unknown): CalibrationSnapshotPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.combinedAccuracy !== null && !isFiniteNumber(record.combinedAccuracy)) return null;
  if (!isFiniteNumber(record.baselineAccuracy)) return null;
  if (record.deltaFromBaseline !== null && !isFiniteNumber(record.deltaFromBaseline)) return null;
  if (typeof record.autonomyIncreasePermitted !== "boolean") return null;
  const replayHarnessStatus = optionalString(record.replayHarnessStatus);
  if (!replayHarnessStatus) return null;
  if (!Array.isArray(record.holdReasons) || record.holdReasons.some((code) => typeof code !== "string")) {
    return null;
  }
  const contributingSources = Array.isArray(record.contributingSources)
    ? record.contributingSources.filter((code): code is string => typeof code === "string")
    : [];
  return {
    enabled: record.enabled === true,
    combinedAccuracy: record.combinedAccuracy as number | null,
    baselineAccuracy: record.baselineAccuracy as number,
    deltaFromBaseline: record.deltaFromBaseline as number | null,
    autonomyIncreasePermitted: record.autonomyIncreasePermitted,
    replayHarnessHold: record.replayHarnessHold === true,
    replayHarnessStatus,
    replayRunDue: record.replayRunDue === true,
    holdReasons: record.holdReasons as string[],
    contributingSources,
    replayRunId: optionalString(record.replayRunId),
    observedAt: optionalString(record.observedAt),
    replaySampleSize:
      Number.isInteger(record.replaySampleSize) && (record.replaySampleSize as number) >= 0 ? (record.replaySampleSize as number) : 0,
    backtestTrackRecord: normalizeBacktestTrackRecord(record.backtestTrackRecord),
  };
}

/**
 * Persist one calibration snapshot to an INJECTED event ledger (same dependency-injection shape as pr-outcome.js's
 * `recordPrOutcomeSnapshot`, so it's unit-testable without a real SQLite file). Fail-soft: a malformed payload
 * returns `null` without appending. An unusable ledger is the only hard error (a programmer wiring mistake).
 */
export function recordCalibrationSnapshot(input: unknown, options: RecordCalibrationSnapshotOptions = {}): LedgerEntry | null {
  const eventLedger = options.eventLedger;
  if (!eventLedger || typeof eventLedger.appendEvent !== "function") throw new Error("invalid_event_ledger");
  const payload = normalizeCalibrationSnapshotPayload(input);
  if (!payload) return null;
  const repoFullName = optionalString(options.repoFullName);
  return eventLedger.appendEvent({
    type: MINER_CALIBRATION_SNAPSHOT_EVENT,
    ...(repoFullName ? { repoFullName } : {}),
    payload,
  } as unknown as AppendEventInput);
}

/**
 * Read every persisted calibration snapshot from the injected ledger's ascending append-only stream (mirrors
 * pr-outcome.js's `readPrOutcomes`). Foreign event types and malformed payloads are skipped; a ledger that cannot
 * read reduces to an empty list. Returns snapshots in ledger order (oldest first).
 */
export function readCalibrationSnapshots(
  eventLedger: CalibrationSnapshotReader,
  filter: CalibrationSnapshotFilter = {},
): PersistedCalibrationSnapshot[] {
  const events =
    eventLedger && typeof eventLedger.readEvents === "function" ? eventLedger.readEvents(filter) : [];
  const snapshots: PersistedCalibrationSnapshot[] = [];
  for (const event of Array.isArray(events) ? events : []) {
    const record = event as Record<string, unknown> | null | undefined;
    if (record?.type !== MINER_CALIBRATION_SNAPSHOT_EVENT) continue;
    const normalized = normalizeCalibrationSnapshotPayload(record.payload);
    if (!normalized) continue;
    snapshots.push({
      ...normalized,
      repoFullName: typeof record.repoFullName === "string" ? record.repoFullName : null,
      seq: Number.isInteger(record.seq) ? (record.seq as number) : null,
      createdAt: optionalString(record.createdAt),
    });
  }
  return snapshots;
}

/** The most recent persisted calibration snapshot, or `null` when none exist. */
export function latestCalibrationSnapshot(
  eventLedger: CalibrationSnapshotReader,
  filter: CalibrationSnapshotFilter = {},
): PersistedCalibrationSnapshot | null {
  const snapshots = readCalibrationSnapshots(eventLedger, filter);
  return snapshots.length > 0 ? snapshots[snapshots.length - 1]! : null;
}

/**
 * The runner. Scores the replay run (via the objective-anchor scorer), calls the engine's calibration combine with
 * the resulting historical-replay composite plus the existing pr_outcome signal, and -- when an event ledger is
 * injected -- persists the combined snapshot. Returns the engine result, the derived snapshot payload, the recorded
 * ledger entry (or null when no ledger was injected or the payload was malformed), and the un-fabricated
 * composite/sample provenance. The engine combine (`computeLoop`) is injectable so unit tests can pin it.
 */
export function runHistoricalReplayCalibrationCycle(
  input: RunCalibrationCycleInput = {},
  deps: RunCalibrationCycleDeps = {},
): RunCalibrationCycleResult {
  const computeLoop = deps.computeLoop ?? (computePhase7CalibrationLoop as RunCalibrationCycleDeps["computeLoop"]);
  const built = buildHistoricalReplayCalibrationInput(input.replayRun, deps);
  const result = computeLoop!({
    ...(input.config !== undefined ? { config: input.config } : {}),
    ...(input.prOutcome !== undefined ? { prOutcome: input.prOutcome } : {}),
    historicalReplay: built.historicalReplay,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  const snapshot = snapshotPayloadFromResult(result, {
    replayRunId: (built.historicalReplay as Record<string, unknown> | null)?.replayRunId as string | null ?? null,
    observedAt: input.observedAt ?? ((built.historicalReplay as Record<string, unknown> | null)?.observedAt as string | null) ?? null,
    sampleSize: built.sampleSize,
  });
  const recorded = deps.eventLedger
    ? recordCalibrationSnapshot(snapshot, { eventLedger: deps.eventLedger, repoFullName: input.repoFullName } as RecordCalibrationSnapshotOptions)
    : null;
  return {
    result,
    snapshot,
    recorded,
    historicalReplay: built.historicalReplay,
    compositeScore: built.compositeScore,
    sampleSize: built.sampleSize,
    scores: built.scores,
  };
}
