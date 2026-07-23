import { describe, expect, it, vi } from "vitest";

// The runner imports `computePhase7CalibrationLoop` from the engine PACKAGE; resolve it to the in-repo source so the
// default (non-injected) combine branch runs against the real engine, exactly like miner-feasibility-cli.test.ts.
vi.mock("@loopover/engine", async () => import("../../packages/loopover-engine/src/index"));

import {
  MINER_CALIBRATION_SNAPSHOT_EVENT,
  buildHistoricalReplayCalibrationInput,
  latestCalibrationSnapshot,
  normalizeCalibrationSnapshotPayload,
  readCalibrationSnapshots,
  recordCalibrationSnapshot,
  runHistoricalReplayCalibrationCycle,
  scoreHistoricalReplayComposite,
  snapshotPayloadFromResult,
} from "../../packages/loopover-miner/lib/calibration-run.js";
import type { AppendEventInput, LedgerEntry } from "../../packages/loopover-miner/lib/event-ledger.js";

// A minimal injected event ledger (the DI shape record/read accept) — pure unit tests, no SQLite file. `_events` is
// exposed so a test can inject crafted rows for the reader's defensive skip branches. Typed against the real
// EventLedger#appendEvent contract so this mock can't silently drift from it.
function mockLedger(): {
  appendEvent: (e: AppendEventInput) => LedgerEntry;
  readEvents: (filter?: { repoFullName?: string }) => unknown[];
  _events: Array<Record<string, unknown>>;
} {
  const events: Array<Record<string, unknown>> = [];
  let seq = 0;
  return {
    appendEvent: (e) => {
      const entry = {
        id: ++seq,
        seq,
        type: e.type,
        repoFullName: e.repoFullName ?? null,
        payload: e.payload,
        createdAt: new Date().toISOString(),
      };
      events.push(entry);
      return entry as unknown as LedgerEntry;
    },
    readEvents: (filter = {}) =>
      events.filter((e) => filter.repoFullName === undefined || e.repoFullName === filter.repoFullName),
    _events: events,
  };
}

/** A complete, valid snapshot payload; individual tests override single fields to exercise each reject branch. */
function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    combinedAccuracy: 0.9,
    baselineAccuracy: 0.62,
    deltaFromBaseline: 0.28,
    autonomyIncreasePermitted: true,
    replayHarnessHold: false,
    replayHarnessStatus: "healthy",
    replayRunDue: false,
    holdReasons: [],
    contributingSources: ["historical_replay", "pr_outcome"],
    replayRunId: "run-1",
    observedAt: "2026-07-09T00:00:00.000Z",
    replaySampleSize: 3,
    backtestTrackRecord: null,
    ...overrides,
  };
}

/** A minimal Phase7CalibrationLoopResult-shaped object for snapshotPayloadFromResult branch tests. */
function fakeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    combinedAccuracy: 0.9,
    baselineAccuracy: 0.62,
    deltaFromBaseline: 0.28,
    autonomyIncreasePermitted: true,
    replayHarnessHold: false,
    replayHarnessStatus: "healthy",
    replayRunDue: false,
    holdReasons: ["calibration_below_threshold"],
    audit: { contributingSources: ["pr_outcome"], rejectedSources: [] },
    ...overrides,
  };
}

const FEAT_REPLAY = { replayPlan: { pathsTouched: ["src/x/a.ts"], title: "feat: x" }, revealedHistory: [{ pathsTouched: ["src/x/b.ts"], title: "feat: y" }] };

describe("scoreHistoricalReplayComposite (#4248)", () => {
  it("scores each task with the real objective-anchor scorer and returns the mean composite", () => {
    // Two identical fully-overlapping feature tasks → each scores 1.0 → composite 1.0.
    const out = scoreHistoricalReplayComposite([FEAT_REPLAY, FEAT_REPLAY]);
    expect(out.sampleSize).toBe(2);
    expect(out.scores).toEqual([1, 1]);
    expect(out.compositeScore).toBe(1);
  });

  it("returns a null composite (never a fabricated 0) and zero samples for a non-array or empty input", () => {
    expect(scoreHistoricalReplayComposite(null)).toEqual({ compositeScore: null, sampleSize: 0, scores: [] });
    expect(scoreHistoricalReplayComposite([])).toEqual({ compositeScore: null, sampleSize: 0, scores: [] });
  });

  it("skips non-object entries and any scorer result whose score is not finite (injected scorer)", () => {
    let call = 0;
    const out = scoreHistoricalReplayComposite(
      [null, [1], "x", { replayPlan: {} }, { replayPlan: {} }] as never,
      {
        // First kept entry scores NaN (dropped), second scores 0.5 (kept).
        computeObjectiveAnchor: () => {
          call += 1;
          return { score: call === 1 ? Number.NaN : 0.5 } as never;
        },
      },
    );
    expect(call).toBe(2); // only the two object entries reached the scorer
    expect(out.scores).toEqual([0.5]);
    expect(out.compositeScore).toBe(0.5);
    expect(out.sampleSize).toBe(1);
  });
});

describe("buildHistoricalReplayCalibrationInput (#4248)", () => {
  it("returns a null historicalReplay for an absent / non-object / array run descriptor", () => {
    for (const bad of [null, undefined, "x", [FEAT_REPLAY]]) {
      const built = buildHistoricalReplayCalibrationInput(bad as never);
      expect(built).toEqual({ historicalReplay: null, compositeScore: null, sampleSize: 0, scores: [] });
    }
  });

  it("folds the composite into the engine input shape, passing harness metadata through verbatim", () => {
    const built = buildHistoricalReplayCalibrationInput({
      replayResults: [FEAT_REPLAY],
      replayRunId: "run-9",
      observedAt: "2026-07-09T00:00:00.000Z",
      harnessStatus: "healthy",
    });
    expect(built.compositeScore).toBe(1);
    expect(built.sampleSize).toBe(1);
    expect(built.historicalReplay).toEqual({
      compositeScore: 1,
      replayRunId: "run-9",
      observedAt: "2026-07-09T00:00:00.000Z",
      harnessStatus: "healthy",
    });
  });

  it("coerces a null composite (no scorable task) to a 0 for the engine's numeric contract", () => {
    const built = buildHistoricalReplayCalibrationInput({ replayResults: [], harnessStatus: "degraded" });
    expect(built.compositeScore).toBeNull();
    expect(built.sampleSize).toBe(0);
    expect(built.historicalReplay?.compositeScore).toBe(0);
    expect(built.historicalReplay?.harnessStatus).toBe("degraded");
  });
});

describe("snapshotPayloadFromResult (#4248)", () => {
  it("projects a full result to a JSON-safe public-safe payload", () => {
    const payload = snapshotPayloadFromResult(fakeResult() as never, {
      replayRunId: "run-1",
      observedAt: "2026-07-09T00:00:00.000Z",
      sampleSize: 4,
    });
    expect(payload).toEqual({
      enabled: true,
      combinedAccuracy: 0.9,
      baselineAccuracy: 0.62,
      deltaFromBaseline: 0.28,
      autonomyIncreasePermitted: true,
      replayHarnessHold: false,
      replayHarnessStatus: "healthy",
      replayRunDue: false,
      holdReasons: ["calibration_below_threshold"],
      contributingSources: ["pr_outcome"],
      replayRunId: "run-1",
      observedAt: "2026-07-09T00:00:00.000Z",
      replaySampleSize: 4,
      backtestTrackRecord: null,
    });
  });

  it("falls back safely on every absent/degenerate field (the false side of each guard)", () => {
    const payload = snapshotPayloadFromResult(
      {
        enabled: false,
        combinedAccuracy: null,
        baselineAccuracy: Number.NaN,
        deltaFromBaseline: null,
        autonomyIncreasePermitted: false,
        replayHarnessHold: false,
        replayHarnessStatus: 42,
        replayRunDue: false,
        holdReasons: "nope",
        audit: null,
      } as never,
      { sampleSize: -1 },
    );
    expect(payload.enabled).toBe(false);
    expect(payload.combinedAccuracy).toBeNull();
    expect(payload.baselineAccuracy).toBe(0);
    expect(payload.deltaFromBaseline).toBeNull();
    expect(payload.replayHarnessStatus).toBe("missing");
    expect(payload.holdReasons).toEqual([]);
    expect(payload.contributingSources).toEqual([]);
    expect(payload.replayRunId).toBeNull();
    expect(payload.observedAt).toBeNull();
    expect(payload.replaySampleSize).toBe(0);
  });

  it("treats a present-but-non-array audit.contributingSources as empty and maps the hold/due true flags", () => {
    const payload = snapshotPayloadFromResult(
      fakeResult({ audit: { contributingSources: "x" }, replayHarnessHold: true, replayRunDue: true }) as never,
    );
    expect(payload.contributingSources).toEqual([]);
    expect(payload.replayHarnessHold).toBe(true);
    expect(payload.replayRunDue).toBe(true);
  });
});

describe("normalizeCalibrationSnapshotPayload (#4248)", () => {
  it("accepts a complete valid payload", () => {
    expect(normalizeCalibrationSnapshotPayload(validPayload())).toEqual(validPayload());
  });

  it("rejects a non-object, and every malformed required field", () => {
    for (const bad of [
      null,
      "x",
      [validPayload()],
      validPayload({ combinedAccuracy: "x" }),
      validPayload({ baselineAccuracy: Number.NaN }),
      validPayload({ baselineAccuracy: undefined }),
      validPayload({ deltaFromBaseline: "x" }),
      validPayload({ autonomyIncreasePermitted: 1 }),
      validPayload({ replayHarnessStatus: "  " }),
      validPayload({ holdReasons: "no" }),
      validPayload({ holdReasons: ["ok", 7] }),
    ]) {
      expect(normalizeCalibrationSnapshotPayload(bad)).toBeNull();
    }
  });

  it("accepts a null combinedAccuracy and a null deltaFromBaseline (warming-up install) and the hold/due true flags", () => {
    const normalized = normalizeCalibrationSnapshotPayload(
      validPayload({ combinedAccuracy: null, deltaFromBaseline: null, replayHarnessHold: true, replayRunDue: true }),
    );
    expect(normalized?.combinedAccuracy).toBeNull();
    expect(normalized?.deltaFromBaseline).toBeNull();
    expect(normalized?.replayHarnessHold).toBe(true);
    expect(normalized?.replayRunDue).toBe(true);
  });

  it("filters non-string contributingSources, coerces a non-array to [], and defaults a bad replaySampleSize/enabled", () => {
    const normalized = normalizeCalibrationSnapshotPayload(
      validPayload({ contributingSources: ["a", 2, "b"], replaySampleSize: -3, enabled: "yes", replayRunId: "  " }),
    );
    expect(normalized?.contributingSources).toEqual(["a", "b"]);
    expect(normalized?.replaySampleSize).toBe(0);
    expect(normalized?.enabled).toBe(false);
    expect(normalized?.replayRunId).toBeNull();

    const noArray = normalizeCalibrationSnapshotPayload(validPayload({ contributingSources: 5 }));
    expect(noArray?.contributingSources).toEqual([]);
  });
});

describe("recordCalibrationSnapshot (#4248)", () => {
  it("throws only when the injected ledger is unusable", () => {
    expect(() => recordCalibrationSnapshot(validPayload())).toThrow("invalid_event_ledger");
    expect(() => recordCalibrationSnapshot(validPayload(), { eventLedger: {} } as never)).toThrow(
      "invalid_event_ledger",
    );
  });

  it("fail-soft returns null for a malformed payload, without appending", () => {
    const ledger = mockLedger();
    expect(recordCalibrationSnapshot({ combinedAccuracy: "x" }, { eventLedger: ledger })).toBeNull();
    expect(ledger._events).toHaveLength(0);
  });

  it("appends a repo-scoped event when a repo is given, and an unscoped event otherwise", () => {
    const ledger = mockLedger();
    const scoped = recordCalibrationSnapshot(validPayload(), {
      eventLedger: ledger,
      repoFullName: "  acme/widgets  ",
    }) as unknown as Record<string, unknown>;
    expect(scoped.type).toBe(MINER_CALIBRATION_SNAPSHOT_EVENT);
    expect(scoped.repoFullName).toBe("acme/widgets");

    const unscoped = recordCalibrationSnapshot(validPayload(), { eventLedger: ledger }) as unknown as Record<
      string,
      unknown
    >;
    expect(unscoped.repoFullName).toBeNull();
    expect(ledger._events).toHaveLength(2);
  });
});

describe("readCalibrationSnapshots / latestCalibrationSnapshot (#4248)", () => {
  it("reduces the append-only stream, skipping foreign types and malformed payloads", () => {
    const ledger = mockLedger();
    ledger._events.push(
      { type: "pr_outcome", repoFullName: "acme/widgets", payload: validPayload(), seq: 1 }, // foreign type
      { type: MINER_CALIBRATION_SNAPSHOT_EVENT, repoFullName: "acme/widgets", payload: { bad: true }, seq: 2 }, // malformed
      {
        type: MINER_CALIBRATION_SNAPSHOT_EVENT,
        repoFullName: 99, // non-string repo → null
        payload: validPayload({ combinedAccuracy: 0.7 }),
        seq: "x", // non-int seq → null
        createdAt: 5, // non-string → null
      },
      {
        type: MINER_CALIBRATION_SNAPSHOT_EVENT,
        repoFullName: "acme/widgets",
        payload: validPayload({ combinedAccuracy: 0.8 }),
        seq: 4,
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    );
    const snapshots = readCalibrationSnapshots(ledger);
    expect(snapshots.map((s) => s.combinedAccuracy)).toEqual([0.7, 0.8]);
    expect(snapshots[0]).toMatchObject({ repoFullName: null, seq: null, createdAt: null });
    expect(snapshots[1]).toMatchObject({ repoFullName: "acme/widgets", seq: 4, createdAt: "2026-07-09T00:00:00.000Z" });
    expect(latestCalibrationSnapshot(ledger)?.combinedAccuracy).toBe(0.8);
  });

  it("reduces to empty for a nullish / unreadable ledger or a non-array read; latest is null", () => {
    expect(readCalibrationSnapshots(null as never)).toEqual([]);
    expect(readCalibrationSnapshots({} as never)).toEqual([]);
    expect(readCalibrationSnapshots({ readEvents: () => null } as never)).toEqual([]);
    expect(latestCalibrationSnapshot({ readEvents: () => [] } as never)).toBeNull();
  });
});

describe("runHistoricalReplayCalibrationCycle (#4248)", () => {
  const enabledConfig = { miner: { calibration: { phase7LoopEnabled: true, prOutcomeMinDecided: 1 } } };
  const prOutcome = { mergeConfirmed: 8, mergeFalse: 2, closeConfirmed: 0, closeFalse: 0 };

  it("wires replay scorer → real engine combine → persisted snapshot (the default combine branch)", () => {
    const ledger = mockLedger();
    const out = runHistoricalReplayCalibrationCycle(
      {
        config: enabledConfig,
        prOutcome,
        replayRun: {
          replayResults: [FEAT_REPLAY],
          replayRunId: "run-1",
          observedAt: "2026-07-09T00:00:00.000Z",
          harnessStatus: "healthy",
        },
        now: "2026-07-10T00:00:00.000Z",
        repoFullName: "acme/widgets",
      },
      { eventLedger: ledger },
    );
    // pr_outcome accuracy 0.8, historical_replay accuracy 1.0, default 0.5/0.5 weights → combined 0.9.
    expect(out.result.combinedAccuracy).toBe(0.9);
    expect(out.result.autonomyIncreasePermitted).toBe(true);
    expect(out.compositeScore).toBe(1);
    expect(out.sampleSize).toBe(1);
    expect(out.snapshot.combinedAccuracy).toBe(0.9);
    expect(out.snapshot.replayRunId).toBe("run-1");
    expect(out.recorded).not.toBeNull();
    expect(readCalibrationSnapshots(ledger, { repoFullName: "acme/widgets" })).toHaveLength(1);
  });

  it("uses an injected combine and does not persist when no ledger is injected", () => {
    const computeLoop = vi.fn(() => fakeResult({ combinedAccuracy: 0.5 }) as never);
    const out = runHistoricalReplayCalibrationCycle(
      { replayRun: { replayResults: [FEAT_REPLAY], replayRunId: "r", observedAt: "o", harnessStatus: "healthy" } },
      { computeLoop },
    );
    expect(computeLoop).toHaveBeenCalledOnce();
    expect(out.recorded).toBeNull();
    expect(out.snapshot.combinedAccuracy).toBe(0.5);
    // observedAt falls back to the replay run's observedAt when the input carries none.
    expect(out.snapshot.observedAt).toBe("o");
  });

  it("runs with fully-defaulted deps (real engine combine, no ledger) and records nothing", () => {
    const out = runHistoricalReplayCalibrationCycle({ config: enabledConfig, prOutcome });
    expect(out.recorded).toBeNull();
    expect(out.historicalReplay).toBeNull();
    expect(typeof out.result.enabled).toBe("boolean");
  });

  it("prefers an explicit input.observedAt, and falls back to null with no replay run at all", () => {
    const computeLoop = vi.fn(() => fakeResult() as never);
    const withOverride = runHistoricalReplayCalibrationCycle(
      { replayRun: { replayResults: [FEAT_REPLAY], observedAt: "run-time", harnessStatus: "healthy" }, observedAt: "override" },
      { computeLoop },
    );
    expect(withOverride.snapshot.observedAt).toBe("override");

    const noReplay = runHistoricalReplayCalibrationCycle(undefined, { computeLoop });
    expect(noReplay.historicalReplay).toBeNull();
    expect(noReplay.snapshot.observedAt).toBeNull();
    expect(noReplay.snapshot.replayRunId).toBeNull();
    expect(noReplay.sampleSize).toBe(0);
  });
});

describe("backtestTrackRecord snapshot section (#8185)", () => {
  const baseResult = {
    enabled: true,
    combinedAccuracy: 0.8,
    baselineAccuracy: 0.62,
    deltaFromBaseline: 0.18,
    autonomyIncreasePermitted: false,
    replayHarnessHold: false,
    replayHarnessStatus: "healthy",
    replayRunDue: false,
    holdReasons: [],
    audit: { contributingSources: ["pr_outcome"] },
  } as unknown as Parameters<typeof snapshotPayloadFromResult>[0];

  it("threads a valid track record through the payload and round-trips the normalizer; absence stays null", () => {
    const record = { totalRuns: 4, regressedRuns: 1, regressedRate: 0.25 };
    const payload = snapshotPayloadFromResult(baseResult, { backtestTrackRecord: record });
    expect(payload.backtestTrackRecord).toEqual(record);
    expect(normalizeCalibrationSnapshotPayload(payload)?.backtestTrackRecord).toEqual(record);
    expect(snapshotPayloadFromResult(baseResult).backtestTrackRecord).toBeNull();
    // A zero-run record keeps its null rate.
    const empty = snapshotPayloadFromResult(baseResult, { backtestTrackRecord: { totalRuns: 0, regressedRuns: 0, regressedRate: null } });
    expect(empty.backtestTrackRecord).toEqual({ totalRuns: 0, regressedRuns: 0, regressedRate: null });
  });

  it("a malformed section degrades to null WITHOUT rejecting the snapshot (every invalid arm)", () => {
    for (const bad of [
      "not-an-object",
      { totalRuns: -1, regressedRuns: 0, regressedRate: null },
      { totalRuns: 1.5, regressedRuns: 0, regressedRate: null },
      { totalRuns: 2, regressedRuns: -2, regressedRate: null },
      { totalRuns: 2, regressedRuns: 1, regressedRate: "half" },
      { totalRuns: 2, regressedRuns: 1, regressedRate: Number.NaN },
    ]) {
      const payload = snapshotPayloadFromResult(baseResult, { backtestTrackRecord: bad as never });
      expect(payload.backtestTrackRecord).toBeNull();
      expect(normalizeCalibrationSnapshotPayload(payload)).not.toBeNull();
    }
    // Read-side tolerance: an old persisted row without the field normalizes with null.
    const legacy = snapshotPayloadFromResult(baseResult) as unknown as Record<string, unknown>;
    delete legacy.backtestTrackRecord;
    expect(normalizeCalibrationSnapshotPayload(legacy)?.backtestTrackRecord).toBeNull();
  });
});
