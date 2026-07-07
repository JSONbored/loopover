import { describe, expect, it } from "vitest";
import {
  everyLineInSet,
  parseInlineLineRange,
  resolveInlineCommentAnchor,
  rightLinesByPath,
} from "../../src/review/inline-comment-range";

const multiPatch = "@@ -1,0 +1,3 @@\n+one\n+two\n+three";
const mixedPatch = "@@ -1,2 +1,4 @@\n ctx\n+add2\n ctx4\n+add4";

describe("parseInlineLineRange (#2141)", () => {
  it("collapses absent, equal, or inverted endLine to a single-line range", () => {
    expect(parseInlineLineRange({ line: 2 })).toEqual({ start: 2, end: 2 });
    expect(parseInlineLineRange({ line: 2, endLine: 2 })).toEqual({ start: 2, end: 2 });
    expect(parseInlineLineRange({ line: 5, endLine: 3 })).toEqual({ start: 5, end: 5 });
  });

  it("keeps a valid forward range", () => {
    expect(parseInlineLineRange({ line: 1, endLine: 3 })).toEqual({ start: 1, end: 3 });
  });
});

describe("everyLineInSet (#2141)", () => {
  it("requires every line in the inclusive range", () => {
    const lines = new Set([1, 2, 3]);
    expect(everyLineInSet(1, 3, lines)).toBe(true);
    expect(everyLineInSet(1, 4, lines)).toBe(false);
  });
});

describe("resolveInlineCommentAnchor (#2141)", () => {
  const files = [{ path: "src/a.ts", payload: { patch: multiPatch } }];

  it("emits a multi-line anchor when every line in the range is commentable", () => {
    const rightLines = rightLinesByPath(files);
    expect(resolveInlineCommentAnchor({ path: "src/a.ts", line: 1, endLine: 3 }, rightLines)).toEqual({
      start: 1,
      end: 3,
      multiLine: true,
    });
  });

  it("downgrades to the start line when any line in the range is not commentable", () => {
    const rightLines = rightLinesByPath([{ path: "src/a.ts", payload: { patch: mixedPatch } }]);
    expect(resolveInlineCommentAnchor({ path: "src/a.ts", line: 2, endLine: 99 }, rightLines)).toEqual({
      start: 2,
      end: 2,
      multiLine: false,
    });
  });
});
