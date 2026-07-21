import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #7806 — console.error sinks must not stamp level:"warn" (Sentry severity follows the explicit
// level field over the sink default). Keep the three queue files consistent with the rest of
// their console.error call sites.
const QUEUE_FILES = [
  "src/queue/processors.ts",
  "src/queue/slop-detection.ts",
  "src/queue/ai-review-orchestration.ts",
] as const;

function consoleErrorBlocks(source: string): string[] {
  const blocks: string[] = [];
  let i = 0;
  while (true) {
    const start = source.indexOf("console.error(", i);
    if (start < 0) break;
    let k = start + "console.error(".length;
    let depth = 1;
    while (k < source.length && depth > 0) {
      const ch = source[k]!;
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        k += 1;
        while (k < source.length) {
          if (source[k] === "\\") {
            k += 2;
            continue;
          }
          if (source[k] === quote) break;
          k += 1;
        }
      }
      k += 1;
    }
    blocks.push(source.slice(start, k));
    i = k;
  }
  return blocks;
}

describe("queue console.error level matches the error sink (#7806)", () => {
  it("never stamps level:\"warn\" inside console.error payloads in the queue pipeline", () => {
    const mismatches: string[] = [];
    for (const rel of QUEUE_FILES) {
      const source = readFileSync(join(process.cwd(), rel), "utf8");
      for (const block of consoleErrorBlocks(source)) {
        if (block.includes('level: "warn"') || block.includes("level: 'warn'")) {
          mismatches.push(rel);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("keeps at least one representative console.error payload at level:\"error\"", () => {
    const source = readFileSync(join(process.cwd(), "src/queue/slop-detection.ts"), "utf8");
    expect(source).toMatch(/console\.error\(\s*JSON\.stringify\(\s*\{\s*level:\s*"error"/);
    expect(source).toContain('event: "ai_slop_failed"');
  });
});
