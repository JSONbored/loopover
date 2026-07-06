import { describe, expect, it } from "vitest";
import { tallyFindingCategories, renderUnifiedReviewComment, type UnifiedReviewInput } from "../../src/review/unified-comment";

const baseInput: UnifiedReviewInput = {
  changedFiles: 1,
  reviewerCount: 1,
  recommendations: ["merge"],
  summary: "Looks good.",
};

describe("tallyFindingCategories (#2150)", () => {
  it("tallies by category, ordered by count desc then category name asc", () => {
    expect(
      tallyFindingCategories([
        { category: "style" },
        { category: "correctness" },
        { category: "security" },
        { category: "correctness" },
        { category: "security" },
        { category: "correctness" },
      ]),
    ).toEqual([
      { category: "correctness", count: 3 },
      { category: "security", count: 2 },
      { category: "style", count: 1 },
    ]);
  });

  it("breaks a count tie alphabetically by category name", () => {
    expect(tallyFindingCategories([{ category: "tests" }, { category: "performance" }])).toEqual([
      { category: "performance", count: 1 },
      { category: "tests", count: 1 },
    ]);
  });

  it("ignores uncategorized findings; all-uncategorized ⇒ empty", () => {
    expect(tallyFindingCategories([{ category: "security" }, {}, { category: undefined }])).toEqual([
      { category: "security", count: 1 },
    ]);
    expect(tallyFindingCategories([{}, { category: undefined }])).toEqual([]);
    expect(tallyFindingCategories([])).toEqual([]);
  });
});

describe("renderUnifiedReviewComment category breakdown line (#2150)", () => {
  it("renders the one-line tally when categorized findings are present", () => {
    const out = renderUnifiedReviewComment({
      ...baseInput,
      inlineFindings: [{ category: "correctness" }, { category: "correctness" }, { category: "security" }],
    });
    expect(out).toContain("**Findings by category:** 2 correctness · 1 security");
  });

  it("omits the line entirely when no finding is categorized (byte-identical to absent)", () => {
    const withEmpty = renderUnifiedReviewComment({ ...baseInput, inlineFindings: [{}, { category: undefined }] });
    const withAbsent = renderUnifiedReviewComment(baseInput);
    expect(withEmpty).not.toContain("Findings by category");
    expect(withEmpty).toBe(withAbsent); // byte-identical
  });
});
