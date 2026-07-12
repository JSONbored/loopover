import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORGE_CONFIG,
  resolveForgeConfig,
} from "../../packages/gittensory-miner/lib/forge-config.js";

describe("resolveForgeConfig (#4784)", () => {
  it("returns gittensory's github.com defaults when no overrides are supplied", () => {
    expect(resolveForgeConfig()).toEqual({
      apiBaseUrl: "https://api.github.com",
      apiVersion: "2022-11-28",
      apiVersionHeader: "x-github-api-version",
      acceptHeader: "application/vnd.github+json",
      userAgent: "loopover-miner",
      repoPathPrefix: "/repos",
      searchEndpoint: "/search/issues",
      searchQualifiers: "state:open type:issue",
      tokenEnvVar: "GITHUB_TOKEN",
    });
    // A no-override resolve must exactly equal the shared default baseline (the "unchanged gittensory path" contract).
    expect(resolveForgeConfig()).toEqual({ ...DEFAULT_FORGE_CONFIG });
  });

  it("applies only the supplied per-tenant overrides and keeps defaults for the rest", () => {
    const resolved = resolveForgeConfig({
      apiBaseUrl: "https://ghe.example.com/api/v3",
      apiVersionHeader: "x-forge-version",
      apiVersion: "v9",
      tokenEnvVar: "FORGE_PAT",
    });
    expect(resolved.apiBaseUrl).toBe("https://ghe.example.com/api/v3");
    expect(resolved.apiVersionHeader).toBe("x-forge-version");
    expect(resolved.apiVersion).toBe("v9");
    expect(resolved.tokenEnvVar).toBe("FORGE_PAT");
    // Untouched fields still fall back to the github.com defaults.
    expect(resolved.acceptHeader).toBe("application/vnd.github+json");
    expect(resolved.repoPathPrefix).toBe("/repos");
    expect(resolved.searchEndpoint).toBe("/search/issues");
    expect(resolved.searchQualifiers).toBe("state:open type:issue");
    expect(resolved.userAgent).toBe("loopover-miner");
  });

  it("trims string overrides and falls back to the default for blank or non-string values", () => {
    expect(resolveForgeConfig({ userAgent: "  my-tenant-bot  " }).userAgent).toBe("my-tenant-bot");
    // Blank/whitespace override -> default (a tenant can't accidentally clear a field to "").
    expect(resolveForgeConfig({ userAgent: "   " }).userAgent).toBe("loopover-miner");
    // Non-string override -> default.
    expect(resolveForgeConfig({ apiVersion: 123 as never }).apiVersion).toBe("2022-11-28");
  });

  it("treats a non-object overrides argument as no overrides", () => {
    expect(resolveForgeConfig(null as never)).toEqual({ ...DEFAULT_FORGE_CONFIG });
  });

  it("exposes a frozen default baseline that resolve never mutates", () => {
    expect(Object.isFrozen(DEFAULT_FORGE_CONFIG)).toBe(true);
    resolveForgeConfig({ apiBaseUrl: "https://other.example" });
    expect(DEFAULT_FORGE_CONFIG.apiBaseUrl).toBe("https://api.github.com");
  });
});
