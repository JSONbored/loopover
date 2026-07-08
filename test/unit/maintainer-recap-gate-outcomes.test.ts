import { describe, expect, it } from "vitest";
import {
  buildGateOutcomesRecapSection,
  type GateOutcomesRecapSource,
} from "../../src/services/maintainer-recap-gate-outcomes";

const WINDOW = 7;

function report(totals: GateOutcomesRecapSource["totals"], windowDays = WINDOW): GateOutcomesRecapSource {
  return { windowDays, totals };
}

describe("buildGateOutcomesRecapSection (#2242)", () => {
  it("emits counts + a numeric rate when blocks clear MIN_SAMPLE (enough-samples arm)", () => {
    // 10 blocks ≥ MIN_SAMPLE(5), 3 merged anyway ⇒ rate 0.3.
    const section = buildGateOutcomesRecapSection(report({ blocked: 10, gateFalsePositives: 3, gateOverrides: 2 }));
    expect(section.title).toBe("Gate outcomes");
    expect(section.blocked).toBe(10);
    expect(section.overridden).toBe(2);
    expect(section.falsePositives).toBe(3);
    expect(section.falsePositiveRate).toBe(0.3);
    expect(section.lines).toEqual([
      "Blocked: 10",
      "Maintainer overrides: 2",
      "False positives (blocked then merged): 3",
      "False-positive rate: 30% (3 of 10 blocks merged anyway)",
    ]);
  });

  it("nulls the rate below MIN_SAMPLE (too-few-samples arm) — a 1-of-few FP is noise, not a signal", () => {
    // 4 blocks < MIN_SAMPLE(5) ⇒ rate null even though a block merged anyway.
    const section = buildGateOutcomesRecapSection(report({ blocked: 4, gateFalsePositives: 1, gateOverrides: 1 }));
    expect(section.falsePositiveRate).toBeNull();
    expect(section.falsePositives).toBe(1);
    expect(section.lines[3]).toBe("False-positive rate: n/a (fewer than 5 blocks in the last 7 day(s))");
  });

  it("treats exactly MIN_SAMPLE blocks as enough (boundary — blocked === 5)", () => {
    const section = buildGateOutcomesRecapSection(report({ blocked: 5, gateFalsePositives: 1, gateOverrides: 0 }));
    expect(section.falsePositiveRate).toBe(0.2); // 1/5, ≥ MIN_SAMPLE ⇒ numeric
    expect(section.lines[3]).toBe("False-positive rate: 20% (1 of 5 blocks merged anyway)");
  });

  it("nulls the rate on an empty report without dividing by zero (blocked === 0 arm)", () => {
    const section = buildGateOutcomesRecapSection(report({ blocked: 0, gateFalsePositives: 0, gateOverrides: 0 }));
    expect(section.falsePositiveRate).toBeNull();
    expect(Number.isNaN(section.falsePositiveRate as number)).toBe(false);
    expect(section.lines).toEqual([
      "Blocked: 0",
      "Maintainer overrides: 0",
      "False positives (blocked then merged): 0",
      "False-positive rate: n/a (fewer than 5 blocks in the last 7 day(s))",
    ]);
  });

  it("rounds the rate to three decimals like gate-precision.ts (percent via Math.round)", () => {
    // 1/6 = 0.16666… ⇒ round(*1000)/1000 = 0.167; percent line ⇒ Math.round(16.7) = 17%.
    const section = buildGateOutcomesRecapSection(report({ blocked: 6, gateFalsePositives: 1, gateOverrides: 0 }));
    expect(section.falsePositiveRate).toBe(0.167);
    expect(section.lines[3]).toBe("False-positive rate: 17% (1 of 6 blocks merged anyway)");
  });

  it("scrubs a local-path leak from every emitted line (defense-in-depth — lines are count-derived today)", () => {
    const section = buildGateOutcomesRecapSection(report({ blocked: 7, gateFalsePositives: 0, gateOverrides: 0 }));
    for (const line of section.lines) {
      expect(line).not.toMatch(/\/Users\//);
      expect(line).not.toMatch(/\/tmp\//);
    }
  });
});
