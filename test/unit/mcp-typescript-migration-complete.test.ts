import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mcpRoot = join(process.cwd(), "packages/loopover-mcp");
const dirs = ["bin", "lib"] as const;

function listBasenames(dir: string, predicate: (name: string) => boolean): string[] {
  return readdirSync(join(mcpRoot, dir))
    .filter(predicate)
    .map((name) => name.replace(/\.(?:d\.ts|ts|js)$/, ""))
    .sort();
}

/**
 * #7291 closing guard for the phased #7328/#7329/#7330 mcp TypeScript migration -- the loopover-mcp
 * twin of loopover-miner's own #7290/#7317 guard in test/unit/miner-typescript-migration-complete.test.ts.
 * Every runtime file under packages/loopover-mcp/{bin,lib} must be compiler-owned (.ts source -> emitted
 * .js). A lone hand-maintained .js is the drift gap the migration was filed to close.
 */
describe("loopover-mcp TypeScript migration complete (#7291)", () => {
  it("has zero hand-maintained .js orphans — every basename has a real .ts source", () => {
    for (const dir of dirs) {
      const sources = new Set(listBasenames(dir, (name) => name.endsWith(".ts") && !name.endsWith(".d.ts")));
      const scripts = listBasenames(dir, (name) => name.endsWith(".js"));

      const jsWithoutTs = scripts.filter((base) => !sources.has(base));

      expect(jsWithoutTs, `${dir}/ .js without sibling .ts`).toEqual([]);
      expect(scripts).toEqual([...sources].sort());
    }
  });

  // Unlike loopover-miner, packages/loopover-mcp/tsconfig.json sets declaration: false (no pre-existing
  // hand-written .d.ts files to replace when the mcp migration started) -- so a .d.ts appearing here at
  // all, not just an orphaned one, means either that tsconfig setting or this guard has drifted.
  it("emits no .d.ts (declaration: false in packages/loopover-mcp/tsconfig.json)", () => {
    for (const dir of dirs) {
      const declarations = readdirSync(join(mcpRoot, dir)).filter((name) => name.endsWith(".d.ts"));
      expect(declarations, `${dir}/ unexpected .d.ts`).toEqual([]);
    }
  });
});
