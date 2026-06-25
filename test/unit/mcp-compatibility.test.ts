import { describe, expect, it } from "vitest";
import { buildMcpClientTelemetry } from "../../src/services/client-telemetry";
import { classifyMcpClientVersion, compareMcpSemver } from "../../src/services/mcp-compatibility";

describe("MCP compatibility telemetry", () => {
  it("classifies local MCP package versions against the advertised support window", () => {
    expect(classifyMcpClientVersion("0.1.9")).toBe("incompatible");
    expect(classifyMcpClientVersion("0.2.1")).toBe("incompatible");
    expect(classifyMcpClientVersion("0.3.0")).toBe("incompatible");
    expect(classifyMcpClientVersion("0.4.0")).toBe("incompatible");
    // >= minimum (0.5.0) but < latest recommended (0.6.0) → supported-but-behind → "stale".
    expect(classifyMcpClientVersion("0.5.0")).toBe("stale");
    expect(classifyMcpClientVersion("0.5.9")).toBe("stale");
    // At/above the latest recommended → "current".
    expect(classifyMcpClientVersion("0.6.0")).toBe("current");
    expect(classifyMcpClientVersion("0.7.1")).toBe("current");
    expect(classifyMcpClientVersion("not-a-version")).toBe("unknown");
    expect(classifyMcpClientVersion(undefined)).toBe("unknown");
  });

  it("builds bounded telemetry from allowlisted MCP headers", () => {
    const telemetry = buildMcpClientTelemetry(
      new Headers({
        "x-gittensory-mcp-package": "@jsonbored/gittensory-mcp",
        "x-gittensory-mcp-version": "0.2.1",
        "x-gittensory-mcp-client": "gittensory-mcp-cli",
        "mcp-protocol-version": "2025-03-26",
      }),
      { requireGittensoryHeader: true },
    );

    expect(telemetry).toMatchObject({
      clientName: "gittensory-mcp-cli",
      clientVersion: "0.2.1",
      metadata: {
        packageName: "@jsonbored/gittensory-mcp",
        packageVersion: "0.2.1",
        protocolVersion: "2025-03-26",
        compatibilityStatus: "incompatible",
      },
    });
  });

  it("derives a safe client name from scoped package telemetry when no explicit client is sent", () => {
    const telemetry = buildMcpClientTelemetry(
      new Headers({
        "x-gittensory-mcp-package": "@example/custom-mcp",
        "x-gittensory-mcp-version": "0.5.0",
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
        "x-gittensory-mcp-package": "@jsonbored/gittensory-mcp",
        "x-gittensory-mcp-version": "0.4.0",
      }),
      { requireGittensoryHeader: true },
    );
    expect(canonical).toMatchObject({ clientName: "gittensory-mcp", clientVersion: "0.4.0" });

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
        "x-gittensory-mcp-package": "/Users/example/private",
        "x-gittensory-mcp-version": "github_pat_secretsecret",
        "x-gittensory-mcp-client": "node /tmp/client.js",
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
    expect(compareMcpSemver("0.3.0-rc.1", "0.3.0-rc.1.1")).toBe(-1);
    expect(compareMcpSemver("0.3.0-rc.1.1", "0.3.0-rc.1")).toBe(1);
    expect(compareMcpSemver("0.3.0-rc.1", "0.3.0-rc.1")).toBe(0);
    expect(compareMcpSemver("0.3.0-RC.1", "0.3.0-rc.1")).toBe(0);
    expect(compareMcpSemver("v0.3.0", "0.3.0")).toBe(0);
    expect(compareMcpSemver("bad", "0.3.0")).toBeNull();
  });
});
