import { describe, expect, it } from "vitest";
import {
  addedLinesByPath,
  addedLinesFromPatch,
  anchoredSuggestionBlock,
  isSuggestionAnchorable,
  safeSuggestionBlock,
} from "../../src/review/inline-suggestion-anchor";
import type { InlineFinding } from "../../src/services/ai-review";

const mixedPatch = "@@ -1,3 +1,4 @@\n ctx1\n-removed\n+added2\n ctx4";

describe("addedLinesFromPatch (#2140)", () => {
  it("returns only ADDED (+) RIGHT-side lines, not context lines", () => {
    expect([...addedLinesFromPatch(mixedPatch)].sort((a, b) => a - b)).toEqual([2]);
    expect([...addedLinesFromPatch("@@ -1,0 +1,2 @@\n+only-added\n+second")].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("returns an empty set for patches with no hunks", () => {
    expect(addedLinesFromPatch("").size).toBe(0);
    expect(addedLinesFromPatch("preamble only").size).toBe(0);
  });
});

describe("addedLinesByPath + isSuggestionAnchorable (#2140)", () => {
  const files = [{ path: "src/a.ts", payload: { patch: mixedPatch } }];

  it("treats added lines as suggestion-anchorable and context lines as not", () => {
    const addedLines = addedLinesByPath(files);
    expect(isSuggestionAnchorable({ path: "src/a.ts", line: 2 }, addedLines)).toBe(true);
    expect(isSuggestionAnchorable({ path: "src/a.ts", line: 1 }, addedLines)).toBe(false);
    expect(isSuggestionAnchorable({ path: "src/missing.ts", line: 1 }, addedLines)).toBe(false);
  });

  it("omits files with empty or non-string patches", () => {
    const addedLines = addedLinesByPath([
      { path: "src/empty.ts", payload: { patch: "" } },
      { path: "src/bad.ts", payload: { patch: 42 as unknown as string } },
    ]);
    expect(addedLines.size).toBe(0);
  });
});

describe("anchoredSuggestionBlock (#2140)", () => {
  const files = [{ path: "src/a.ts", payload: { patch: mixedPatch } }];
  const addedLines = addedLinesByPath(files);
  const withSuggestion: InlineFinding = {
    path: "src/a.ts",
    line: 2,
    severity: "nit",
    body: "Use const.",
    suggestion: "const x = 1;",
  };

  it("keeps the suggestion on an added line", () => {
    expect(anchoredSuggestionBlock(withSuggestion, true, addedLines)).toContain("```suggestion");
  });

  it("drops the suggestion on a context line but leaves the caller to keep the finding text", () => {
    expect(anchoredSuggestionBlock({ ...withSuggestion, line: 1 }, true, addedLines)).toBe("");
  });

  it("keeps a multi-line suggestion when every line in the range is added (#2141)", () => {
    const multiAdded = addedLinesByPath([{ path: "src/a.ts", payload: { patch: "@@ -1,0 +1,2 @@\n+one\n+two" } }]);
    expect(
      anchoredSuggestionBlock(
        { ...withSuggestion, line: 1, endLine: 2, suggestion: "one\ntwo" },
        true,
        multiAdded,
      ),
    ).toContain("```suggestion");
  });

  it("drops a multi-line suggestion when any line in the range is context (#2141)", () => {
    expect(
      anchoredSuggestionBlock(
        { ...withSuggestion, line: 1, endLine: 2, suggestion: "ctx\nadd" },
        true,
        addedLines,
      ),
    ).toBe("");
  });

  it("drops unsafe suggestion fences even on an added line", () => {
    expect(
      anchoredSuggestionBlock({ ...withSuggestion, suggestion: "```\nescape\n```" }, true, addedLines),
    ).toBe("");
    expect(safeSuggestionBlock(undefined)).toBe("");
  });
});
