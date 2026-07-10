import { describe, expect, it } from "vitest";
import {
  buildCalibrationDashboardView,
  resolveCalibrationDashboardStatus,
} from "../../packages/gittensory-engine/src/index";
import type { Phase7CalibrationLoopResult } from "../../packages/gittensory-engine/src/index";

function metric(accuracy: number | null, sampleSize: number, fresh: boolean) {
  return { source: "pr_outcome" as const, accuracy, sampleSize, observedAt: "2026-01-01T00:00:00Z", fresh };
}

function makeResult(overrides: Partial<Phase7CalibrationLoopResult> = {}): Phase7CalibrationLoopResult {
  return {
    enabled: true,
    baselineAccuracy: 0.62,
    combinedAccuracy: 0.68,
    deltaFromBaseline: 0.06,
    weights: { historicalReplay: 0.5, prOutcome: 0.5 },
    bySource: {
      historical_replay: { ...metric(0.7, 20, true), source: "historical_replay" },
      pr_outcome: metric(0.66, 12, false),
    },
    replayHarnessHold: false,
    replayHarnessStatus: "healthy",
    autonomyIncreasePermitted: true,
    holdReasons: [],
    replayRunDue: false,
    audit: { contributingSources: ["pr_outcome"], rejectedSources: [] },
    ...overrides,
  };
}

describe("resolveCalibrationDashboardStatus (#4261)", () => {
  it("classifies disabled / insufficient / on-track / below-baseline", () => {
    expect(resolveCalibrationDashboardStatus(makeResult({ enabled: false }))).toBe("disabled");
    expect(resolveCalibrationDashboardStatus(makeResult({ combinedAccuracy: null }))).toBe("insufficient_signal");
    expect(resolveCalibrationDashboardStatus(makeResult({ combinedAccuracy: 0.68, baselineAccuracy: 0.62 }))).toBe(
      "on_track",
    );
    expect(resolveCalibrationDashboardStatus(makeResult({ combinedAccuracy: 0.55, baselineAccuracy: 0.62 }))).toBe(
      "below_baseline",
    );
  });
});

describe("buildCalibrationDashboardView", () => {
  it("projects an on-track result: headline, formatted rows, per-source freshness", () => {
    const view = buildCalibrationDashboardView(makeResult());
    expect(view.status).toBe("on_track");
    expect(view.headline).toBe("68% combined (+6pts vs baseline)");
    const byLabel = Object.fromEntries(view.rows.map((r) => [r.label, r]));
    expect(byLabel["Combined accuracy"]?.value).toBe("68%");
    expect(byLabel["Combined accuracy"]?.detail).toBe("baseline 62%");
    expect(byLabel["Delta from baseline"]?.value).toBe("+6pts");
    expect(byLabel["Historical replay"]?.detail).toBe("n=20 · fresh");
    expect(byLabel["PR outcome"]?.detail).toBe("n=12 · stale");
    expect(byLabel["Replay harness"]?.value).toBe("healthy");
    expect(byLabel["Replay harness"]?.detail).toBe("ok");
    expect(byLabel["Autonomy increase"]?.value).toBe("permitted");
    expect(byLabel["Autonomy increase"]?.detail).toBe("up to date");
  });

  it("formats a below-baseline result with a negative delta", () => {
    const view = buildCalibrationDashboardView(
      makeResult({ combinedAccuracy: 0.55, deltaFromBaseline: -0.07, baselineAccuracy: 0.62 }),
    );
    expect(view.status).toBe("below_baseline");
    expect(view.headline).toBe("55% combined (-7pts vs baseline)");
    const delta = view.rows.find((r) => r.label === "Delta from baseline");
    expect(delta?.value).toBe("-7pts");
  });

  it("shows an em dash and an insufficient-signal headline when there is no combined accuracy", () => {
    const view = buildCalibrationDashboardView(makeResult({ combinedAccuracy: null, deltaFromBaseline: null }));
    expect(view.status).toBe("insufficient_signal");
    expect(view.headline).toBe("Insufficient signal to score calibration yet");
    const combined = view.rows.find((r) => r.label === "Combined accuracy");
    expect(combined?.value).toBe("—");
    expect(view.rows.find((r) => r.label === "Delta from baseline")?.value).toBe("—");
  });

  it("reflects a disabled loop, a harness hold, a due replay run, and surfaces hold reasons", () => {
    const view = buildCalibrationDashboardView(
      makeResult({
        enabled: false,
        replayHarnessHold: true,
        replayHarnessStatus: "missing",
        autonomyIncreasePermitted: false,
        replayRunDue: true,
        holdReasons: ["no_historical_replay_signal", "replay_run_stale"],
      }),
    );
    expect(view.status).toBe("disabled");
    expect(view.headline).toBe("Calibration loop disabled");
    const byLabel = Object.fromEntries(view.rows.map((r) => [r.label, r]));
    expect(byLabel["Replay harness"]?.detail).toBe("hold");
    expect(byLabel["Replay harness"]?.value).toBe("missing");
    expect(byLabel["Autonomy increase"]?.value).toBe("held");
    expect(byLabel["Autonomy increase"]?.detail).toBe("replay run due");
    expect(view.holdReasons).toEqual(["no_historical_replay_signal", "replay_run_stale"]);
  });
});
