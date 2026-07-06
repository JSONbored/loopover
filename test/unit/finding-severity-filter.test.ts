import { describe, expect, it } from "vitest";
import {
  inlineFindingSeverityTier,
  meetsMinFindingSeverity,
  shouldShowInlineFinding,
} from "../../src/review/finding-severity-filter";

describe("finding-severity-filter (#2048)", () => {
  it("maps inline blocker/nit severities onto the unified ladder", () => {
    expect(inlineFindingSeverityTier("blocker")).toBe("critical");
    expect(inlineFindingSeverityTier("nit")).toBe("nitpick");
  });

  it("keeps findings at or above the configured floor", () => {
    expect(meetsMinFindingSeverity("critical", "major")).toBe(true);
    expect(meetsMinFindingSeverity("major", "major")).toBe(true);
    expect(meetsMinFindingSeverity("minor", "major")).toBe(false);
    expect(meetsMinFindingSeverity("nitpick", "major")).toBe(false);
    expect(meetsMinFindingSeverity("nitpick", null)).toBe(true);
  });

  it("filters inline findings without changing gate blockers", () => {
    expect(shouldShowInlineFinding("blocker", "major")).toBe(true);
    expect(shouldShowInlineFinding("nit", "major")).toBe(false);
    expect(shouldShowInlineFinding("nit", null)).toBe(true);
  });
});
