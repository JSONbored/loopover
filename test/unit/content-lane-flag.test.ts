import { describe, expect, it } from "vitest";
import { isContentLaneEnabled } from "../../src/review/content-lane/flag";

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
