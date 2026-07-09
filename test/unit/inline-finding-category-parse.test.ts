import { describe, expect, it } from "vitest";
import { FINDING_CATEGORIES } from "../../src/review/finding-category-classify";
import { parseInlineFindingCategory } from "../../src/review/inline-finding-category-parse";

describe("inline-finding-category-parse", () => {
  it("keeps every fixed enum literal verbatim", () => {
    for (const category of FINDING_CATEGORIES) {
      expect(parseInlineFindingCategory(category)).toBe(category);
    }
  });

  it("leaves unknown, absent, and non-string values uncategorized for fallback classification (#2147)", () => {
    expect(parseInlineFindingCategory(undefined)).toBeUndefined();
    expect(parseInlineFindingCategory(null)).toBeUndefined();
    expect(parseInlineFindingCategory("readability")).toBeUndefined();
    expect(parseInlineFindingCategory("Security")).toBeUndefined();
    expect(parseInlineFindingCategory(42)).toBeUndefined();
    expect(parseInlineFindingCategory({})).toBeUndefined();
  });
});
