import { describe, expect, it } from "vitest";
import type { InlineFinding } from "../../src/services/ai-review";
import {
  compareInlineFindingPriority,
  inlineFindingCategory,
  selectAnchoredInlineFindings,
} from "../../src/review/inline-comments-select";

const fileWith = (path: string, patch: string) => ({ path, payload: { patch } });
const files = [fileWith("src/a.ts", "@@ -1,0 +1,6 @@\n+1\n+2\n+3\n+4\n+5\n+6")];

describe("compareInlineFindingPriority (#2159)", () => {
  it("ranks blockers ahead of nits and security ahead of style", () => {
    const securityBlocker: InlineFinding = { path: "src/a.ts", line: 1, severity: "blocker", body: "x", category: "security" };
    const styleNit: InlineFinding = { path: "src/a.ts", line: 2, severity: "nit", body: "y", category: "style" };
    expect(compareInlineFindingPriority(securityBlocker, styleNit)).toBeLessThan(0);
    expect(compareInlineFindingPriority(styleNit, securityBlocker)).toBeGreaterThan(0);
  });
});

describe("selectAnchoredInlineFindings (#2159)", () => {
  it("preserves first-seen order when perCategoryCap is unset", () => {
    const findings: InlineFinding[] = [
      { path: "src/a.ts", line: 1, severity: "nit", body: "first", category: "style" },
      { path: "src/a.ts", line: 2, severity: "blocker", body: "second", category: "security" },
      { path: "src/a.ts", line: 3, severity: "nit", body: "third", category: "style" },
    ];
    expect(selectAnchoredInlineFindings(findings, files).map((f) => f.body)).toEqual(["first", "second", "third"]);
  });

  it("trims overflowing categories and keeps higher-priority findings when perCategoryCap is set", () => {
    const findings: InlineFinding[] = [
      { path: "src/a.ts", line: 1, severity: "nit", body: "style-1", category: "style" },
      { path: "src/a.ts", line: 2, severity: "nit", body: "style-2", category: "style" },
      { path: "src/a.ts", line: 3, severity: "nit", body: "style-3", category: "style" },
      { path: "src/a.ts", line: 4, severity: "blocker", body: "security", category: "security" },
      { path: "src/a.ts", line: 5, severity: "nit", body: "style-4", category: "style" },
    ];
    const selected = selectAnchoredInlineFindings(findings, files, { perCategoryCap: 2, maxComments: 10 });
    expect(selected.map((f) => f.body)).toEqual(["security", "style-1", "style-2"]);
    expect(selected.filter((f) => inlineFindingCategory(f) === "style")).toHaveLength(2);
  });

  it("still enforces the total cap after per-category trimming", () => {
    const findings: InlineFinding[] = Array.from({ length: 6 }, (_, index) => ({
      path: "src/a.ts",
      line: index + 1,
      severity: "nit" as const,
      body: `body-${index + 1}`,
      category: "style" as const,
    }));
    expect(selectAnchoredInlineFindings(findings, files, { perCategoryCap: 5, maxComments: 3 })).toHaveLength(3);
  });
});
