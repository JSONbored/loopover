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

  // #6802: inline findings only ever occupy two of the four severity tiers — blocker→critical (rank 0) and
  // nit→nitpick (rank 3). So a `nit` fails every floor except `nitpick`, which makes the `critical`, `major`, and
  // `minor` floors indistinguishable for inline findings (all blocker-only); only `nitpick` shows everything.
  // This locks in that deliberate behavior so it can't silently drift, and matches the clarified doc in
  // .loopover.yml.example. (Resolves the 4-tier-doc-vs-2-tier-behavior mismatch in the doc direction.)
  it("treats critical/major/minor min-severity floors as equivalent for inline findings — only nitpick differs (#6802)", () => {
    for (const inline of ["blocker", "nit"] as const) {
      const atCritical = shouldShowInlineFinding(inline, "critical");
      expect(shouldShowInlineFinding(inline, "major")).toBe(atCritical);
      expect(shouldShowInlineFinding(inline, "minor")).toBe(atCritical);
    }
    // A blocker renders at every floor; a nit is hidden by critical/major/minor alike and shown only by nitpick.
    for (const floor of ["critical", "major", "minor", "nitpick"] as const) {
      expect(shouldShowInlineFinding("blocker", floor)).toBe(true);
    }
    expect(shouldShowInlineFinding("nit", "critical")).toBe(false);
    expect(shouldShowInlineFinding("nit", "major")).toBe(false);
    expect(shouldShowInlineFinding("nit", "minor")).toBe(false);
    expect(shouldShowInlineFinding("nit", "nitpick")).toBe(true);
  });
});
