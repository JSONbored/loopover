import { describe, expect, it } from "vitest";

import {
  MCP_PACKAGE_KNOWN_LATEST_VERSION,
  MCP_PACKAGE_NAME,
  getLatestMcpVersion,
  getMcpInstallCommand,
  getMcpNpxPackage,
  getRecentMcpVersions,
  isStableVersion,
  type NpmPackageMetadata,
} from "@/lib/mcp-package";

// (#8388) Pure version-selection / fallback helpers behind the site MCP badge + install command.
// Branch coverage matters: a one-line regex or fallback-order mistake can recommend a prerelease as "latest".

function meta(partial: {
  latest?: string;
  versions: Record<string, unknown>;
  time: Record<string, string>;
}): NpmPackageMetadata {
  return {
    "dist-tags": partial.latest === undefined ? {} : { latest: partial.latest },
    versions: partial.versions,
    time: partial.time,
  };
}

describe("isStableVersion", () => {
  it("accepts a plain semver triple", () => {
    expect(isStableVersion("3.11.0")).toBe(true);
  });

  it("rejects prereleases, incomplete triples, v-prefixes, empty, and non-numeric strings", () => {
    expect(isStableVersion("3.11.0-beta.1")).toBe(false);
    expect(isStableVersion("3.11")).toBe(false);
    expect(isStableVersion("v3.11.0")).toBe(false);
    expect(isStableVersion("")).toBe(false);
    expect(isStableVersion("not-a-version")).toBe(false);
  });
});

describe("getLatestMcpVersion", () => {
  it("returns dist-tags.latest when it is present and stable", () => {
    expect(
      getLatestMcpVersion(
        meta({
          latest: "3.12.0",
          versions: { "3.12.0": {} },
          time: { "3.12.0": "2026-07-01T00:00:00.000Z" },
        }),
      ),
    ).toBe("3.12.0");
  });

  it("falls back to MCP_PACKAGE_KNOWN_LATEST_VERSION when data is undefined", () => {
    expect(getLatestMcpVersion(undefined)).toBe(MCP_PACKAGE_KNOWN_LATEST_VERSION);
  });

  it("falls back when dist-tags.latest is absent", () => {
    expect(
      getLatestMcpVersion(
        meta({ versions: { "3.10.0": {} }, time: { "3.10.0": "2026-06-01T00:00:00.000Z" } }),
      ),
    ).toBe(MCP_PACKAGE_KNOWN_LATEST_VERSION);
  });

  it("falls back when dist-tags.latest is present but unstable (prerelease must never surface as latest)", () => {
    expect(
      getLatestMcpVersion(
        meta({
          latest: "3.12.0-beta.1",
          versions: { "3.12.0-beta.1": {} },
          time: { "3.12.0-beta.1": "2026-07-02T00:00:00.000Z" },
        }),
      ),
    ).toBe(MCP_PACKAGE_KNOWN_LATEST_VERSION);
  });
});

describe("getRecentMcpVersions", () => {
  it("returns [MCP_PACKAGE_KNOWN_LATEST_VERSION] when data is undefined", () => {
    expect(getRecentMcpVersions(undefined)).toEqual([MCP_PACKAGE_KNOWN_LATEST_VERSION]);
  });

  it("excludes unstable versions and versions missing a time entry", () => {
    const data = meta({
      latest: "3.11.0",
      // Insertion order: beta first, then a stable without time, then stables with times.
      versions: {
        "3.12.0-beta.1": {},
        "3.9.0": {},
        "3.10.0": {},
        "3.11.0": {},
      },
      time: {
        "3.12.0-beta.1": "2026-07-03T00:00:00.000Z",
        // deliberately omit 3.9.0
        "3.10.0": "2026-06-01T00:00:00.000Z",
        "3.11.0": "2026-07-01T00:00:00.000Z",
      },
    });
    expect(getRecentMcpVersions(data)).toEqual(["3.11.0", "3.10.0"]);
  });

  it("sorts by descending publish time even when insertion order differs", () => {
    const data = meta({
      latest: "3.10.0",
      // Inserted oldest→newest, but times are shuffled so sort must reorder.
      versions: {
        "3.8.0": {},
        "3.10.0": {},
        "3.9.0": {},
      },
      time: {
        "3.8.0": "2026-04-01T00:00:00.000Z",
        "3.10.0": "2026-06-01T00:00:00.000Z",
        "3.9.0": "2026-05-01T00:00:00.000Z",
      },
    });
    expect(getRecentMcpVersions(data)).toEqual(["3.10.0", "3.9.0", "3.8.0"]);
  });

  it("defaults to a limit of 6 and respects a custom limit", () => {
    const versions: Record<string, unknown> = {};
    const time: Record<string, string> = {};
    for (let i = 1; i <= 8; i += 1) {
      const version = `3.${i}.0`;
      versions[version] = {};
      time[version] = `2026-0${i}-01T00:00:00.000Z`;
    }
    const data = meta({ latest: "3.8.0", versions, time });
    expect(getRecentMcpVersions(data)).toHaveLength(6);
    expect(getRecentMcpVersions(data)[0]).toBe("3.8.0");
    expect(getRecentMcpVersions(data, 3)).toEqual(["3.8.0", "3.7.0", "3.6.0"]);
  });
});

describe("getMcpInstallCommand / getMcpNpxPackage", () => {
  it("pins to the given version when it is stable", () => {
    expect(getMcpInstallCommand("3.11.0")).toBe(`npm i -g ${MCP_PACKAGE_NAME}@3.11.0`);
    expect(getMcpNpxPackage("3.11.0")).toBe(`${MCP_PACKAGE_NAME}@3.11.0`);
  });

  it("falls back to @latest when version is undefined", () => {
    expect(getMcpInstallCommand()).toBe(`npm i -g ${MCP_PACKAGE_NAME}@latest`);
    expect(getMcpInstallCommand(undefined)).toBe(`npm i -g ${MCP_PACKAGE_NAME}@latest`);
    expect(getMcpNpxPackage()).toBe(`${MCP_PACKAGE_NAME}@latest`);
    expect(getMcpNpxPackage(undefined)).toBe(`${MCP_PACKAGE_NAME}@latest`);
  });

  it("falls back to @latest when version is an unstable string", () => {
    expect(getMcpInstallCommand("3.12.0-beta.1")).toBe(`npm i -g ${MCP_PACKAGE_NAME}@latest`);
    expect(getMcpNpxPackage("3.12.0-beta.1")).toBe(`${MCP_PACKAGE_NAME}@latest`);
  });
});
