import { describe, expect, it } from "vitest";
import { WATCHED_PATHS, checkServerManifest, checkWatchedPaths, collectProblems } from "../../scripts/check-server-manifest";

// #9526: the manifest check, and specifically its ANTI-ROT half.
//
// metagraphed's version-sync workflow watched a path that had been renamed away and kept passing for months
// while doing nothing. A workflow that can quietly watch nothing is worse than no workflow, so the guard
// itself needs a test that proves it fails when a watched path disappears.

const MCP_PACKAGE = JSON.stringify({ name: "@loopover/mcp", version: "3.15.2" });

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "io.github.JSONbored/loopover",
    description: "LoopOver's contribution-intelligence tools.",
    repository: { url: "https://github.com/JSONbored/loopover", source: "github" },
    version: "3.15.2",
    remotes: [{ type: "streamable-http", url: "https://api.loopover.ai/mcp" }],
    packages: [{ registry_type: "npm", identifier: "@loopover/mcp", version: "3.15.2", transport: { type: "stdio" } }],
    ...overrides,
  });
}

describe("the anti-rot path guard (#9526)", () => {
  it("passes when every watched path exists", () => {
    expect(checkWatchedPaths({ exists: () => true })).toEqual([]);
  });

  it.each(WATCHED_PATHS)("FAILS LOUDLY when %s has been renamed away", (missing) => {
    const problems = checkWatchedPaths({ exists: (path) => path !== missing });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.detail).toContain(missing);
    expect(problems[0]!.detail, "the message must say WHY this matters").toContain("rename");
  });

  it("reports the rot and STOPS, rather than validating fields against a file that is not there", () => {
    const problems = collectProblems({
      exists: () => false,
      readFile: () => {
        throw new Error("must not read a file the guard already reported missing");
      },
    });
    expect(problems.length).toBe(WATCHED_PATHS.length);
    expect(problems.every((problem) => problem.field === "watched-path")).toBe(true);
  });

  it("the real repository satisfies both halves", () => {
    expect(collectProblems()).toEqual([]);
  });
});

describe("manifest field validation (#9526)", () => {
  it("accepts a manifest that agrees with the shipped package", () => {
    expect(checkServerManifest(manifest(), MCP_PACKAGE)).toEqual([]);
  });

  it("REJECTS a version that disagrees with @loopover/mcp — release automation owns it", () => {
    // The whole point: publishing must never advertise a version nobody released.
    const problems = checkServerManifest(manifest({ version: "9.9.9" }), MCP_PACKAGE);
    expect(problems.map((problem) => problem.field)).toContain("version");
    expect(problems.find((problem) => problem.field === "version")!.detail).toContain("3.15.2");
  });

  it("REJECTS an npm package version that drifts from the top-level one", () => {
    const drifted = manifest({ packages: [{ registry_type: "npm", identifier: "@loopover/mcp", version: "3.0.0", transport: { type: "stdio" } }] });
    expect(checkServerManifest(drifted, MCP_PACKAGE).map((problem) => problem.field)).toContain("packages[0].version");
  });

  it.each([
    ["a wrong server name", { name: "io.github.someone/else" }, "name"],
    ["an empty description", { description: "   " }, "description"],
    ["a wrong repository", { repository: { url: "https://example.com", source: "gitlab" } }, "repository"],
    ["a non-streamable remote", { remotes: [{ type: "sse", url: "https://api.loopover.ai/mcp" }] }, "remotes[0]"],
    ["a remote pointing elsewhere", { remotes: [{ type: "streamable-http", url: "https://evil.example/mcp" }] }, "remotes[0]"],
    ["a non-npm package entry", { packages: [{ registry_type: "pypi", identifier: "@loopover/mcp", version: "3.15.2", transport: { type: "stdio" } }] }, "packages[0]"],
    ["a non-stdio transport", { packages: [{ registry_type: "npm", identifier: "@loopover/mcp", version: "3.15.2", transport: { type: "http" } }] }, "packages[0].transport"],
  ])("rejects %s", (_label, overrides, field) => {
    expect(checkServerManifest(manifest(overrides), MCP_PACKAGE).map((problem) => problem.field)).toContain(field);
  });

  it("rejects a SECOND remote — a second front door is one nobody tests", () => {
    const twoRemotes = manifest({
      remotes: [
        { type: "streamable-http", url: "https://api.loopover.ai/mcp" },
        { type: "streamable-http", url: "https://staging.loopover.ai/mcp" },
      ],
    });
    expect(checkServerManifest(twoRemotes, MCP_PACKAGE).map((problem) => problem.field)).toContain("remotes");
  });

  it("reports malformed JSON as one clear problem rather than throwing", () => {
    const problems = checkServerManifest("{not json", MCP_PACKAGE);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.field).toBe("server.json");
  });

  it("reports a manifest missing its sections entirely", () => {
    const problems = checkServerManifest("{}", MCP_PACKAGE);
    expect(problems.map((problem) => problem.field).sort()).toEqual(
      ["description", "name", "packages[0]", "packages[0].transport", "remotes", "remotes[0]", "repository", "version"].sort(),
    );
  });
});
