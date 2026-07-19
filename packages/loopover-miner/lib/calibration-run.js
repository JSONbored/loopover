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
import { computeObjectiveAnchor } from "./replay-objective-anchor.js";
/** Event-ledger vocabulary for a persisted Phase 7 calibration snapshot (mirrors MINER_PR_OUTCOME_EVENT). */
export const MINER_CALIBRATION_SNAPSHOT_EVENT = "calibration_snapshot";
const SCORE_PRECISION = 1e6;
function roundScore(value) {
    return Math.round(Math.min(1, Math.max(0, value)) * SCORE_PRECISION) / SCORE_PRECISION;
}
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function numberOrNull(value) {
    return isFiniteNumber(value) ? value : null;
}
function optionalString(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed || null;
}
/**
 * Score a completed replay run's per-task results with the deterministic objective-anchor scorer and reduce them to
 * one composite `[0, 1]` accuracy (the mean of the per-task scores). `replayResults` is a list of
 * `{ replayPlan, revealedHistory }` pairs; each non-object entry is defensively skipped. Returns `compositeScore:
 * null` (never a fabricated 0) when there is no scorable task. Pure aside from the injected scorer.
 */
export function scoreHistoricalReplayComposite(replayResults, options = {}) {
    const scoreOne = options.computeObjectiveAnchor ?? computeObjectiveAnchor;
    const list = Array.isArray(replayResults) ? replayResults : [];
    const scores = [];
    for (const entry of list) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            continue;
        const { score } = scoreOne({ replayPlan: entry.replayPlan, revealedHistory: entry.revealedHistory });
        if (isFiniteNumber(score))
            scores.push(score);
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
export function buildHistoricalReplayCalibrationInput(replayRun, options = {}) {
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
        },
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
export function snapshotPayloadFromResult(result, meta = {}) {
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
        replaySampleSize: Number.isInteger(meta.sampleSize) && meta.sampleSize >= 0 ? meta.sampleSize : 0,
    };
}
/**
 * Validate + normalize a calibration-snapshot payload, returning `null` on any malformed shape (mirrors
 * pr-outcome.js's `normalizePrOutcomePayload`, so a corrupted row can neither be written nor read back). Skipped
 * rows are dropped by the reader rather than throwing.
 */
export function normalizeCalibrationSnapshotPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return null;
    const record = payload;
    if (record.combinedAccuracy !== null && !isFiniteNumber(record.combinedAccuracy))
        return null;
    if (!isFiniteNumber(record.baselineAccuracy))
        return null;
    if (record.deltaFromBaseline !== null && !isFiniteNumber(record.deltaFromBaseline))
        return null;
    if (typeof record.autonomyIncreasePermitted !== "boolean")
        return null;
    const replayHarnessStatus = optionalString(record.replayHarnessStatus);
    if (!replayHarnessStatus)
        return null;
    if (!Array.isArray(record.holdReasons) || record.holdReasons.some((code) => typeof code !== "string")) {
        return null;
    }
    const contributingSources = Array.isArray(record.contributingSources)
        ? record.contributingSources.filter((code) => typeof code === "string")
        : [];
    return {
        enabled: record.enabled === true,
        combinedAccuracy: record.combinedAccuracy,
        baselineAccuracy: record.baselineAccuracy,
        deltaFromBaseline: record.deltaFromBaseline,
        autonomyIncreasePermitted: record.autonomyIncreasePermitted,
        replayHarnessHold: record.replayHarnessHold === true,
        replayHarnessStatus,
        replayRunDue: record.replayRunDue === true,
        holdReasons: record.holdReasons,
        contributingSources,
        replayRunId: optionalString(record.replayRunId),
        observedAt: optionalString(record.observedAt),
        replaySampleSize: Number.isInteger(record.replaySampleSize) && record.replaySampleSize >= 0 ? record.replaySampleSize : 0,
    };
}
/**
 * Persist one calibration snapshot to an INJECTED event ledger (same dependency-injection shape as pr-outcome.js's
 * `recordPrOutcomeSnapshot`, so it's unit-testable without a real SQLite file). Fail-soft: a malformed payload
 * returns `null` without appending. An unusable ledger is the only hard error (a programmer wiring mistake).
 */
export function recordCalibrationSnapshot(input, options = {}) {
    const eventLedger = options.eventLedger;
    if (!eventLedger || typeof eventLedger.appendEvent !== "function")
        throw new Error("invalid_event_ledger");
    const payload = normalizeCalibrationSnapshotPayload(input);
    if (!payload)
        return null;
    const repoFullName = optionalString(options.repoFullName);
    return eventLedger.appendEvent({
        type: MINER_CALIBRATION_SNAPSHOT_EVENT,
        ...(repoFullName ? { repoFullName } : {}),
        payload: payload,
    });
}
/**
 * Read every persisted calibration snapshot from the injected ledger's ascending append-only stream (mirrors
 * pr-outcome.js's `readPrOutcomes`). Foreign event types and malformed payloads are skipped; a ledger that cannot
 * read reduces to an empty list. Returns snapshots in ledger order (oldest first).
 */
export function readCalibrationSnapshots(eventLedger, filter = {}) {
    const events = eventLedger && typeof eventLedger.readEvents === "function" ? eventLedger.readEvents(filter) : [];
    const snapshots = [];
    for (const event of Array.isArray(events) ? events : []) {
        const row = event;
        if (row?.type !== MINER_CALIBRATION_SNAPSHOT_EVENT)
            continue;
        const normalized = normalizeCalibrationSnapshotPayload(row.payload);
        if (!normalized)
            continue;
        snapshots.push({
            ...normalized,
            repoFullName: typeof row.repoFullName === "string" ? row.repoFullName : null,
            seq: Number.isInteger(row.seq) ? row.seq : null,
            createdAt: optionalString(row.createdAt),
        });
    }
    return snapshots;
}
/** The most recent persisted calibration snapshot, or `null` when none exist. */
export function latestCalibrationSnapshot(eventLedger, filter = {}) {
    const snapshots = readCalibrationSnapshots(eventLedger, filter);
    return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}
/**
 * The runner. Scores the replay run (via the objective-anchor scorer), calls the engine's calibration combine with
 * the resulting historical-replay composite plus the existing pr_outcome signal, and -- when an event ledger is
 * injected -- persists the combined snapshot. Returns the engine result, the derived snapshot payload, the recorded
 * ledger entry (or null when no ledger was injected or the payload was malformed), and the un-fabricated
 * composite/sample provenance. The engine combine (`computeLoop`) is injectable so unit tests can pin it.
 */
export function runHistoricalReplayCalibrationCycle(input = {}, deps = {}) {
    const computeLoop = deps.computeLoop ?? computePhase7CalibrationLoop;
    const built = buildHistoricalReplayCalibrationInput(input.replayRun, deps);
    const result = computeLoop({
        config: input.config,
        prOutcome: input.prOutcome,
        historicalReplay: built.historicalReplay,
        now: input.now,
    });
    const snapshot = snapshotPayloadFromResult(result, {
        replayRunId: built.historicalReplay?.replayRunId ?? null,
        observedAt: input.observedAt ?? built.historicalReplay?.observedAt ?? null,
        sampleSize: built.sampleSize,
    });
    const recorded = deps.eventLedger
        ? recordCalibrationSnapshot(snapshot, { eventLedger: deps.eventLedger, repoFullName: input.repoFullName })
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FsaWJyYXRpb24tcnVuLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2FsaWJyYXRpb24tcnVuLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLCtHQUErRztBQUMvRyx5RkFBeUY7QUFDekYsaUhBQWlIO0FBQ2pILGtIQUFrSDtBQUNsSCw2R0FBNkc7QUFDN0csMEdBQTBHO0FBQzFHLG1IQUFtSDtBQUNuSCxvSEFBb0g7QUFDcEgsdUdBQXVHO0FBQ3ZHLDREQUE0RDtBQUM1RCxFQUFFO0FBQ0Ysa0hBQWtIO0FBQ2xILGdIQUFnSDtBQUNoSCw0R0FBNEc7QUFDNUcsK0dBQStHO0FBRS9HLE9BQU8sRUFBRSw0QkFBNEIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBR2hFLE9BQU8sRUFBRSxzQkFBc0IsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBR3RFLDZHQUE2RztBQUM3RyxNQUFNLENBQUMsTUFBTSxnQ0FBZ0MsR0FBRyxzQkFBK0IsQ0FBQztBQWlCaEYsTUFBTSxlQUFlLEdBQUcsR0FBRyxDQUFDO0FBRTVCLFNBQVMsVUFBVSxDQUFDLEtBQWE7SUFDL0IsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEdBQUcsZUFBZSxDQUFDLEdBQUcsZUFBZSxDQUFDO0FBQ3pGLENBQUM7QUFFRCxTQUFTLGNBQWMsQ0FBQyxLQUFjO0lBQ3BDLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDN0QsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLEtBQWM7SUFDbEMsT0FBTyxjQUFjLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQzlDLENBQUM7QUFFRCxTQUFTLGNBQWMsQ0FBQyxLQUFj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