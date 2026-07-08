import { describe, expect, it } from "vitest";
import {
  buildCalibrationRecapSection,
  type CalibrationRecapSource,
} from "../../src/services/maintainer-recap-calibration";

const WINDOW = 7;

function report(totals: CalibrationRecapSource["totals"], windowDays = WINDOW): CalibrationRecapSource {
  return { windowDays, totals };
}

describe("buildCalibrationRecapSection (#2243)", () => {
  it("emits a drift-present section when humans reversed auto-actions (reversals > 0 arm)", () => {
    // 2 reversals over 10 merged+closed ⇒ rate 0.2 — the populated denominator / drift arm.
    const section = buildCalibrationRecapSection(report({ merged: 7, closed: 3, reversals: 2 }));
    expect(section.title).toBe("Calibration");
    expect(section.reversals).toBe(2);
    expect(section.reversalRate).toBe(0.2);
    expect(section.note).toMatch(/calibration drift/i);
    expect(section.note).toMatch(/2 auto-action\(s\) were human-reverted/);
    expect(section.note).toMatch(/reversal-rate 20%/);
    expect(section.note).toMatch(/Consider reviewing confidenceFloor/);
    expect(section.lines).toEqual([
      "Reversals: 2",
      "Reversal rate: 20%",
      section.note,
    ]);
  });

  it("emits a healthy section when auto-actions resolved with zero reversals (healthy arm)", () => {
    // Denominator > 0, reversals === 0 ⇒ healthy calibration (both sides of the reversals > 0 branch).
    const section = buildCalibrationRecapSection(report({ merged: 5, closed: 2, reversals: 0 }));
    expect(section.reversals).toBe(0);
    expect(section.reversalRate).toBe(0);
    expect(section.note).toMatch(/Calibration healthy/i);
    expect(section.note).toMatch(/0 auto-action\(s\) reverted/);
    expect(section.note).toMatch(/reversal-rate 0%/);
    expect(section.note).not.toMatch(/calibration drift/i);
    expect(section.lines[0]).toBe("Reversals: 0");
    expect(section.lines[1]).toBe("Reversal rate: 0%");
  });

  it("returns reversalRate 0 when nothing auto-acted (zero-denominator / merged+closed === 0 arm)", () => {
    // alerts.ts:56 — "0 when nothing auto-acted"; must NOT divide by zero or emit NaN.
    const section = buildCalibrationRecapSection(report({ merged: 0, closed: 0, reversals: 0 }));
    expect(section.reversals).toBe(0);
    expect(section.reversalRate).toBe(0);
    expect(Number.isFinite(section.reversalRate)).toBe(true);
    expect(section.note).toMatch(/Nothing auto-acted/);
    expect(section.note).toMatch(/no denominator/);
    expect(section.lines[1]).toBe("Reversal rate: 0%");
  });

  it("still reports a finite 0 rate when reversals are present but merged+closed is 0 (zero-denominator with stray count)", () => {
    // Defensive: a ledger inconsistency must still take the nothing-auto-acted rate arm (denominator wins).
    const section = buildCalibrationRecapSection(report({ merged: 0, closed: 0, reversals: 3 }));
    expect(section.reversalRate).toBe(0);
    expect(section.reversals).toBe(3);
    expect(section.note).toMatch(/Nothing auto-acted/);
    expect(section.note).not.toMatch(/calibration drift/i);
  });

  it("covers the merged-only and closed-only denominator arms (both sides of merged + closed)", () => {
    const mergedOnly = buildCalibrationRecapSection(report({ merged: 4, closed: 0, reversals: 1 }));
    expect(mergedOnly.reversalRate).toBe(0.25);
    expect(mergedOnly.note).toMatch(/calibration drift/i);

    const closedOnly = buildCalibrationRecapSection(report({ merged: 0, closed: 4, reversals: 1 }));
    expect(closedOnly.reversalRate).toBe(0.25);
    expect(closedOnly.note).toMatch(/4 merged\/closed/);
  });

  it("rounds the reversal rate to three decimal places (mirrors ops.ts AgentHealth.reversalRate)", () => {
    // 1/3 ⇒ 0.333… → Number((1/3).toFixed(3)) === 0.333; percent line uses Math.round ⇒ 33%.
    const section = buildCalibrationRecapSection(report({ merged: 2, closed: 1, reversals: 1 }));
    expect(section.reversalRate).toBe(0.333);
    expect(section.lines[1]).toBe("Reversal rate: 33%");
  });

  it("scrubs a local-path leak if one ever reaches the note via windowDays echo (defense-in-depth — note is count-derived today)", () => {
    // The note only interpolates numbers + fixed copy today; this pins that EVERY emitted line still
    // runs through sanitizeRecapText so a future free-text field cannot leak a path.
    const section = buildCalibrationRecapSection(report({ merged: 1, closed: 0, reversals: 0 }));
    for (const line of section.lines) {
      expect(line).not.toMatch(/\/Users\//);
      expect(line).not.toMatch(/C:\\/);
    }
    expect(section.note).not.toMatch(/\/Users\//);
  });
});
