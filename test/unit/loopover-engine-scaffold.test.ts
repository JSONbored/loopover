import { describe, expect, it } from "vitest";
import enginePkg from "../../packages/loopover-engine/package.json";

// The loopover-engine package is a packaging-only scaffold (no runtime logic yet — the barrel export is
// intentionally empty until later issues extract deterministic modules into it). These tests pin the published
// package contract so the skeleton stays correct and installable as extraction lands.
describe("loopover-engine package scaffold", () => {
  it("declares the published package identity", () => {
    expect(enginePkg.name).toBe("@loopover/engine");
    expect(enginePkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(enginePkg.type).toBe("module");
    expect(enginePkg.license).toBe("AGPL-3.0-only");
    expect(enginePkg.publishConfig?.access).toBe("public");
    // Upper-bounded (#7613) so a local install/run on a Node major past .nvmrc's pin fails loudly via
    // engine-strict instead of silently drifting -- exactly how the Node 26 jsdom/localStorage gap
    // (#7592/#7597, #7612) went undetected until someone happened to run tests on a newer Node.
    expect(enginePkg.engines?.node).toBe(">=22.0.0 <23.0.0");
  });

  it("points its entry points at the built dist output", () => {
    expect(enginePkg.main).toBe("dist/index.js");
    expect(enginePkg.types).toBe("dist/index.d.ts");
    expect(enginePkg.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
  });

  it("publishes only the build output and changelog, not source", () => {
    expect(enginePkg.files).toEqual(["dist", "CHANGELOG.md"]);
    expect(enginePkg.files).not.toContain("src");
  });

  it("builds with a real tsc compile and records its repository directory", () => {
    expect(enginePkg.scripts?.build).toBe("tsc -p tsconfig.json");
    expect(enginePkg.repository?.directory).toBe("packages/loopover-engine");
  });
});
