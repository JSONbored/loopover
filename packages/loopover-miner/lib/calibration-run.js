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
        // Pass-through matches the pre-TS JS: optional descriptor fields may be undefined at runtime.
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
        replaySampleSize: Number.isInteger(record.replaySampleSize) && record.replaySampleSize >= 0
            ? record.replaySampleSize
            : 0,
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
        ...(input.config !== undefined ? { config: input.config } : {}),
        ...(input.prOutcome !== undefined ? { prOutcome: input.prOutcome } : {}),
        historicalReplay: built.historicalReplay,
        ...(input.now !== undefined ? { now: input.now } : {}),
    });
    const snapshot = snapshotPayloadFromResult(result, {
        replayRunId: built.historicalReplay?.replayRunId ?? null,
        observedAt: input.observedAt ?? built.historicalReplay?.observedAt ?? null,
        sampleSize: built.sampleSize,
    });
    const recorded = deps.eventLedger
        ? recordCalibrationSnapshot(snapshot, {
            eventLedger: deps.eventLedger,
            ...(input.repoFullName !== undefined ? { repoFullName: input.repoFullName } : {}),
        })
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FsaWJyYXRpb24tcnVuLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2FsaWJyYXRpb24tcnVuLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLCtHQUErRztBQUMvRyx5RkFBeUY7QUFDekYsaUhBQWlIO0FBQ2pILGtIQUFrSDtBQUNsSCw2R0FBNkc7QUFDN0csMEdBQTBHO0FBQzFHLG1IQUFtSDtBQUNuSCxvSEFBb0g7QUFDcEgsdUdBQXVHO0FBQ3ZHLDREQUE0RDtBQUM1RCxFQUFFO0FBQ0Ysa0hBQWtIO0FBQ2xILGdIQUFnSDtBQUNoSCw0R0FBNEc7QUFDNUcsK0dBQStHO0FBRS9HLE9BQU8sRUFBRSw0QkFBNEIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBVWhFLE9BQU8sRUFBRSxzQkFBc0IsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBT3RFLDZHQUE2RztBQUM3RyxNQUFNLENBQUMsTUFBTSxnQ0FBZ0MsR0FBRyxzQkFBK0IsQ0FBQztBQUVoRixNQUFNLGVBQWUsR0FBRyxHQUFHLENBQUM7QUE4RzVCLFNBQVMsVUFBVSxDQUFDLEtBQWE7SUFDL0IsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEdBQUcsZUFBZSxDQUFDLEdBQUcsZUFBZSxDQUFDO0FBQ3pGLENBQUM7QUFFRCxTQUFTLGNBQWMsQ0FBQyxLQUFjO0lBQ3BDLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDN0QsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLEtBQWM7SUFDbEMsT0FBTyxjQUFjLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQzlDLENBQUM7QUFFRCxTQUFTLGNBQWMsQ0FBQyxLQUFj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