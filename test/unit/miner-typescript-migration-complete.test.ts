import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const minerRoot = join(process.cwd(), "packages/loopover-miner");
const dirs = ["bin", "lib"] as const;

function listBasenames(dir: string, predicate: (name: string) => boolean): string[] {
  return readdirSync(join(minerRoot, dir))
    .filter(predicate)
    .map((name) => name.replace(/\.(?:d\.ts|ts|js)$/, ""))
    .sort();
}

/**
 * #7317 closing guard for the #7290 miner TypeScript migration: every runtime file under
 * packages/loopover-miner/{bin,lib} must be compiler-owned (.ts source → emitted .js + .d.ts).
 * A lone hand-maintained .js/.d.ts pair is the drift gap the migration was filed to close.
 */
describe("loopover-miner TypeScript migration complete (#7317)", () => {
  it("has zero hand-maintained .js/.d.ts orphans — every basename has a real .ts source", () => {
    for (const dir of dirs) {
      const sources = new Set(listBasenames(dir, (name) => name.endsWith(".ts") && !name.endsWith(".d.ts")));
      const scripts = listBasenames(dir, (name) => name.endsWith(".js"));
      const declarations = listBasenames(dir, (name) => name.endsWith(".d.ts"));

      const jsWithoutTs = scripts.filter((base) => !sources.has(base));
      const dtsWithoutTs = declarations.filter((base) => !sources.has(base));

      expect(jsWithoutTs, `${dir}/ .js without sibling .ts`).toEqual([]);
      expect(dtsWithoutTs, `${dir}/ .d.ts without sibling .ts`).toEqual([]);
      // Emitted declarations track sources 1:1 (tsc declaration:true in-place emit).
      expect(declarations).toEqual([...sources].sort());
      expect(scripts).toEqual([...sources].sort());
    }
  });
});
