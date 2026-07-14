import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCapture } from "./support/miner-cli-harness.js";

const minerRoot = join(process.cwd(), "packages/gittensory-miner");
const mcpRoot = join(process.cwd(), "packages/gittensory-mcp");
const readmePath = join(minerRoot, "README.md");

type PackageJson = {
  name: string;
  license: string;
  type: string;
  bin: Record<string, string>;
  files: string[];
  publishConfig: { access: string };
  dependencies: Record<string, string>;
  engines: { node: string };
  scripts: { build: string };
};

function readPackageJson(root: string): PackageJson {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
}

describe("loopover-miner package skeleton (#2287)", () => {
  it("mirrors loopover-mcp packaging conventions", () => {
    const miner = readPackageJson(minerRoot);
    const mcp = readPackageJson(mcpRoot);

    expect(miner.name).toBe("@loopover/miner");
    expect(miner.license).toBe("AGPL-3.0-only");
    expect(miner.type).toBe("module");
    expect(miner.bin).toEqual({
      "loopover-miner": "bin/loopover-miner.js",
      "loopover-miner-mcp": "bin/loopover-miner-mcp.js",
    });
    expect(miner.publishConfig).toEqual(mcp.publishConfig);
    expect(miner.dependencies["@loopover/engine"]).toBeDefined();
    expect(miner.engines.node).toMatch(/^>=22(?:\.\d+){0,2}$/);
    expect(miner.files).toEqual(expect.arrayContaining(["bin", "lib"]));
    expect(miner.scripts.build.startsWith("node --check bin/loopover-miner.js")).toBe(true);
  });

  it("starts the CLI bin with a node shebang", () => {
    const bin = readFileSync(join(minerRoot, "bin/loopover-miner.js"), "utf8");
    expect(bin.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("is discoverable from the repo root workspace", () => {
    // `npm ls` exits non-zero whenever ANY package anywhere in the WHOLE resolved tree is extraneous/invalid,
    // even though `--workspace` only scopes the DISPLAYED subtree -- unrelated tree-wide dependency drift
    // elsewhere in the monorepo (#3663) would otherwise fail this assertion via execFileSync's throw-on-nonzero
    // behavior. spawnSync never throws; assert on stdout content directly, decoupled from the exit code.
    const result = spawnSync(
      "npm",
      ["ls", "--workspace", "@loopover/miner", "--depth=0"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.stdout).toContain("@loopover/miner@");
  });

  it("serves --help and --version from the bin entry", () => {
    expect(runCapture(["--help", "--no-update-check"])).toContain("loopover-miner --help");
    expect(runCapture(["--version", "--no-update-check"])).toContain("@loopover/miner/");
    expect(
      runCapture(["--version", "--no-update-check"], {
        LOOPOVER_MINER_VERSION: "gittensory-miner-fleet@abc1234",
      }),
    ).toContain("gittensory-miner-fleet@abc1234");
  });

  it("documents foundation scope and local checkout install paths in the README", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("foundation phase");
    expect(readme).toContain("npm link --workspace @loopover/miner");
    expect(readme).toContain("loopover-miner --help");
    expect(readme).toContain("loopover-miner --version");
  });
});
