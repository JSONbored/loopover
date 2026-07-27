import { describe, expect, it } from "vitest";
import { isContentLaneEnabled, isSurfaceVerificationEnabled } from "../../src/review/content-lane/flag";

describe("isContentLaneEnabled", () => {
  it("is OFF by default (unset / empty / undefined env)", () => {
    expect(isContentLaneEnabled(undefined)).toBe(false);
    expect(isContentLaneEnabled(null)).toBe(false);
    expect(isContentLaneEnabled({})).toBe(false);
    expect(isContentLaneEnabled({ LOOPOVER_REVIEW_CONTENT_LANE: "" })).toBe(false);
  });

  it("is ON for recognized truthy values (case/whitespace insensitive)", () => {
    for (const v of ["1", "true", "on", "yes", "TRUE", " On ", "Yes"]) {
      expect(isContentLaneEnabled({ LOOPOVER_REVIEW_CONTENT_LANE: v })).toBe(true);
    }
  });

  it("is OFF for non-truthy strings", () => {
    for (const v of ["0", "false", "off", "no", "enabled", "maybe"]) {
      expect(isContentLaneEnabled({ LOOPOVER_REVIEW_CONTENT_LANE: v })).toBe(false);
    }
  });
});

// #8908/#8909: live surface verification is its OWN flag, independent of the lane's, so the first
// outbound-probe behavior in this lane can be rolled back without taking the whole lane down.
describe("isSurfaceVerificationEnabled", () => {
  it("is OFF by default (unset / empty / undefined env)", () => {
    expect(isSurfaceVerificationEnabled(undefined)).toBe(false);
    expect(isSurfaceVerificationEnabled(null)).toBe(false);
    expect(isSurfaceVerificationEnabled({})).toBe(false);
    expect(isSurfaceVerificationEnabled({ LOOPOVER_REVIEW_SURFACE_VERIFICATION: "" })).toBe(false);
  });

  it("is ON for recognized truthy values (case/whitespace insensitive)", () => {
    for (const v of ["1", "true", "on", "yes", "TRUE", " On ", "Yes"]) {
      expect(isSurfaceVerificationEnabled({ LOOPOVER_REVIEW_SURFACE_VERIFICATION: v })).toBe(true);
    }
  });

  it("is OFF for non-truthy strings", () => {
    for (const v of ["0", "false", "off", "no", "enabled", "maybe"]) {
      expect(isSurfaceVerificationEnabled({ LOOPOVER_REVIEW_SURFACE_VERIFICATION: v })).toBe(false);
    }
  });

  it("is independent of the content-lane flag in BOTH directions", () => {
    expect(isSurfaceVerificationEnabled({ LOOPOVER_REVIEW_CONTENT_LANE: "true" })).toBe(false);
    expect(isContentLaneEnabled({ LOOPOVER_REVIEW_SURFACE_VERIFICATION: "true" })).toBe(false);
  });
});
