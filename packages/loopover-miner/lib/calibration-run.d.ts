import type { HistoricalReplayCalibrationInput, Phase7CalibrationConfig, Phase7CalibrationLoopResult, Phase7CalibrationManifest, PrOutcomeCalibrationInput, ReplayHarnessStatus } from "@loopover/engine";
import type { AppendEventInput, LedgerEntry } from "./event-ledger.js";
import type { ObjectiveAnchorResult, ReplayPlanInput, RevealedHistoryEntry } from "./replay-objective-anchor.js";
/** Event-ledger vocabulary for a persisted Phase 7 calibration snapshot (mirrors MINER_PR_OUTCOME_EVENT). */
export declare const MINER_CALIBRATION_SNAPSHOT_EVENT: "calibration_snapshot";
/** One completed replay-run task result: what the replay targeted, and the revealed post-T history to score it. */
export interface ReplayTaskResult {
    replayPlan?: ReplayPlanInput | null;
    revealedHistory?: RevealedHistoryEntry[] | RevealedHistoryEntry | null;
}
export interface ScoreCompositeOptions {
    computeObjectiveAnchor?: (input: {
        replayPlan?: ReplayPlanInput | null;
        revealedHistory?: RevealedHistoryEntry[] | RevealedHistoryEntry | null;
    }) => ObjectiveAnchorResult;
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
}
export interface SnapshotMeta {
    replayRunId?: string | null;
    observedAt?: string | null;
    sampleSize?: number;
}
export interface RecordCalibrationSnapshotOptions {
    /** Optional at the type level so a caller can pass an unusable ledger to exercise the fail-closed guard; the
     *  writer throws `invalid_event_ledger` at runtime when this is absent or lacks `appendEvent`. */
    eventLedger?: {
        appendEvent(event: AppendEventInput): LedgerEntry;
    };
    repoFullName?: string;
}
export interface CalibrationSnapshotReader {
    readEvents(filter?: {
        since?: number | null;
        repoFullName?: string | null;
    }): unknown[];
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
    eventLedger?: {
        appendEvent(event: AppendEventInput): LedgerEntry;
    };
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
/**
 * Score a completed replay run's per-task results with the deterministic objective-anchor scorer and reduce them to
 * one composite `[0, 1]` accuracy (the mean of the per-task scores). `replayResults` is a list of
 * `{ replayPlan, revealedHistory }` pairs; each non-object entry is defensively skipped. Returns `compositeScore:
 * null` (never a fabricated 0) when there is no scorable task. Pure aside from the injected scorer.
 */
export declare function scoreHistoricalReplayComposite(replayResults: readonly ReplayTaskResult[] | null | undefined, options?: ScoreCompositeOptions): HistoricalReplayCompositeScore;
/**
 * Build the engine's `HistoricalReplayCalibrationInput` from a replay run descriptor
 * (`{ replayResults, replayRunId, observedAt, harnessStatus }`). Returns `historicalReplay: null` when no run
 * descriptor is supplied (the engine then holds `no_historical_replay_signal` when the loop is enabled). When a run
 * IS supplied its `harnessStatus` flows through verbatim so a degraded/unavailable harness still reaches the
 * engine's fail-closed hold path even if it scored zero tasks; a null composite becomes `0` only for the engine's
 * numeric contract (the un-fabricated `compositeScore`/`sampleSize` are returned alongside for the snapshot).
 */
export declare function buildHistoricalReplayCalibrationInput(replayRun: ReplayRunDescriptor | null | undefined, options?: ScoreCompositeOptions): BuiltHistoricalReplayInput;
/**
 * Derive a JSON-safe, public-safe snapshot payload from a computed `Phase7CalibrationLoopResult`. Only accuracies,
 * the documented baseline, hold-reason CODES, and provenance are surfaced -- never raw replay scores or rewards.
 * Every field is a number/null, boolean, string/null, or string[] so it round-trips through the event ledger's
 * verbatim-JSON serializer unchanged.
 */
export declare function snapshotPayloadFromResult(result: Phase7CalibrationLoopResult, meta?: SnapshotMeta): CalibrationSnapshotPayload;
/**
 * Validate + normalize a calibration-snapshot payload, returning `null` on any malformed shape (mirrors
 * pr-outcome.js's `normalizePrOutcomePayload`, so a corrupted row can neither be written nor read back). Skipped
 * rows are dropped by the reader rather than throwing.
 */
export declare function normalizeCalibrationSnapshotPayload(payload: unknown): CalibrationSnapshotPayload | null;
/**
 * Persist one calibration snapshot to an INJECTED event ledger (same dependency-injection shape as pr-outcome.js's
 * `recordPrOutcomeSnapshot`, so it's unit-testable without a real SQLite file). Fail-soft: a malformed payload
 * returns `null` without appending. An unusable ledger is the only hard error (a programmer wiring mistake).
 */
export declare function recordCalibrationSnapshot(input: unknown, options?: RecordCalibrationSnapshotOptions): LedgerEntry | null;
/**
 * Read every persisted calibration snapshot from the injected ledger's ascending append-only stream (mirrors
 * pr-outcome.js's `readPrOutcomes`). Foreign event types and malformed payloads are skipped; a ledger that cannot
 * read reduces to an empty list. Returns snapshots in ledger order (oldest first).
 */
export declare function readCalibrationSnapshots(eventLedger: CalibrationSnapshotReader, filter?: CalibrationSnapshotFilter): PersistedCalibrationSnapshot[];
/** The most recent persisted calibration snapshot, or `null` when none exist. */
export declare function latestCalibrationSnapshot(eventLedger: CalibrationSnapshotReader, filter?: CalibrationSnapshotFilter): PersistedCalibrationSnapshot | null;
/**
 * The runner. Scores the replay run (via the objective-anchor scorer), calls the engine's calibration combine with
 * the resulting historical-replay composite plus the existing pr_outcome signal, and -- when an event ledger is
 * injected -- persists the combined snapshot. Returns the engine result, the derived snapshot payload, the recorded
 * ledger entry (or null when no ledger was injected or the payload was malformed), and the un-fabricated
 * composite/sample provenance. The engine combine (`computeLoop`) is injectable so unit tests can pin it.
 */
export declare function runHistoricalReplayCalibrationCycle(input?: RunCalibrationCycleInput, deps?: RunCalibrationCycleDeps): RunCalibrationCycleResult;
