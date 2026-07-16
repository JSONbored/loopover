import { describe, expect, it } from "vitest";
import { buildFixHandoffAggregateBlock, buildFixHandoffBlock, buildFixHandoffBlocks } from "../../src/review/fix-handoff-render";
import { LOCAL_WRITE_BOUNDARY } from "../../src/mcp/local-write-tools";
import type { InlineFinding } from "../../src/services/ai-review";

function finding(over: Partial<InlineFinding> = {}): InlineFinding {
  return { path: "src/a.ts", line: 12, severity: "blocker", body: "Null check missing before dereference.", ...over };
}

describe("buildFixHandoffBlock (#2175)", () => {
  it("renders a path:line location and blocker label", () => {
    const block = buildFixHandoffBlock(finding({ line: 12, severity: "blocker" }));
    expect(block).toMatchObject({ path: "src/a.ts", line: 12, severity: "blocker", instruction: "Null check missing before dereference." });
    expect(block.body).toContain("src/a.ts:12");
    expect(block.body).toContain("**Fix handoff — Blocker at `src/a.ts:12`**");
  });

  it("renders a nit label", () => {
    const block = buildFixHandoffBlock(finding({ severity: "nit" }));
    expect(block.body).toContain("Nit at");
  });

  it("includes the suggestedChange fenced block when present", () => {
    const block = buildFixHandoffBlock(finding({ suggestion: "if (!value) return null;" }));
    expect(block.suggestedChange).toBe("if (!value) return null;");
    expect(block.body).toContain("Suggested change:");
    expect(block.body).toContain("```\nif (!value) return null;\n```");
  });

  it("omits suggestedChange entirely when absent", () => {
    const block = buildFixHandoffBlock(finding());
    expect(block.suggestedChange).toBeUndefined();
    expect(block.body).not.toContain("Suggested change:");
  });

  it("omits suggestedChange when the suggestion is whitespace-only", () => {
    const block = buildFixHandoffBlock(finding({ suggestion: "   " }));
    expect(block.suggestedChange).toBeUndefined();
    expect(block.body).not.toContain("Suggested change:");
  });

  it("skips the fenced block when the suggestion itself contains a ``` sequence (#6632)", () => {
    const block = buildFixHandoffBlock(finding({ suggestion: "Replace with:\n```\nconst x = 1;\n```" }));
    // The embedded fence would close the outer block early, so the fenced rendering is skipped entirely
    // (matching safeSuggestionBlock); no stray ``` leaks into the rendered markdown.
    expect(block.body).not.toContain("Suggested change:");
    expect(block.body).not.toContain("```");
  });

  it("yields a path-only block (line 0) when the finding has no commentable line (line <= 0)", () => {
    const block = buildFixHandoffBlock(finding({ line: 0 }));
    expect(block.line).toBe(0);
    expect(block.body).toContain("src/a.ts (no specific line)");
    expect(block.body).not.toContain("src/a.ts:0");
  });

  it("yields a path-only block when line is negative or non-finite (defensive)", () => {
    expect(buildFixHandoffBlock(finding({ line: -1 })).line).toBe(0);
    expect(buildFixHandoffBlock(finding({ line: Number.NaN })).line).toBe(0);
    expect(buildFixHandoffBlock(finding({ line: 1.5 })).line).toBe(0); // non-integer isn't a valid diff line either
  });

  it("always includes the exact LOCAL_WRITE_BOUNDARY text (boundary-safe)", () => {
    const block = buildFixHandoffBlock(finding());
    expect(block.boundary).toBe(LOCAL_WRITE_BOUNDARY);
    expect(block.body).toContain(LOCAL_WRITE_BOUNDARY);
  });

  it("includes the fix-handoff HTML comment marker so a harness can locate the block", () => {
    const block = buildFixHandoffBlock(finding());
    expect(block.body).toContain("<!-- loopover:fix-handoff -->");
  });

  it("carries the finding's body as the instruction verbatim (already public-safe upstream)", () => {
    const block = buildFixHandoffBlock(finding({ body: "Add a guard for the empty-array case." }));
    expect(block.instruction).toBe("Add a guard for the empty-array case.");
    expect(block.body).toContain("Add a guard for the empty-array case.");
  });
});

describe("buildFixHandoffBlocks (#2175)", () => {
  it("maps every finding in order", () => {
    const blocks = buildFixHandoffBlocks([finding({ path: "a.ts", line: 1 }), finding({ path: "b.ts", line: 2, severity: "nit" })]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.path).toBe("a.ts");
    expect(blocks[1]?.path).toBe("b.ts");
    expect(blocks[1]?.severity).toBe("nit");
  });

  it("returns an empty array for no findings (no-op)", () => {
    expect(buildFixHandoffBlocks([])).toEqual([]);
  });
});

describe("buildFixHandoffAggregateBlock (#5102)", () => {
  it("returns null for no findings (no-op)", () => {
    expect(buildFixHandoffAggregateBlock([])).toBeNull();
  });

  it("combines a single finding into one block with singular wording", () => {
    const block = buildFixHandoffAggregateBlock([finding()]);
    expect(block?.findingCount).toBe(1);
    expect(block?.body).toContain("**Fix handoff — 1 finding across this PR**");
    expect(block?.body).toContain("1. **Blocker at `src/a.ts:12`** — Null check missing before dereference.");
  });

  it("combines multiple findings into one numbered block with plural wording", () => {
    const block = buildFixHandoffAggregateBlock([
      finding({ path: "a.ts", line: 1, severity: "blocker" }),
      finding({ path: "b.ts", line: 2, severity: "nit" }),
    ]);
    expect(block?.findingCount).toBe(2);
    expect(block?.body).toContain("**Fix handoff — 2 findings across this PR**");
    expect(block?.body).toContain("1. **Blocker at `a.ts:1`**");
    expect(block?.body).toContain("2. **Nit at `b.ts:2`**");
  });

  it("renders a path-only location when a finding has no commentable line", () => {
    const block = buildFixHandoffAggregateBlock([finding({ line: 0 })]);
    expect(block?.body).toContain("src/a.ts (no specific line)");
    expect(block?.body).not.toContain("src/a.ts:0");
  });

  it("includes a fenced suggestion block, indented under its list item, when present", () => {
    const block = buildFixHandoffAggregateBlock([finding({ suggestion: "if (!value) return null;" })]);
    expect(block?.body).toContain("```\n   if (!value) return null;\n   ```");
  });

  it("omits the suggestion block entirely when absent or whitespace-only", () => {
    expect(buildFixHandoffAggregateBlock([finding()])?.body).not.toContain("```");
    expect(buildFixHandoffAggregateBlock([finding({ suggestion: "   " })])?.body).not.toContain("```");
  });

  it("skips the fenced suggestion block when the suggestion contains a ``` sequence (#6632)", () => {
    const block = buildFixHandoffAggregateBlock([finding({ suggestion: "```\nconst x = 1;\n```" })]);
    expect(block?.body).not.toContain("```"); // embedded fence would break the item's block; skipped entirely
  });

  it("always includes the exact LOCAL_WRITE_BOUNDARY text (boundary-safe)", () => {
    const block = buildFixHandoffAggregateBlock([finding()]);
    expect(block?.boundary).toBe(LOCAL_WRITE_BOUNDARY);
    expect(block?.body).toContain(LOCAL_WRITE_BOUNDARY);
  });

  it("includes the aggregate HTML comment marker, distinct from the per-finding marker", () => {
    const block = buildFixHandoffAggregateBlock([finding()]);
    expect(block?.body).toContain("<!-- loopover:fix-handoff-aggregate -->");
    expect(block?.body).not.toContain("<!-- loopover:fix-handoff -->");
  });
});
