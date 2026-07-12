import { describe, expect, it } from "vitest";
import {
  buildCalibrationReport,
  isCalibrationReport,
} from "../../packages/gittensory-miner/lib/calibration.js";
import type {
  ObservedOutcomeRecord,
  PredictedVerdictRecord,
} from "../../packages/gittensory-miner/lib/calibration.js";

const TS = "2026-07-12T00:00:00.000Z";
const pred = (project: string, targetId: string, predictedDecision: string): PredictedVerdictRecord => ({
  project,
  targetId,
  predictedDecision,
  recordedAt: TS,
});
const out = (project: string, targetId: string, outcomeDecision: string): ObservedOutcomeRecord => ({
  project,
  targetId,
  outcomeDecision,
  recordedAt: TS,
});
const rowFor = (report: ReturnType<typeof buildCalibrationReport>, project: string) =>
  report.rows.find((r) => r.project === project);

describe("buildCalibrationReport (#4849)", () => {
  it("returns an empty, no-signal report for empty or non-array input", () => {
    expect(buildCalibrationReport([], [])).toEqual({ hasSignal: false, rows: [] });
    // Non-array inputs are tolerated as empty.
    expect(buildCalibrationReport(null as never, undefined as never)).toEqual({ hasSignal: false, rows: [] });
  });

  it("skips a prediction with no realized outcome yet (still pending)", () => {
    const report = buildCalibrationReport([pred("a/b", "1", "merge")], []);
    expect(report).toEqual({ hasSignal: false, rows: [] });
  });

  it("skips a prediction whose outcome is unrecognized (not a clear merge/close)", () => {
    const report = buildCalibrationReport([pred("a/b", "1", "merge")], [out("a/b", "1", "unknown-thing")]);
    expect(report.hasSignal).toBe(false);
    expect(report.rows).toEqual([]);
  });

  it("counts a correct merge prediction as confirmed with precision 1", () => {
    const report = buildCalibrationReport([pred("a/b", "1", "merge")], [out("a/b", "1", "merged")]);
    expect(report.hasSignal).toBe(true);
    expect(rowFor(report, "a/b")).toMatchObject({
      wouldMerge: 1,
      mergeConfirmed: 1,
      mergeFalse: 0,
      decided: 1,
      mergePrecision: 1,
      closePrecision: null,
    });
    expect(isCalibrationReport(report)).toBe(true);
  });

  it("counts a merge prediction that actually closed as a false positive (precision 0)", () => {
    const report = buildCalibrationReport([pred("a/b", "1", "merge")], [out("a/b", "1", "closed")]);
    expect(rowFor(report, "a/b")).toMatchObject({ wouldMerge: 1, mergeConfirmed: 0, mergeFalse: 1, mergePrecision: 0 });
  });

  it("tallies close predictions (confirmed and false) and hold predictions", () => {
    const report = buildCalibrationReport(
      [pred("a/b", "1", "close"), pred("a/b", "2", "close"), pred("a/b", "3", "hold")],
      [out("a/b", "1", "close"), out("a/b", "2", "merge"), out("a/b", "3", "close")],
    );
    expect(rowFor(report, "a/b")).toMatchObject({
      wouldClose: 2,
      closeConfirmed: 1,
      closeFalse: 1,
      hold: 1,
      decided: 3,
      closePrecision: 0.5,
      mergePrecision: null, // no merge predictions ⇒ null
    });
  });

  it("aggregates independently per project and sorts rows by project", () => {
    const report = buildCalibrationReport(
      [pred("z/one", "1", "merge"), pred("a/two", "1", "close")],
      [out("z/one", "1", "merge"), out("a/two", "1", "close")],
    );
    expect(report.rows.map((r) => r.project)).toEqual(["a/two", "z/one"]); // sorted
    expect(rowFor(report, "z/one")).toMatchObject({ mergeConfirmed: 1, mergePrecision: 1 });
    expect(rowFor(report, "a/two")).toMatchObject({ closeConfirmed: 1, closePrecision: 1 });
  });

  it("ignores malformed prediction and outcome records", () => {
    const report = buildCalibrationReport(
      [pred("a/b", "1", "merge"), { project: "a/b" } as never, null as never],
      [out("a/b", "1", "merged"), { targetId: "x" } as never],
    );
    expect(report.rows).toHaveLength(1);
    expect(rowFor(report, "a/b")).toMatchObject({ decided: 1, mergeConfirmed: 1 });
  });

  it("counts a prediction with an unrecognized predicted decision as decided but in no confusion bucket", () => {
    const report = buildCalibrationReport([pred("a/b", "1", "maybe?")], [out("a/b", "1", "merged")]);
    expect(rowFor(report, "a/b")).toMatchObject({
      decided: 1,
      wouldMerge: 0,
      wouldClose: 0,
      hold: 0,
      mergePrecision: null,
      closePrecision: null,
    });
  });

  it("matches strictly on (project, targetId) — a same id under a different project is not joined", () => {
    const report = buildCalibrationReport([pred("a/b", "1", "merge")], [out("c/d", "1", "merged")]);
    expect(report.hasSignal).toBe(false); // outcome belongs to a different project
  });
});
