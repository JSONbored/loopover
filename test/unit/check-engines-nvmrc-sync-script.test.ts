import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { checkEnginesNvmrcSync } from "../../scripts/check-engines-nvmrc-sync.js";

describe("check-engines-nvmrc-sync script", () => {
  /** Builds `{ readFile, listDir }` fakes from a flat `{ "group/name/package.json": jsonString }` map
   *  (plus a top-level "package.json" and ".nvmrc" entry) -- workspace directory names are derived from
   *  the map's own keys, so a test only has to describe the files it cares about. */
  function makeFakeRepo(nvmrc: string, packages: Record<string, string>) {
    const files: Record<string, string> = { ".nvmrc": nvmrc, ...packages };
    const dirsByGroup: Record<string, Set<string>> = { apps: new Set(), packages: new Set() };
    for (const path of Object.keys(packages)) {
      if (path === "package.json") continue;
      const [group, name] = path.split("/");
      if (group && name) dirsByGroup[group]?.add(name);
    }

    const readFile = (_root: string, relativePath: string): string => {
      const content = files[relativePath];
      if (content === undefined) throw new Error(`ENOENT: ${relativePath}`);
      return content;
    };
    const listDir = (_root: string, relativePath: string): string[] => {
      const names = dirsByGroup[relativePath];
      if (!names) throw new Error(`ENOENT: ${relativePath}`);
      return [...names];
    };
    return { readFile, listDir };
  }

  it("passes cleanly when every engines.node range excludes the next major", () => {
    const { readFile, listDir } = makeFakeRepo("22\n", {
      "package.json": JSON.stringify({ engines: { node: ">=22.0.0 <23.0.0" } }),
      "packages/foo/package.json": JSON.stringify({ engines: { node: ">=22.13.0 <23.0.0" } }),
    });

    const result = checkEnginesNvmrcSync({ root: "/fake", readFile, listDir });

    expect(result.failures).toEqual([]);
    expect(result.nvmrcMajor).toBe(22);
    expect(result.checkedPackages).toEqual(["package.json", "packages/foo/package.json"]);
  });

  it("catches an open-ended range that still allows the next major (the original bug shape)", () => {
    const { readFile, listDir } = makeFakeRepo("22\n", {
      "package.json": JSON.stringify({ engines: { node: ">=22.0.0" } }),
    });

    const result = checkEnginesNvmrcSync({ root: "/fake", readFile, listDir });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("package.json");
    expect(result.failures[0]).toContain("23.0.0");
  });

  it("skips a workspace package.json that declares no engines field at all", () => {
    const { readFile, listDir } = makeFakeRepo("22\n", {
      "package.json": JSON.stringify({ engines: { node: ">=22.0.0 <23.0.0" } }),
      "apps/no-engines/package.json": JSON.stringify({ name: "no-engines" }),
    });

    const result = checkEnginesNvmrcSync({ root: "/fake", readFile, listDir });

    expect(result.failures).toEqual([]);
    expect(result.checkedPackages).toEqual(["package.json"]);
  });

  it("skips a workspace directory whose package.json is missing/unreadable instead of failing", () => {
    const { readFile, listDir } = makeFakeRepo("22\n", {
      "package.json": JSON.stringify({ engines: { node: ">=22.0.0 <23.0.0" } }),
    });
    // "stray-dir" is listed by listDir but was never registered in the fake's `files` map, so reading
    // its package.json throws -- simulates a workspace folder with no manifest yet.
    const listDirWithStrayDir = (root: string, relativePath: string): string[] =>
      relativePath === "apps" ? ["stray-dir"] : listDir(root, relativePath);

    const result = checkEnginesNvmrcSync({ root: "/fake", readFile, listDir: listDirWithStrayDir });

    expect(result.failures).toEqual([]);
    expect(result.checkedPackages).toEqual(["package.json"]);
  });

  it("flags an engines.node value that isn't a valid semver range", () => {
    const { readFile, listDir } = makeFakeRepo("22\n", {
      "package.json": JSON.stringify({ engines: { node: "not-a-range" } }),
    });

    const result = checkEnginesNvmrcSync({ root: "/fake", readFile, listDir });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("not a valid semver range");
  });

  it("tolerates a v-prefixed, whitespace-padded .nvmrc", () => {
    const { readFile, listDir } = makeFakeRepo("  v22 \n", {
      "package.json": JSON.stringify({ engines: { node: ">=22.0.0 <23.0.0" } }),
    });

    const result = checkEnginesNvmrcSync({ root: "/fake", readFile, listDir });

    expect(result.nvmrcMajor).toBe(22);
    expect(result.failures).toEqual([]);
  });

  it("throws when .nvmrc content isn't a valid major version number", () => {
    const { readFile, listDir } = makeFakeRepo("lts/jod\n", {
      "package.json": JSON.stringify({}),
    });

    expect(() => checkEnginesNvmrcSync({ root: "/fake", readFile, listDir })).toThrow(
      /does not start with a valid major version number/,
    );
  });

  it("returns no failures when neither apps/ nor packages/ exist (root-only check)", () => {
    const readFile = (_root: string, relativePath: string): string => {
      if (relativePath === ".nvmrc") return "22\n";
      if (relativePath === "package.json") return JSON.stringify({ engines: { node: ">=22.0.0 <23.0.0" } });
      throw new Error(`ENOENT: ${relativePath}`);
    };
    const listDir = (): string[] => {
      throw new Error("ENOENT");
    };

    const result = checkEnginesNvmrcSync({ root: "/fake", readFile, listDir });

    expect(result.failures).toEqual([]);
    expect(result.checkedPackages).toEqual(["package.json"]);
  });

  // Most important regression test in this file: proves the REAL current repo state (root + every real
  // apps/packages workspace's actual engines.node, against the real .nvmrc) is compliant, using the real
  // filesystem against the real repo root. If this fails, something has genuinely drifted apart -- the
  // check must not be weakened to make this test pass.
  it("the real repo's engines.node ranges all agree with .nvmrc (regression guard)", () => {
    const result = checkEnginesNvmrcSync({ root: process.cwd() });

    expect(result.failures).toEqual([]);
    expect(result.checkedPackages.length).toBeGreaterThan(0);
  });

  it("prints a clean summary and exits 0 for the real repo state when run as a subprocess", () => {
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/check-engines-nvmrc-sync.ts"], { encoding: "utf8" });

    expect(output).toMatch(/Engines\/\.nvmrc sync check ok: \d+ package\(s\)/);
  });
});
