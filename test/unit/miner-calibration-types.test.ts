import { describe, expect, it } from "vitest";
import {
  isCalibrationReport,
  isCalibrationRow,
  isObservedOutcomeRecord,
  isPredictedVerdictRecord,
} from "../../packages/loopover-miner/lib/calibration";
import type {
  CalibrationReport,
  CalibrationRow,
  ObservedOutcomeRecord,
  PredictedVerdictRecord,
} from "../../packages/loopover-miner/lib/calibration";

describe("loopover-miner calibration types scaffold (#2332)", () => {
  const predicted: PredictedVerdictRecord = {
    targetId: "pr:JSONbored/loopover#42",
    project: "JSONbored/loopover",
    predictedDecision: "merge",
    recordedAt: "2026-07-06T00:00:00.000Z",
    source: "reviewbot",
  };

  const observed: ObservedOutcomeRecord = {
    targetId: "pr:JSONbored/loopover#42",
    project: "JSONbored/loopover",
    outcomeDecision: "merged",
    recordedAt: "2026-07-06T01:00:00.000Z",
  };

  const row: CalibrationRow = {
    project: "JSONbored/loopover",
    wouldMerge: 10,
    mergeConfirmed: 8,
    mergeFalse: 2,
    wouldClose: 3,
    closeConfirmed: 2,
    closeFalse: 1,
    hold: 1,
    decided: 13,
    mergePrecision: 0.8,
    closePrecision: 2 / 3,
  };

  const report: CalibrationReport = {
    rows: [row],
    hasSignal: true,
  };

  it("accepts minimal fixtures for every shared calibration shape", () => {
    expect(isPredictedVerdictRecord(predicted)).toBe(true);
    expect(isObservedOutcomeRecord(observed)).toBe(true);
    expect(isCalibrationRow(row)).toBe(true);
    expect(isCalibrationReport(report)).toBe(true);
  });

  it("rejects malformed prediction and outcome records", () => {
    expect(isPredictedVerdictRecord(null)).toBe(false);
    expect(isPredictedVerdictRecord({ ...predicted, targetId: "" })).toBe(false);
    expect(isPredictedVerdictRecord({ ...predicted, source: 1 })).toBe(false);
    expect(isObservedOutcomeRecord({ ...observed, outcomeDecision: "" })).toBe(false);
  });

  it("rejects malformed calibration rows and reports", () => {
    expect(isCalibrationRow({ ...row, mergePrecision: 1.5 })).toBe(false);
    expect(isCalibrationRow({ ...row, decided: -1 })).toBe(false);
    expect(isCalibrationReport({ rows: [row], hasSignal: "yes" })).toBe(false);
    expect(isCalibrationReport({ rows: [{ ...row, project: "" }], hasSignal: true })).toBe(false);
  });

  it("rejects null, non-object, and array values for every shape's own top-level guard", () => {
    for (const bad of [null, "not-an-object", 42, ["array", "not", "object"]]) {
      expect(isObservedOutcomeRecord(bad)).toBe(false);
      expect(isCalibrationRow(bad)).toBe(false);
      expect(isCalibrationReport(bad)).toBe(false);
    }
  });
});
