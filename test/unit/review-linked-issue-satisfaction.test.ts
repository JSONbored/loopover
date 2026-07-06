import { describe, expect, it } from "vitest";
import { parseFocusManifest, reviewConfigToJson } from "../../src/signals/focus-manifest";

const reviewOf = (linkedIssueSatisfaction: unknown) =>
  parseFocusManifest({ review: { linkedIssueSatisfaction } });

describe("review.linkedIssueSatisfaction config knob (#2173)", () => {
  it("absent ⇒ null and OMITTED on serialize (byte-identical to today)", () => {
    const review = parseFocusManifest({ review: { note: "x" } }).review;
    expect(review.linkedIssueSatisfaction).toBe(null);
    expect("linkedIssueSatisfaction" in (reviewConfigToJson(review) as Record<string, unknown>)).toBe(false);
  });

  it("each valid mode parses, marks present, and round-trips", () => {
    for (const mode of ["off", "advisory", "block"] as const) {
      const review = reviewOf(mode).review;
      expect(review.linkedIssueSatisfaction).toBe(mode);
      expect(review.present).toBe(true);
      const json = reviewConfigToJson(review) as Record<string, unknown>;
      expect(json.linkedIssueSatisfaction).toBe(mode);
      expect(parseFocusManifest({ review: json }).review.linkedIssueSatisfaction).toBe(mode);
    }
  });

  it("a malformed value warns and falls back to null (ignored)", () => {
    const m = reviewOf("sometimes");
    expect(m.review.linkedIssueSatisfaction).toBe(null);
    expect(m.review.present).toBe(false);
    expect(m.warnings.some((w) => /review\.linkedIssueSatisfaction/.test(w))).toBe(true);
  });

  it("a non-string value is also rejected with a warning", () => {
    const m = reviewOf(true);
    expect(m.review.linkedIssueSatisfaction).toBe(null);
    expect(m.warnings.some((w) => /review\.linkedIssueSatisfaction/.test(w))).toBe(true);
  });
});
