import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { checkNodeVersion } from "../../scripts/check-node-version.js";

describe("check-node-version script", () => {
  it("passes when the running Node satisfies the declared engines.node range", () => {
    const result = checkNodeVersion({
      nodeVersion: "v22.23.1",
      readFile: () => JSON.stringify({ engines: { node: ">=22.0.0 <23.0.0" } }),
    });

    expect(result).toEqual({ ok: true, requiredRange: ">=22.0.0 <23.0.0", nodeVersion: "v22.23.1" });
  });

  it("fails when the running Node is outside the declared engines.node range (the Node 26 case)", () => {
    const result = checkNodeVersion({
      nodeVersion: "v26.5.0",
      readFile: () => JSON.stringify({ engines: { node: ">=22.0.0 <23.0.0" } }),
    });

    expect(result).toEqual({ ok: false, requiredRange: ">=22.0.0 <23.0.0", nodeVersion: "v26.5.0" });
  });

  it("passes trivially when package.json declares no engines.node at all", () => {
    const result = checkNodeVersion({
      nodeVersion: "v26.5.0",
      readFile: () => JSON.stringify({}),
    });

    expect(result).toEqual({ ok: true, requiredRange: undefined });
  });

  // Regression guard: proves the process actually running this test suite -- CI's own Node, or whatever a
  // contributor is running locally -- genuinely satisfies the real repo's engines.node. If this fails, the
  // repo is being tested on the wrong Node right now.
  it("the real repo's engines.node is satisfied by whatever Node is running this suite", () => {
    const result = checkNodeVersion();

    expect(result.ok).toBe(true);
  });

  it("prints nothing and exits 0 as a subprocess on a satisfying Node", () => {
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/check-node-version.ts"], { encoding: "utf8" });

    expect(output).toBe("");
  });
});
