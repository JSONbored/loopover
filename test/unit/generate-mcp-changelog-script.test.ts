import { afterEach, describe, expect, it, vi } from "vitest";

// #7460: readReleasePrepEntries()/dependencyChange()/readConstant() synthesize changelog entries for
// release-prep-only changes (dependency bumps, compatibility-constant updates) that real commit-message
// parsing would never surface -- these three functions had no coverage at all. Mirrors
// test/unit/mcp-release.test.ts's pattern for the already-tested sibling logic in mcp-release-core.ts.

const MCP_PACKAGE_JSON = "packages/loopover-mcp/package.json";
const ROOT_PACKAGE_JSON = "package.json";
const COMPATIBILITY_TS = "src/services/mcp-compatibility.ts";

function compatSource(minimum: string, latest: string): string {
  return `export const MINIMUM_SUPPORTED_MCP_VERSION = "${minimum}";\nexport const LATEST_RECOMMENDED_MCP_VERSION = "${latest}";\n`;
}

const BASE_TAG = "mcp-v0.8.0";

type FileMap = Record<string, string | undefined>;

const { readFileSyncMock, execFileSyncMock, state } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  state: { current: {} as Record<string, string | undefined>, previous: {} as Record<string, string | undefined> },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: readFileSyncMock };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

function setFixture(current: FileMap, previous: FileMap) {
  state.current = current;
  state.previous = previous;

  readFileSyncMock.mockImplementation((path: string) => {
    const value = state.current[path];
    if (value === undefined) throw new Error(`ENOENT (test fixture): ${path}`);
    return value;
  });

  execFileSyncMock.mockImplementation((command: string, args: string[]) => {
    if (command !== "git" || args[0] !== "show") throw new Error(`unexpected execFileSync call: ${command} ${args.join(" ")}`);
    const ref = args[1] ?? "";
    const [, path] = ref.split(":");
    const value = path ? state.previous[path] : undefined;
    if (value === undefined) {
      const error = new Error(`fatal: path '${path}' does not exist in '${ref.split(":")[0]}'`);
      throw error;
    }
    return value;
  });
}

const { readReleasePrepEntries, dependencyChange, readConstant } = await import("../../scripts/generate-mcp-changelog.js");

describe("readConstant (#7460)", () => {
  it("extracts a matching exported string constant", () => {
    expect(readConstant('export const FOO = "1.2.3";', "FOO")).toBe("1.2.3");
  });

  it("returns null when the constant name isn't present", () => {
    expect(readConstant('export const FOO = "1.2.3";', "BAR")).toBeNull();
  });

  it("handles a null source gracefully instead of throwing", () => {
    expect(readConstant(null, "FOO")).toBeNull();
  });
});

describe("dependencyChange (#7460)", () => {
  it("reports a version change as 'name previous -> current'", () => {
    expect(dependencyChange("zod", { zod: "4.4.3" }, { zod: "4.5.0" })).toBe("zod 4.4.3 -> 4.5.0");
  });

  it("returns null when the version is unchanged", () => {
    expect(dependencyChange("zod", { zod: "4.4.3" }, { zod: "4.4.3" })).toBeNull();
  });

  it("returns null when the dependency didn't exist previously (nothing to diff)", () => {
    expect(dependencyChange("zod", {}, { zod: "4.4.3" })).toBeNull();
  });

  it("returns null when the dependency was removed", () => {
    expect(dependencyChange("zod", { zod: "4.4.3" }, {})).toBeNull();
  });

  it("defaults an undefined dependency map to {} rather than throwing", () => {
    expect(dependencyChange("zod", undefined, { zod: "4.4.3" })).toBeNull();
  });
});

describe("readReleasePrepEntries (#7460)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns no entries at all when there is no base tag to diff against", () => {
    expect(readReleasePrepEntries({ baseTag: null, targetVersion: "0.9.0" })).toEqual([]);
  });

  it("produces a release-prep-deps entry naming every changed dependency, omitting unchanged ones", () => {
    setFixture(
      {
        [MCP_PACKAGE_JSON]: JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "1.30.0", zod: "4.4.3" } }),
        [ROOT_PACKAGE_JSON]: JSON.stringify({ dependencies: { "@asteasolutions/zod-to-openapi": "8.6.0", agents: "0.17.3" } }),
        [COMPATIBILITY_TS]: compatSource("0.5.0", "0.9.0"),
      },
      {
        [MCP_PACKAGE_JSON]: JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "1.29.0", zod: "4.4.3" } }),
        [ROOT_PACKAGE_JSON]: JSON.stringify({ dependencies: { "@asteasolutions/zod-to-openapi": "8.5.0", agents: "0.17.3" } }),
        [COMPATIBILITY_TS]: compatSource("0.5.0", "0.9.0"),
      },
    );

    const entries = readReleasePrepEntries({ baseTag: BASE_TAG, targetVersion: "0.9.0" });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sha: "release-prep-deps",
      files: ["package.json", "packages/loopover-mcp/package.json", "package-lock.json"],
    });
    // Only the two deps that actually changed are named; zod and agents (unchanged) are omitted.
    expect(entries[0]!.subject).toContain("@modelcontextprotocol/sdk 1.29.0 -> 1.30.0");
    expect(entries[0]!.subject).toContain("@asteasolutions/zod-to-openapi 8.5.0 -> 8.6.0");
    expect(entries[0]!.subject).not.toContain("zod 4.4.3");
    expect(entries[0]!.subject).not.toContain("agents 0.17.3");
  });

  it("produces no release-prep-deps entry when no tracked dependency changed", () => {
    const unchanged = {
      [MCP_PACKAGE_JSON]: JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "1.29.0", zod: "4.4.3" } }),
      [ROOT_PACKAGE_JSON]: JSON.stringify({ dependencies: { "@asteasolutions/zod-to-openapi": "8.5.0", agents: "0.17.3" } }),
      [COMPATIBILITY_TS]: compatSource("0.5.0", "0.9.0"),
    };
    setFixture(unchanged, unchanged);

    expect(readReleasePrepEntries({ baseTag: BASE_TAG, targetVersion: "0.9.0" })).toEqual([]);
  });

  it("produces a release-prep-compat entry when both compatibility constants change to the target version", () => {
    setFixture(
      {
        [MCP_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
        [ROOT_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
        [COMPATIBILITY_TS]: compatSource("0.9.0", "0.9.0"),
      },
      {
        [MCP_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
        [ROOT_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
        [COMPATIBILITY_TS]: compatSource("0.8.0", "0.8.0"),
      },
    );

    const entries = readReleasePrepEntries({ baseTag: BASE_TAG, targetVersion: "0.9.0" });

    expect(entries).toEqual([
      {
        sha: "release-prep-compat",
        subject: "feat(mcp): require 0.9.0 as the current supported client",
        files: [COMPATIBILITY_TS],
      },
    ]);
  });

  it("produces no release-prep-compat entry when only one constant reaches the target version (partial change)", () => {
    setFixture(
      {
        [MCP_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
        [ROOT_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
        // MINIMUM reached the target, but LATEST is still behind -- the && guard requires both.
        [COMPATIBILITY_TS]: compatSource("0.9.0", "0.8.0"),
      },
      {
        [MCP_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
        [ROOT_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
        [COMPATIBILITY_TS]: compatSource("0.8.0", "0.8.0"),
      },
    );

    expect(readReleasePrepEntries({ baseTag: BASE_TAG, targetVersion: "0.9.0" })).toEqual([]);
  });

  it("produces no release-prep-compat entry when both constants change but land on an unrelated version", () => {
    setFixture(
      {
        [MCP_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
        [ROOT_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
        // Both constants moved, but to 0.8.5 -- not the 0.9.0 release this changelog entry is for.
        [COMPATIBILITY_TS]: compatSource("0.8.5", "0.8.5"),
      },
      {
        [MCP_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
        [ROOT_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
        [COMPATIBILITY_TS]: compatSource("0.8.0", "0.8.0"),
      },
    );

    expect(readReleasePrepEntries({ baseTag: BASE_TAG, targetVersion: "0.9.0" })).toEqual([]);
  });

  it("treats a base tag that predates a file's existence (git show failure) as absent, without throwing", () => {
    state.current = {
      [MCP_PACKAGE_JSON]: JSON.stringify({ dependencies: { zod: "4.4.3" } }),
      [ROOT_PACKAGE_JSON]: JSON.stringify({ dependencies: {} }),
      [COMPATIBILITY_TS]: compatSource("0.9.0", "0.9.0"),
    };
    state.previous = {}; // every git show call fails, as if baseTag predates all three files
    readFileSyncMock.mockImplementation((path: string) => {
      const value = state.current[path];
      if (value === undefined) throw new Error(`ENOENT (test fixture): ${path}`);
      return value;
    });
    execFileSyncMock.mockImplementation(() => {
      throw new Error("fatal: path does not exist in that tree-ish");
    });

    expect(() => readReleasePrepEntries({ baseTag: BASE_TAG, targetVersion: "0.9.0" })).not.toThrow();
    const entries = readReleasePrepEntries({ baseTag: BASE_TAG, targetVersion: "0.9.0" });
    // No previous dependency data to diff against -> no release-prep-deps entry (dependencyChange
    // requires BOTH a previous and current version).
    expect(entries.some((entry) => entry.sha === "release-prep-deps")).toBe(false);
    // No previous compatibility constants either (readConstant(null, ...) -> null), which the guard
    // treats as "changed" -- since the current constants already equal the target version, this still
    // reports a compat entry, matching the function's own "can't prove otherwise" behavior.
    expect(entries).toContainEqual({
      sha: "release-prep-compat",
      subject: "feat(mcp): require 0.9.0 as the current supported client",
      files: [COMPATIBILITY_TS],
    });
  });
});
