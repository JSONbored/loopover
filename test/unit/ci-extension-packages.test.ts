import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("browser extension workspace packages (#4866)", () => {
  it("declares workspace package.json files for both extensions", () => {
    const maintainer = JSON.parse(read("apps/loopover-extension/package.json"));
    const miner = JSON.parse(read("apps/loopover-miner-extension/package.json"));

    expect(maintainer.name).toBe("@loopover/extension");
    expect(miner.name).toBe("@loopover/miner-extension");
    expect(maintainer.scripts.build).toContain("build-extension.ts");
    expect(miner.scripts.build).toContain("build-miner-extension.ts");
    expect(miner.scripts.lint).toContain("node --check");
    expect(miner.scripts.typecheck).toBe("npm run lint");
  });

  it("wires extension lint/typecheck/build scripts into root package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["extension:lint"]).toContain("@loopover/extension");
    expect(pkg.scripts["miner-extension:build"]).toContain("@loopover/miner-extension");
    expect(pkg.scripts["ui:build"]).toContain("miner-extension:build");
  });

  it("includes both extensions in ci.yml's ui path filter and validate-code steps", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toContain("apps/loopover-miner-extension/**");
    expect(workflow).toContain("scripts/build-miner-extension.ts");
    expect(workflow).toContain("name: Extension lint");
    // Routed through Turborepo (turbo.json's @loopover/extension#lint/typecheck and
    // @loopover/miner-extension#lint/typecheck) -- see ci.yml's comment on these steps.
    expect(workflow).toContain("npx turbo run lint --filter=@loopover/extension --filter=@loopover/miner-extension");
    expect(workflow).toContain(
      "npx turbo run typecheck --filter=@loopover/extension --filter=@loopover/miner-extension",
    );
    // @loopover/ui#build's dependsOn (turbo.json) covers the extension + miner-extension build pair.
    expect(workflow).toContain("run: npx turbo run build --filter=@loopover/ui");
  });
});
