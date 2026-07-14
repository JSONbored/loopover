import { describe, expect, it } from "vitest";
import { buildMcpClientTelemetry } from "../../src/services/client-telemetry";
import { classifyMcpClientVersion, compareMcpSemver, LATEST_RECOMMENDED_MCP_VERSION, MINIMUM_SUPPORTED_MCP_VERSION } from "../../src/services/mcp-compatibility";

// Derives values relative to the actual current recommended release instead of hardcoding a literal
// that only happens to be correct for whichever version is current when the test is written --
// LATEST_RECOMMENDED_MCP_VERSION now derives from packages/gittensory-mcp/package.json (no longer a
// second hand-synced literal), so these assertions stay correct across every future release too.
// MINIMUM_SUPPORTED_MCP_VERSION-relative literals ("0.5.9" etc.) stay hardcoded on purpose: unlike the
// recommended version, that constant is deliberately NOT bumped every release.
function bumpMinor(version: string): string {
  const [major, minor] = version.split(".").map(Number) as [number, number, number];
  return `${major}.${minor + 1}.0`;
}
function bumpPatch(version: string): string {
  const [major, minor, patch] = version.split(".").map(Number) as [number, number, number];
  return `${major}.${minor}.${patch + 1}`;
}

describe("MCP compatibility telemetry", () => {
  it("classifies local MCP package versions against the advertised support window", () => {
    expect(classifyMcpClientVersion("0.1.9")).toBe("incompatible");
    expect(classifyMcpClientVersion("0.2.1")).toBe("incompatible");
    expect(classifyMcpClientVersion("0.3.0")).toBe("incompatible");
    expect(classifyMcpClientVersion("0.4.0")).toBe("incompatible");
    expect(classifyMcpClientVersion(MINIMUM_SUPPORTED_MCP_VERSION)).toBe("stale");
    expect(classifyMcpClientVersion("0.5.9")).toBe("stale");
    expect(classifyMcpClientVersion(LATEST_RECOMMENDED_MCP_VERSION)).toBe("current");
    expect(classifyMcpClientVersion("not-a-version")).toBe("unknown");
    expect(classifyMcpClientVersion(undefined)).toBe("unknown");
    expect(classifyMcpClientVersion(null)).toBe("unknown");
  });

  it("treats prerelease builds below the minimum or recommended cutoffs as incompatible or stale", () => {
    expect(classifyMcpClientVersion("0.4.9-rc.1")).toBe("incompatible");
    expect(classifyMcpClientVersion(`${MINIMUM_SUPPORTED_MCP_VERSION}-rc.1`)).toBe("incompatible");
    expect(classifyMcpClientVersion(`${LATEST_RECOMMENDED_MCP_VERSION}-rc.1`)).toBe("stale");
  });

  it("classifies the exact recommended version and newer releases as current", () => {
    expect(classifyMcpClientVersion(LATEST_RECOMMENDED_MCP_VERSION)).toBe("current");
    expect(classifyMcpClientVersion(bumpPatch(LATEST_RECOMMENDED_MCP_VERSION))).toBe("current");
    expect(classifyMcpClientVersion("999.0.0")).toBe("current");
    expect(compareMcpSemver(LATEST_RECOMMENDED_MCP_VERSION, LATEST_RECOMMENDED_MCP_VERSION)).toBe(0);
    expect(compareMcpSemver(bumpMinor(LATEST_RECOMMENDED_MCP_VERSION), LATEST_RECOMMENDED_MCP_VERSION)).toBe(1);
  });

  it("builds bounded telemetry from allowlisted MCP headers", () => {
    const telemetry = buildMcpClientTelemetry(
      new Headers({
        "x-loopover-mcp-package": "@loopover/mcp",
        "x-loopover-mcp-version": "0.2.1",
        "x-loopover-mcp-client": "loopover-mcp-cli",
        "mcp-protocol-version": "2025-03-26",
      }),
      { requireGittensoryHeader: true },
    );

    expect(telemetry).toMatchObject({
      clientName: "loopover-mcp-cli",
      clientVersion: "0.2.1",
      metadata: {
        packageName: "@loopover/mcp",
        packageVersion: "0.2.1",
        protocolVersion: "2025-03-26",
        compatibilityStatus: "incompatible",
      },
    });
  });

  it("derives a safe client name from scoped package telemetry when no explicit client is sent", () => {
    const telemetry = buildMcpClientTelemetry(
      new Headers({
        "x-loopover-mcp-package": "@example/custom-mcp",
        "x-loopover-mcp-version": "0.5.0",
      }),
      { requireGittensoryHeader: true },
    );

    expect(telemetry).toMatchObject({
      clientName: "custom-mcp",
      clientVersion: "0.5.0",
      metadata: {
        packageName: "@example/custom-mcp",
        compatibilityStatus: "stale",
      },
    });
  });

  it("uses the canonical package and default MCP client fallbacks without storing unsafe header data", () => {
    const canonical = buildMcpClientTelemetry(
      new Headers({
        "x-loopover-mcp-package": "@loopover/mcp",
        "x-loopover-mcp-version": "0.4.0",
      }),
      { requireGittensoryHeader: true },
    );
    expect(canonical).toMatchObject({ clientName: "loopover-mcp", clientVersion: "0.4.0" });

    const defaulted = buildMcpClientTelemetry(new Headers(), { defaultClientName: "mcp" });
    expect(defaulted).toMatchObject({
      clientName: "mcp",
      metadata: { compatibilityStatus: "unknown" },
    });

    const generic = buildMcpClientTelemetry(new Headers());
    expect(generic).toMatchObject({ clientName: "mcp" });
  });

  it("drops token-like and local-path-like header values before analytics storage", () => {
    const telemetry = buildMcpClientTelemetry(
      new Headers({
        "x-loopover-mcp-package": "/Users/example/private",
        "x-loopover-mcp-version": "github_pat_secretsecret",
        "x-loopover-mcp-client": "node /tmp/client.js",
        "mcp-protocol-version": "Bearer secret-token-value",
      }),
      { requireGittensoryHeader: true },
    );

    expect(telemetry).toBeNull();
    expect(JSON.stringify(telemetry)).not.toMatch(/Users|github_pat|Bearer|\/tmp|secret-token/i);
  });

  it("compares prerelease MCP versions with semver precedence", () => {
    expect(compareMcpSemver("0.3.0", "0.3.0-rc.1")).toBe(1);
    expect(compareMcpSemver("0.3.0-rc.1", "0.3.0")).toBe(-1);
    expect(compareMcpSemver("0.3.0", "0.4.0")).toBe(-1);
    expect(compareMcpSemver("0.4.0", "0.3.0")).toBe(1);
    expect(compareMcpSemver("0.3.1", "0.3.0")).toBe(1);
    expect(compareMcpSemver("0.3.0", "0.3.1")).toBe(-1);
    expect(compareMcpSemver("0.3.0-rc.2", "0.3.0-rc.10")).toBe(-1);
    expect(compareMcpSemver("0.3.0-rc.10", "0.3.0-rc.2")).toBe(1);
    expect(compareMcpSemver("0.3.0-beta", "0.3.0-alpha")).toBe(1);
    expect(compareMcpSemver("0.3.0-alpha", "0.3.0-beta")).toBe(-1);
    expect(compareMcpSemver("0.3.0-1", "0.3.0-alpha")).toBe(-1);
    expect(compareMcpSemver("0.3.0-alpha", "0.3.0-1")).toBe(1);
    // A numeric identifier ranks below an alphanumeric one even when its digits sort higher (semver
    // §11.4.3): `2` < `1a`, not `2` > `1a` as a whole-string numeric compare would rank it.
    expect(compareMcpSemver("0.3.0-2", "0.3.0-1a")).toBe(-1);
    expect(compareMcpSemver("0.3.0-1a", "0.3.0-2")).toBe(1);
    // Numeric identifiers beyond Number.MAX_SAFE_INTEGER must still order correctly (decimal-string
    // compare), not collapse to equal as a Number()-based compare would.
    expect(compareMcpSemver("0.3.0-9007199254740992", "0.3.0-9007199254740993")).toBe(-1);
    expect(compareMcpSemver("0.3.0-9007199254740993", "0.3.0-9007199254740992")).toBe(1);
    expect(compareMcpSemver("0.3.0-rc.1", "0.3.0-rc.1.1")).toBe(-1);
    expect(compareMcpSemver("0.3.0-rc.1.1", "0.3.0-rc.1")).toBe(1);
    expect(compareMcpSemver("0.3.0-rc.1", "0.3.0-rc.1")).toBe(0);
    expect(compareMcpSemver("0.3.0-RC.1", "0.3.0-rc.1")).toBe(0);
    expect(compareMcpSemver("v0.3.0", "0.3.0")).toBe(0);
    expect(compareMcpSemver("bad", "0.3.0")).toBeNull();
  });
});
