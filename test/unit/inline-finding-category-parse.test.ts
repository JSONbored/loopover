import { describe, expect, it } from "vitest";
import { FINDING_CATEGORIES } from "../../src/review/finding-category-classify";
import {
  DEFAULT_INLINE_FINDING_CATEGORY,
  parseInlineFindingCategory,
} from "../../src/review/inline-finding-category-parse";

describe("inline-finding-category-parse", () => {
  it("keeps every fixed enum literal verbatim", () => {
    for (const category of FINDING_CATEGORIES) {
      expect(parseInlineFindingCategory(category)).toBe(category);
    }
  });

  it("defaults unknown, absent, and non-string values to maintainability (#2147)", () => {
    expect(parseInlineFindingCategory(undefined)).toBe(DEFAULT_INLINE_FINDING_CATEGORY);
    expect(parseInlineFindingCategory(null)).toBe(DEFAULT_INLINE_FINDING_CATEGORY);
    expect(parseInlineFindingCategory("readability")).toBe(DEFAULT_INLINE_FINDING_CATEGORY);
    expect(parseInlineFindingCategory("Security")).toBe(DEFAULT_INLINE_FINDING_CATEGORY);
    expect(parseInlineFindingCategory(42)).toBe(DEFAULT_INLINE_FINDING_CATEGORY);
    expect(parseInlineFindingCategory({})).toBe(DEFAULT_INLINE_FINDING_CATEGORY);
  });
});
