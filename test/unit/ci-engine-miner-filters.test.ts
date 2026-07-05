import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CI_PATH = join(process.cwd(), ".github/workflows/ci.yml");

describe("CI engine/miner path filters", () => {
  it("declares engine and miner filters with package paths", () => {
    const ci = readFileSync(CI_PATH, "utf8");
    expect(ci).toMatch(/engine:\s*\n\s*- 'packages\/gittensory-engine\/\*\*'/);
    expect(ci).toMatch(/miner:\s*\n\s*- 'packages\/gittensory-miner\/\*\*'/);
    expect(ci).toContain("scripts/check-miner-package.mjs");
    expect(ci).toContain("needs.changes.outputs.engine");
    expect(ci).toContain("needs.changes.outputs.miner");
    expect(ci).toContain("name: Build engine package");
    expect(ci).toContain("name: Build miner CLI");
    expect(ci).toContain("name: Miner package check");
    expect(ci).toContain("npm run build --workspace @jsonbored/gittensory-engine");
    expect(ci).toContain("npm run build:miner");
    expect(ci).toContain("npm run test:miner-pack");
  });
});
