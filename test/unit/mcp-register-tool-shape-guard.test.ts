import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ACTION_CLASSES, AUTONOMY_LEVELS, MAINTAIN_ACTION_CLASSES, PROPOSE_ACTION_CLASSES } from "@loopover/contract";
import { AGENT_ACTION_CLASSES as ENGINE_ACTION_CLASSES } from "../../packages/loopover-engine/src/settings/autonomy";
import { AUTONOMY_LEVELS as ENGINE_AUTONOMY_LEVELS } from "../../packages/loopover-engine/src/settings/autonomy";

// #9762: the two things that kept #9515's premise -- nothing written down twice -- from being true.
//
// The first is a trap rather than a bug. The MCP SDK's registerTool accepts either a ZodObject or a raw
// `.shape`, and re-wraps a raw shape in a plain `z.object` that DISCARDS the catchall. A `looseObject`
// output therefore gets advertised and enforced as `additionalProperties: false`, and every field the
// payload carries beyond the modelled set becomes a -32602 the caller cannot do anything about -- #9518's
// defect class, found the hard way. 23 call sites passed `.shape`; none of their inputs was loose, which is
// exactly what made them indistinguishable from the correct ones by reading.
//
// The second is the pinned restatements. A contract constant that merely MIRRORS an engine list is safe
// only while something fails when the two diverge.

/** Every `.ts` under a root, so the guard cannot be dodged by adding a new server file. */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!/node_modules|dist/.test(path)) walk(path);
      } else if (path.endsWith(".ts")) found.push(path);
    }
  };
  walk(root);
  return found;
}

const SERVER_ROOTS = ["src/mcp", "packages/loopover-mcp/bin", "packages/loopover-mcp/lib", "packages/loopover-miner/lib"];

describe("no registerTool call hands the SDK a raw shape (#9762)", () => {
  const offenders = SERVER_ROOTS.flatMap((root) =>
    sourceFiles(root).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ file, line: index + 1, text: line }))
        // The pure form only. `{ ...X.shape, extra }` genuinely COMPOSES a new shape and is not this defect.
        .filter(({ text }) => /\b(?:input|output)Schema:\s*[A-Za-z0-9_]+\.shape\b/.test(text))
        .map(({ file, line, text }) => `${file}:${line} ${text.trim()}`),
    ),
  );

  it("finds none", () => {
    expect(offenders).toEqual([]);
  });

  it("would catch one if it came back", () => {
    // The guard's own regex, proven against the exact line shape it exists to reject -- otherwise a future
    // refactor could silently make the pattern unmatchable and this suite would go quiet.
    const pattern = /\b(?:input|output)Schema:\s*[A-Za-z0-9_]+\.shape\b/;
    expect(pattern.test("        inputSchema: AdminDoctorInput.shape,")).toBe(true);
    expect(pattern.test("        outputSchema: AdminDoctorOutput.shape,")).toBe(true);
    // A composed shape is legitimate and must NOT be flagged.
    expect(pattern.test("        argsSchema: { ...GetAutomationStateInput.shape, login: z.string() },")).toBe(false);
    expect(pattern.test("        inputSchema: AdminDoctorInput,")).toBe(false);
  });
});

describe("the contract's restated action-class lists still match the engine's (#9762)", () => {
  it("AGENT_ACTION_CLASSES is the engine's list exactly, order included", () => {
    expect([...AGENT_ACTION_CLASSES]).toEqual([...ENGINE_ACTION_CLASSES]);
  });

  it("AUTONOMY_LEVELS is the engine's list exactly", () => {
    expect([...AUTONOMY_LEVELS]).toEqual([...ENGINE_AUTONOMY_LEVELS]);
  });

  it("MAINTAIN_ACTION_CLASSES stays a strict SUBSET — it is deliberately not the engine's full list", () => {
    // Named because "sync it to the engine" is the obvious wrong fix: the maintain dial exposes only the
    // operator-settable classes, and widening it would offer an operator switches the surface cannot honor.
    for (const cls of MAINTAIN_ACTION_CLASSES) expect(ENGINE_ACTION_CLASSES).toContain(cls);
    expect(MAINTAIN_ACTION_CLASSES.length).toBeLessThan(ENGINE_ACTION_CLASSES.length);
  });

  it("PROPOSE_ACTION_CLASSES is the maintain subset plus review_state_label, and nothing else", () => {
    expect([...PROPOSE_ACTION_CLASSES]).toEqual([...MAINTAIN_ACTION_CLASSES, "review_state_label"]);
  });
});

describe("the stdio bin no longer hand-syncs what the contract exports (#9762)", () => {
  const bin = readFileSync("packages/loopover-mcp/bin/loopover-mcp.ts", "utf8");

  it("declares no literal copy of the autonomy or action-class lists", () => {
    expect(bin).not.toContain('["observe", "auto_with_approval", "auto"]');
    expect(bin).not.toContain('["review", "request_changes", "approve", "merge", "close", "label"]');
  });

  it("dropped the stale comment that said they could not be imported", () => {
    // It cited #6153: the bin resolves @loopover/engine through the published package, whose export map
    // does not surface AUTONOMY_LEVELS. True of the engine, never true of the contract -- which this file
    // already imports. A load-bearing comment that is no longer true is worse than no comment.
    expect(bin).not.toContain("hand-synced literals, not imports");
  });
});
