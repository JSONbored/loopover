import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CI_PATH = join(process.cwd(), ".github/workflows/ci.yml");

describe("CI engine/miner path filters", () => {
  it("declares engine and miner filters with package paths", () => {
    const ci = readFileSync(CI_PATH, "utf8");
    expect(ci).toMatch(/engine:\s*\n\s*- 'packages\/loopover-engine\/\*\*'/);
    expect(ci).toMatch(/miner:\s*\n\s*- 'packages\/loopover-miner\/\*\*'/);
    expect(ci).toContain("scripts/check-miner-package.ts");
    expect(ci).toContain("needs.changes.outputs.engine");
    expect(ci).toContain("needs.changes.outputs.miner");
    expect(ci).toContain("name: Build engine package");
    expect(ci).toContain("name: Build miner CLI");
    expect(ci).toContain("name: Miner package check");
    // Routed through Turborepo (turbo.json) rather than a bare npm workspace call, so its build cache is
    // shared across validate-code and every validate-tests shard instead of rebuilding independently in
    // each -- see the "Restore/Save Turborepo cache" steps alongside this one.
    expect(ci).toContain("turbo run build --filter=@loopover/engine");
    // Invokes build:tsc/build:verify directly (not the aggregate @loopover/miner#build task) -- the
    // aggregate's own script re-runs both, which would double the tsc compile and syntax check every run.
    expect(ci).toContain("turbo run build:tsc build:verify --filter=@loopover/miner");
    expect(ci).toContain("npm run test:miner-pack");
  });
});
