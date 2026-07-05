import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeGateVerdictCompositeCalibrationScore,
  computePhase7CalibrationLoop,
  computePrOutcomeCalibrationAccuracy,
  DOCUMENTED_CALIBRATION_BASELINE,
  evaluateAutonomyIncreaseEligibility,
  isHistoricalReplayRunFresh,
  renderPhase7CalibrationAuditMarkdown,
  resolvePhase7CalibrationConfig,
  shouldScheduleHistoricalReplayRun,
} from "../dist/index.js";

const NOW = "2026-07-04T18:00:00.000Z";
const FRESH_REPLAY_AT = "2026-07-04T12:00:00.000Z";
const STALE_REPLAY_AT = "2026-06-20T12:00:00.000Z";

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return resolvePhase7CalibrationConfig({
    miner: {
      calibration: {
        phase7LoopEnabled: true,
        autonomyIncreaseMinAccuracy: 0.7,
        replayFreshnessMaxAgeHours: 168,
        historicalReplayWeight: 0.5,
        prOutcomeWeight: 0.5,
        ...overrides,
      },
    },
  });
}

function healthyReplay(compositeScore = 0.82) {
  return {
    compositeScore,
    replayRunId: "replay-2026-07-04",
    observedAt: FRESH_REPLAY_AT,
    harnessStatus: "healthy" as const,
  };
}

function sufficientPrOutcome(accuracy = 0.75) {
  const decided = 20;
  const correct = Math.round(decided * accuracy);
  const incorrect = decided - correct;
  return {
    mergeConfirmed: correct,
    mergeFalse: incorrect,
    closeConfirmed: 0,
    closeFalse: 0,
    observedAt: NOW,
  };
}

test("barrel: exports Phase 7 calibration loop APIs (#3014)", () => {
  assert.equal(DOCUMENTED_CALIBRATION_BASELINE, 0.62);
  assert.equal(typeof resolvePhase7CalibrationConfig, "function");
  assert.equal(typeof computePrOutcomeCalibrationAccuracy, "function");
  assert.equal(typeof isHistoricalReplayRunFresh, "function");
  assert.equal(typeof shouldScheduleHistoricalReplayRun, "function");
  assert.equal(typeof computePhase7CalibrationLoop, "function");
  assert.equal(typeof evaluateAutonomyIncreaseEligibility, "function");
  assert.equal(typeof renderPhase7CalibrationAuditMarkdown, "function");
});

test("resolvePhase7CalibrationConfig defaults to disabled fail-closed settings", () => {
  assert.deepEqual(resolvePhase7CalibrationConfig(undefined), {
    phase7LoopEnabled: false,
    autonomyIncreaseMinAccuracy: 0.7,
    replayFreshnessMaxAgeHours: 168,
    historicalReplayWeight: 0.5,
    prOutcomeWeight: 0.5,
    prOutcomeMinDecided: 10,
    warnings: [],
  });
});

test("resolvePhase7CalibrationConfig honors the explicit miner opt-in path", () => {
  const result = resolvePhase7CalibrationConfig({
    miner: {
      calibration: {
        phase7LoopEnabled: true,
        autonomyIncreaseMinAccuracy: 0.68,
        replayFreshnessMaxAgeHours: 72,
        historicalReplayWeight: 0.6,
        prOutcomeWeight: 0.4,
        prOutcomeMinDecided: 15,
      },
    },
  });

  assert.deepEqual(result, {
    phase7LoopEnabled: true,
    autonomyIncreaseMinAccuracy: 0.68,
    replayFreshnessMaxAgeHours: 72,
    historicalReplayWeight: 0.6,
    prOutcomeWeight: 0.4,
    prOutcomeMinDecided: 15,
    warnings: [],
  });
});

test("resolvePhase7CalibrationConfig keeps top-level calibration as an explicit alias", () => {
  const result = resolvePhase7CalibrationConfig({
    calibration: {
      phase7LoopEnabled: "yes",
      autonomyIncreaseMinAccuracy: "0.66",
    },
  });

  assert.equal(result.phase7LoopEnabled, true);
  assert.equal(result.autonomyIncreaseMinAccuracy, 0.66);
});

test("resolvePhase7CalibrationConfig prefers miner.calibration over the top-level alias", () => {
  const result = resolvePhase7CalibrationConfig({
    miner: { calibration: { phase7LoopEnabled: false, autonomyIncreaseMinAccuracy: 0.71 } },
    calibration: { phase7LoopEnabled: true, autonomyIncreaseMinAccuracy: 0.99 },
  });

  assert.equal(result.phase7LoopEnabled, false);
  assert.equal(result.autonomyIncreaseMinAccuracy, 0.71);
});

test("resolvePhase7CalibrationConfig warns on malformed values and falls back safely", () => {
  const result = resolvePhase7CalibrationConfig({
    miner: {
      calibration: {
        phase7LoopEnabled: "maybe",
        autonomyIncreaseMinAccuracy: 1.5,
        replayFreshnessMaxAgeHours: -4,
        historicalReplayWeight: Number.NaN,
        prOutcomeWeight: "heavy",
        prOutcomeMinDecided: "few",
      },
    },
  });

  assert.equal(result.phase7LoopEnabled, false);
  assert.equal(result.autonomyIncreaseMinAccuracy, 0.7);
  assert.equal(result.replayFreshnessMaxAgeHours, 168);
  assert.equal(result.historicalReplayWeight, 0.5);
  assert.equal(result.prOutcomeWeight, 0.5);
  assert.equal(result.prOutcomeMinDecided, 10);
  assert.match(result.warnings.join("\n"), /phase7LoopEnabled/u);
  assert.match(result.warnings.join("\n"), /autonomyIncreaseMinAccuracy/u);
  assert.match(result.warnings.join("\n"), /replayFreshnessMaxAgeHours/u);
  assert.match(result.warnings.join("\n"), /historicalReplayWeight/u);
  assert.match(result.warnings.join("\n"), /prOutcomeWeight/u);
  assert.match(result.warnings.join("\n"), /prOutcomeMinDecided/u);
});

test("computePrOutcomeCalibrationAccuracy derives accuracy from the gate-eval confusion matrix", () => {
  assert.deepEqual(
    computePrOutcomeCalibrationAccuracy({
      mergeConfirmed: 62,
      mergeFalse: 38,
      closeConfirmed: 0,
      closeFalse: 0,
    }),
    { accuracy: 0.62, sampleSize: 100 },
  );
  assert.deepEqual(
    computePrOutcomeCalibrationAccuracy({
      mergeConfirmed: 0,
      mergeFalse: 0,
      closeConfirmed: 0,
      closeFalse: 0,
    }),
    { accuracy: null, sampleSize: 0 },
  );
});

test("isHistoricalReplayRunFresh accepts a replay inside the configured max age", () => {
  assert.equal(
    isHistoricalReplayRunFresh({
      observedAt: FRESH_REPLAY_AT,
      maxAgeHours: 168,
      now: NOW,
    }),
    true,
  );
  assert.equal(
    isHistoricalReplayRunFresh({
      observedAt: STALE_REPLAY_AT,
      maxAgeHours: 168,
      now: NOW,
    }),
    false,
  );
  assert.equal(
    isHistoricalReplayRunFresh({
      observedAt: "not-a-date",
      maxAgeHours: 168,
      now: NOW,
    }),
    false,
  );
});

test("shouldScheduleHistoricalReplayRun recommends a run when the loop is enabled but no replay exists", () => {
  assert.deepEqual(
    shouldScheduleHistoricalReplayRun({
      config: enabledConfig(),
      lastReplayObservedAt: null,
      now: NOW,
    }),
    { due: true, reason: "no_replay_run_recorded" },
  );
});

test("shouldScheduleHistoricalReplayRun recommends a run when the replay harness is degraded or unavailable", () => {
  assert.deepEqual(
    shouldScheduleHistoricalReplayRun({
      config: enabledConfig(),
      lastReplayObservedAt: FRESH_REPLAY_AT,
      harnessStatus: "degraded",
      now: NOW,
    }),
    { due: true, reason: "replay_harness_degraded" },
  );
  assert.deepEqual(
    shouldScheduleHistoricalReplayRun({
      config: enabledConfig(),
      lastReplayObservedAt: FRESH_REPLAY_AT,
      harnessStatus: "unavailable",
      now: NOW,
    }),
    { due: true, reason: "replay_harness_unavailable" },
  );
});

test("shouldScheduleHistoricalReplayRun stays quiet when the loop is disabled", () => {
  assert.deepEqual(
    shouldScheduleHistoricalReplayRun({
      config: resolvePhase7CalibrationConfig(undefined),
      lastReplayObservedAt: null,
      now: NOW,
    }),
    { due: false, reason: "phase7_loop_disabled" },
  );
});

test("README-shaped input passes raw pr_outcome counters so both sources contribute", () => {
  const prOutcome = {
    mergeConfirmed: 74,
    mergeFalse: 26,
    closeConfirmed: 0,
    closeFalse: 0,
    observedAt: "2026-07-04T18:00:00Z",
  };

  const loop = computePhase7CalibrationLoop({
    config: resolvePhase7CalibrationConfig({
      miner: {
        calibration: {
          phase7LoopEnabled: true,
          autonomyIncreaseMinAccuracy: 0.7,
          replayFreshnessMaxAgeHours: 168,
          historicalReplayWeight: 0.5,
          prOutcomeWeight: 0.5,
          prOutcomeMinDecided: 10,
        },
      },
    }),
    prOutcome,
    historicalReplay: {
      compositeScore: 0.82,
      replayRunId: "replay-2026-07-04",
      observedAt: "2026-07-04T12:00:00Z",
      harnessStatus: "healthy",
    },
    now: "2026-07-04T18:00:00Z",
  });

  assert.deepEqual(loop.audit.contributingSources, ["pr_outcome", "historical_replay"]);
  assert.equal(loop.bySource.pr_outcome.accuracy, 0.74);
  assert.equal(loop.bySource.pr_outcome.sampleSize, 100);
});

test("computePhase7CalibrationLoop combines historical-replay and pr_outcome signals with provenance", () => {
  const composite = computeGateVerdictCompositeCalibrationScore({
    objectiveAnchor: 0.8,
    pairwise: 0.76,
    gateVerdicts: { accepted: [], rejected: [] },
  });
  const result = computePhase7CalibrationLoop({
    config: enabledConfig(),
    prOutcome: sufficientPrOutcome(0.74),
    historicalReplay: {
      compositeScore: composite,
      replayRunId: "replay-2026-07-04",
      observedAt: FRESH_REPLAY_AT,
      harnessStatus: "healthy",
    },
    now: NOW,
  });

  assert.equal(result.enabled, true);
  assert.equal(result.combinedAccuracy, 0.76625);
  assert.equal(result.deltaFromBaseline, 0.14625);
  assert.deepEqual(result.audit.contributingSources, ["pr_outcome", "historical_replay"]);
  assert.equal(result.bySource.historical_replay.replayRunId, "replay-2026-07-04");
  assert.equal(result.bySource.pr_outcome.sampleSize, 20);
});

test("computePhase7CalibrationLoop permits autonomy increases only when both sources meet the threshold", () => {
  const passing = computePhase7CalibrationLoop({
    config: enabledConfig({ autonomyIncreaseMinAccuracy: 0.7 }),
    prOutcome: sufficientPrOutcome(0.74),
    historicalReplay: healthyReplay(0.82),
    now: NOW,
  });
  assert.equal(passing.autonomyIncreasePermitted, true);
  assert.deepEqual(passing.holdReasons, []);

  const failing = computePhase7CalibrationLoop({
    config: enabledConfig({ autonomyIncreaseMinAccuracy: 0.9 }),
    prOutcome: sufficientPrOutcome(0.74),
    historicalReplay: healthyReplay(0.82),
    now: NOW,
  });
  assert.equal(failing.autonomyIncreasePermitted, false);
  assert.deepEqual(failing.holdReasons, ["calibration_below_threshold"]);
});

test("computePhase7CalibrationLoop fails closed when the replay harness is degraded or unavailable", () => {
  for (const harnessStatus of ["degraded", "unavailable"] as const) {
    const result = computePhase7CalibrationLoop({
      config: enabledConfig(),
      prOutcome: sufficientPrOutcome(0.9),
      historicalReplay: {
        ...healthyReplay(0.9),
        harnessStatus,
      },
      now: NOW,
    });

    assert.equal(result.replayHarnessHold, true);
    assert.equal(result.autonomyIncreasePermitted, false);
    assert.ok(result.holdReasons.includes(`replay_harness_${harnessStatus}`));
    assert.ok(result.audit.rejectedSources.some((row) => row.reason === `replay_harness_${harnessStatus}`));
  }
});

test("REGRESSION: malformed historical replay scores fail closed instead of permitting autonomy increases", () => {
  for (const compositeScore of [{} as never, Number.NaN, Number.POSITIVE_INFINITY] as const) {
    const result = computePhase7CalibrationLoop({
      config: enabledConfig({ autonomyIncreaseMinAccuracy: 0.99 }),
      prOutcome: sufficientPrOutcome(1),
      historicalReplay: {
        ...healthyReplay(0.82),
        compositeScore,
      },
      now: NOW,
    });

    assert.equal(result.bySource.historical_replay.accuracy, null);
    assert.equal(result.combinedAccuracy, 1);
    assert.equal(result.replayHarnessHold, true);
    assert.equal(result.autonomyIncreasePermitted, false);
    assert.ok(result.holdReasons.includes("invalid_replay_score"));
    assert.ok(!result.audit.contributingSources.includes("historical_replay"));
    assert.ok(result.audit.rejectedSources.some((row) => row.reason === "invalid_replay_score"));
  }
});

test("computePhase7CalibrationLoop fails closed on stale replay rather than silently using pr_outcome only", () => {
  const result = computePhase7CalibrationLoop({
    config: enabledConfig(),
    prOutcome: sufficientPrOutcome(0.95),
    historicalReplay: {
      ...healthyReplay(0.95),
      observedAt: STALE_REPLAY_AT,
    },
    now: NOW,
  });

  assert.equal(result.replayHarnessHold, true);
  assert.equal(result.autonomyIncreasePermitted, false);
  assert.ok(result.holdReasons.includes("replay_run_stale"));
  assert.ok(result.audit.rejectedSources.some((row) => row.reason === "replay_run_stale"));
  assert.ok(!result.audit.contributingSources.includes("historical_replay"));
});

test("computePhase7CalibrationLoop fails closed when no historical replay signal is present", () => {
  const result = computePhase7CalibrationLoop({
    config: enabledConfig(),
    prOutcome: sufficientPrOutcome(0.95),
    now: NOW,
  });

  assert.equal(result.replayHarnessHold, true);
  assert.equal(result.autonomyIncreasePermitted, false);
  assert.ok(result.holdReasons.includes("no_historical_replay_signal"));
});

test("computePhase7CalibrationLoop does not gate autonomy when the loop is disabled", () => {
  const result = computePhase7CalibrationLoop({
    config: resolvePhase7CalibrationConfig(undefined),
    prOutcome: sufficientPrOutcome(0.4),
    now: NOW,
  });

  assert.equal(result.enabled, false);
  assert.equal(result.autonomyIncreasePermitted, true);
  assert.deepEqual(result.holdReasons, []);
});

test("computePhase7CalibrationLoop rejects pr_outcome rows below the configured minimum sample size", () => {
  const result = computePhase7CalibrationLoop({
    config: enabledConfig({ prOutcomeMinDecided: 10 }),
    prOutcome: {
      mergeConfirmed: 6,
      mergeFalse: 2,
      closeConfirmed: 0,
      closeFalse: 0,
      observedAt: NOW,
    },
    historicalReplay: healthyReplay(0.82),
    now: NOW,
  });

  assert.ok(result.audit.rejectedSources.some((row) => row.reason === "insufficient_pr_outcome_samples"));
  assert.equal(result.autonomyIncreasePermitted, false);
  assert.ok(result.holdReasons.includes("missing_required_signal_source"));
});

test("evaluateAutonomyIncreaseEligibility mirrors the computed loop hold state", () => {
  const result = computePhase7CalibrationLoop({
    config: enabledConfig(),
    prOutcome: sufficientPrOutcome(0.74),
    historicalReplay: healthyReplay(0.82),
    now: NOW,
  });

  assert.deepEqual(evaluateAutonomyIncreaseEligibility(result), {
    permitted: true,
    holdReasons: [],
    replayHarnessHold: false,
  });
});

test("renderPhase7CalibrationAuditMarkdown renders baseline, per-source breakdown, and hold reasons", () => {
  const result = computePhase7CalibrationLoop({
    config: enabledConfig(),
    prOutcome: sufficientPrOutcome(0.74),
    historicalReplay: healthyReplay(0.82),
    now: NOW,
  });
  const markdown = renderPhase7CalibrationAuditMarkdown(result);

  assert.match(markdown, /# Phase 7 Calibration Loop/u);
  assert.match(markdown, /documented baseline: 62\.00%/u);
  assert.match(markdown, /### historical_replay/u);
  assert.match(markdown, /### pr_outcome/u);
  assert.match(markdown, /autonomy increase permitted: true/u);
  assert.match(markdown, /Contributing Sources/u);
});

test("renderPhase7CalibrationAuditMarkdown escapes replay run ids and hold reasons", () => {
  const result = computePhase7CalibrationLoop({
    config: enabledConfig(),
    prOutcome: sufficientPrOutcome(0.74),
    historicalReplay: {
      ...healthyReplay(0.82),
      replayRunId: "replay-*bold*",
    },
    now: NOW,
  });
  const markdown = renderPhase7CalibrationAuditMarkdown(result);

  assert.ok(markdown.includes("replay-\\*bold\\*"));
});

test("REGRESSION (#3014): combined metric stays anchored to the documented 62% baseline", () => {
  const result = computePhase7CalibrationLoop({
    config: enabledConfig(),
    prOutcome: {
      mergeConfirmed: 62,
      mergeFalse: 38,
      closeConfirmed: 0,
      closeFalse: 0,
      observedAt: NOW,
    },
    historicalReplay: healthyReplay(0.62),
    now: NOW,
  });

  assert.equal(result.baselineAccuracy, 0.62);
  assert.equal(result.combinedAccuracy, 0.62);
  assert.equal(result.deltaFromBaseline, 0);
});
