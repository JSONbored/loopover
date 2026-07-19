import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCapture } from "./support/miner-cli-harness.js";

const minerRoot = join(process.cwd(), "packages/loopover-miner");
const mcpRoot = join(process.cwd(), "packages/loopover-mcp");
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
  scripts: { build: string; "build:tsc": string; "build:verify": string };
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
    // build is split into build:tsc (the real tsc compile, cacheable-by-turbo-but-not-turbo-restorable
    // since its output is committed to git alongside hand-written siblings tsc never touches) and
    // build:verify (a glob-driven node --check pass over every bin/lib .js file, replacing a previously
    // hand-listed ~119-file chain here that had to be kept in sync by hand).
    expect(miner.scripts.build).toBe("npm run build:tsc && npm run build:verify");
    expect(miner.scripts["build:tsc"]).toBe("tsc -p tsconfig.json");
    expect(miner.scripts["build:verify"]).toBe("node scripts/check-syntax.mjs");
  });

  it("build:verify's syntax check actually covers the CLI bin entry points, not just lib/", () => {
    // The pre-split build script explicitly node --check'd bin/loopover-miner.js and
    // bin/loopover-miner-mcp.js by name; the glob-driven replacement must still reach them.
    const result = spawnSync("node", ["scripts/check-syntax.mjs"], { cwd: minerRoot, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("node --check passed for all");
    expect(result.stdout).toMatch(/passed for all \d+ files in bin\/ and lib\//);
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
        LOOPOVER_MINER_VERSION: "loopover-miner-fleet@abc1234",
      }),
    ).toContain("loopover-miner-fleet@abc1234");
  });

  it("documents foundation scope and local checkout install paths in the README", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("foundation phase");
    expect(readme).toContain("npm link --workspace @loopover/miner");
    expect(readme).toContain("loopover-miner --help");
    expect(readme).toContain("loopover-miner --version");
  });
});
