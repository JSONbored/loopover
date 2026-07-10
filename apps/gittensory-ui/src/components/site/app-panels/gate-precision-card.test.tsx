import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GatePrecisionCard } from "@/components/site/app-panels/gate-precision-card";
import {
  aggregateGateEval,
  type GateEvalReport,
} from "@/components/site/app-panels/gate-precision-card-model";

function row(overrides: Partial<GateEvalReport["rows"][number]> = {}) {
  return {
    project: "acme/widgets",
    wouldMerge: 0,
    mergeConfirmed: 0,
    mergeFalse: 0,
    wouldClose: 0,
    closeConfirmed: 0,
    closeFalse: 0,
    hold: 0,
    decided: 0,
    mergePrecision: null,
    closePrecision: null,
    ...overrides,
  };
}

describe("aggregateGateEval", () => {
  it("folds multiple project rows into one confusion matrix + merge precision", () => {
    const report: GateEvalReport = {
      hasSignal: true,
      rows: [
        row({ mergeConfirmed: 6, mergeFalse: 2, closeConfirmed: 3, closeFalse: 1, decided: 12 }),
        row({
          project: "acme/other",
          mergeConfirmed: 2,
          mergeFalse: 0,
          closeConfirmed: 1,
          closeFalse: 0,
          decided: 3,
        }),
      ],
    };
    expect(aggregateGateEval(report)).toEqual({
      truePositive: 8,
      falsePositive: 2,
      falseNegative: 1,
      trueNegative: 4,
      decided: 15,
      mergePrecision: 8 / 10,
    });
  });

  it("returns all-zero counts and null precision for an empty report (no merge predictions ⇒ empty denominator)", () => {
    expect(aggregateGateEval({ hasSignal: false, rows: [] })).toEqual({
      truePositive: 0,
      falsePositive: 0,
      falseNegative: 0,
      trueNegative: 0,
      decided: 0,
      mergePrecision: null,
    });
  });
});

describe("GatePrecisionCard", () => {
  it("renders precision, decided count, and the 2x2 confusion matrix for a populated report", () => {
    const report: GateEvalReport = {
      hasSignal: true,
      rows: [
        row({ mergeConfirmed: 6, mergeFalse: 2, closeConfirmed: 3, closeFalse: 1, decided: 12 }),
      ],
    };
    render(<GatePrecisionCard report={report} />);
    expect(screen.getByText("Gate precision")).toBeTruthy();
    // 6/(6+2) = 75%
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("12 decided")).toBeTruthy();
    expect(screen.getByText("True positive")).toBeTruthy();
    expect(screen.getByText("False negative")).toBeTruthy();
  });

  it("renders '—' for precision when the gate made no merge predictions (null-precision arm)", () => {
    const report: GateEvalReport = {
      hasSignal: true,
      rows: [row({ closeConfirmed: 4, decided: 4 })], // only close predictions → merge denominator is 0
    };
    render(<GatePrecisionCard report={report} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("flags the below-floor state via the StatusPill when hasSignal is false", () => {
    const report: GateEvalReport = {
      hasSignal: false,
      rows: [row({ mergeConfirmed: 1, decided: 1 })],
    };
    render(<GatePrecisionCard report={report} />);
    expect(screen.getByText("below 10-sample floor")).toBeTruthy();
  });

  it("renders nothing when there are no evaluated project rows at all", () => {
    const { container } = render(<GatePrecisionCard report={{ hasSignal: false, rows: [] }} />);
    expect(container.firstChild).toBeNull();
  });
});
