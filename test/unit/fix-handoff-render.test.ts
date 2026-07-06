import { describe, expect, it } from "vitest";
import { buildFixHandoffBlock, buildFixHandoffBlocks } from "../../src/review/fix-handoff-render";
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
    expect(block.body).toContain("<!-- gittensory:fix-handoff -->");
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
