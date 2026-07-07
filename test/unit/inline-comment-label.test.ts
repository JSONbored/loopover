import { describe, expect, it } from "vitest";
import { formatInlineCommentSeverityLabel, titleCaseFindingCategory } from "../../src/review/inline-comment-label";
import type { InlineFinding } from "../../src/services/ai-review";

describe("titleCaseFindingCategory (#2149)", () => {
  it("title-cases every fixed finding-category enum literal", () => {
    expect(titleCaseFindingCategory("security")).toBe("Security");
    expect(titleCaseFindingCategory("correctness")).toBe("Correctness");
    expect(titleCaseFindingCategory("style")).toBe("Style");
  });
});

describe("formatInlineCommentSeverityLabel (#2149)", () => {
  const blocker: InlineFinding = { path: "src/a.ts", line: 1, severity: "blocker", body: "x", category: "security" };
  const nit: InlineFinding = { path: "src/a.ts", line: 1, severity: "nit", body: "x", category: "style" };

  it("returns severity-only labels when categories are disabled", () => {
    expect(formatInlineCommentSeverityLabel(blocker, false)).toBe("Blocker");
    expect(formatInlineCommentSeverityLabel(nit, false)).toBe("Nit");
  });

  it("renders blocker and nit labels with a title-cased category when enabled", () => {
    expect(formatInlineCommentSeverityLabel(blocker, true)).toBe("Blocker · Security");
    expect(formatInlineCommentSeverityLabel(nit, true)).toBe("Nit · Style");
  });

  it("falls back to the deterministic classifier when the finding omits category", () => {
    const uncategorized: InlineFinding = { path: "src/app.test.ts", line: 1, severity: "nit", body: "Use const." };
    expect(formatInlineCommentSeverityLabel(uncategorized, true)).toBe("Nit · Tests");
  });
});
