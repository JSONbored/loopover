import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectedMcpVersions,
  loadMcpPackageJson,
  MINIMUM_SUPPORTED_MCP_VERSION,
} from "../../scripts/smoke-production-versions.js";

describe("smoke-production-versions (#6293)", () => {
  it("derives latest from the MCP package.json and keeps the supported floor fixed", () => {
    expect(expectedMcpVersions({ version: "3.0.0" })).toEqual({
      minimumSupportedVersion: "0.5.0",
      latestRecommendedVersion: "3.0.0",
    });
    expect(MINIMUM_SUPPORTED_MCP_VERSION).toBe("0.5.0");
  });

  it("rejects a missing or blank package version", () => {
    expect(() => expectedMcpVersions({})).toThrow(/missing a non-empty version/i);
    expect(() => expectedMcpVersions({ version: "  " })).toThrow(/missing a non-empty version/i);
  });

  it("loads the real MCP package.json and matches its version field", () => {
    const loaded = loadMcpPackageJson();
    const onDisk = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../packages/loopover-mcp/package.json"), "utf8"),
    );
    expect(loaded.version).toBe(onDisk.version);
    expect(expectedMcpVersions(loaded).latestRecommendedVersion).toBe(onDisk.version);
  });
});
