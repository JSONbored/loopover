import { describe, expect, it } from "vitest";
import { isImprovementSignalEnabled } from "../../src/review/improvement-signal-wire";

describe("isImprovementSignalEnabled — the improvementSignal converged-feature master kill-switch (#4738)", () => {
  it("is off when the env flag is unset (the nullish fallback branch)", () => {
    expect(isImprovementSignalEnabled({ LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL: undefined })).toBe(false);
    expect(isImprovementSignalEnabled({})).toBe(false);
  });

  it("is off for an explicit falsy-looking value", () => {
    expect(isImprovementSignalEnabled({ LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL: "false" })).toBe(false);
    expect(isImprovementSignalEnabled({ LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL: "0" })).toBe(false);
  });

  it("is on for every truthy-string spelling, case-insensitively (the present branch)", () => {
    for (const value of ["1", "true", "TRUE", "yes", "YES", "on", "On"]) {
      expect(isImprovementSignalEnabled({ LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL: value })).toBe(true);
    }
  });
});
