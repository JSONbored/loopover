import { describe, expect, it, vi } from "vitest";
import {
  checkReleaseLinkedVersions,
  CONFIG_PATH,
  linkedVersionGroups,
  main,
  MANIFEST_PATH,
  SHIP_AFFECTING_DEPENDENCY_FIELDS,
  type PackageManifest,
  type ReleaseConfig,
} from "../../scripts/check-release-linked-versions";

// #9749: group membership is a function of the DEPENDENCY GRAPH, not release cadence. These cases pin
// the two failures that actually happened -- contract added as a runtime dependency without joining the
// group, and a package tracked in the config but absent from the manifest.

const CONFIG: ReleaseConfig = {
  packages: {
    "packages/loopover-engine": { component: "engine", "package-name": "@loopover/engine" },
    "packages/loopover-contract": { component: "contract", "package-name": "@loopover/contract" },
    "packages/loopover-mcp": { component: "mcp", "package-name": "@loopover/mcp" },
    "packages/loopover-ui-kit": { component: "ui-kit", "package-name": "@loopover/ui-kit" },
  },
  plugins: [{ type: "node-workspace", merge: false }, { type: "linked-versions", groupName: "engine-and-dependents", components: ["engine", "contract", "mcp"] }],
};

const PACKAGES: Record<string, PackageManifest> = {
  "packages/loopover-engine": { name: "@loopover/engine" },
  "packages/loopover-contract": { name: "@loopover/contract" },
  "packages/loopover-mcp": { name: "@loopover/mcp", dependencies: { "@loopover/engine": "^3.16.0", "@loopover/contract": "^0.1.0", zod: "^4.4.3" } },
  "packages/loopover-ui-kit": { name: "@loopover/ui-kit" },
};

const MANIFEST_KEYS = Object.keys(CONFIG.packages);

describe("linkedVersionGroups", () => {
  it("maps every named component to its group and ignores non-linked-versions plugins", () => {
    const groups = linkedVersionGroups(CONFIG);
    expect(groups.get("engine")).toBe("engine-and-dependents");
    expect(groups.get("contract")).toBe("engine-and-dependents");
    expect(groups.get("ui-kit")).toBeUndefined();
  });

  it("tolerates a malformed plugin list rather than throwing on a config typo", () => {
    expect(linkedVersionGroups({ packages: {}, plugins: [null, "nope", { type: "linked-versions" }, { type: "linked-versions", components: [42, "ok"] }] as unknown[] }).get("ok")).toBe("<unnamed>");
    expect(linkedVersionGroups({ packages: {} }).size).toBe(0);
  });
});

describe("checkReleaseLinkedVersions (#9749)", () => {
  it("passes when every dependency edge sits inside one group and every package is manifest-tracked", () => {
    expect(checkReleaseLinkedVersions({ config: CONFIG, manifestKeys: MANIFEST_KEYS, packageJsons: PACKAGES })).toEqual([]);
  });

  it("REGRESSION: catches a dependency on a component left out of the group -- the #9521 gap", () => {
    const config: ReleaseConfig = { ...CONFIG, plugins: [{ type: "linked-versions", groupName: "engine-and-dependents", components: ["engine", "mcp"] }] };
    expect(checkReleaseLinkedVersions({ config, manifestKeys: MANIFEST_KEYS, packageJsons: PACKAGES })).toEqual([
      { kind: "unlinked_dependency_edge", fromPackage: "@loopover/mcp", toPackage: "@loopover/contract", field: "dependencies", fromGroup: "engine-and-dependents", toGroup: null },
    ]);
  });

  it("catches two components that are grouped, but into DIFFERENT groups", () => {
    const config: ReleaseConfig = {
      ...CONFIG,
      plugins: [
        { type: "linked-versions", groupName: "a", components: ["mcp"] },
        { type: "linked-versions", groupName: "b", components: ["engine", "contract"] },
      ],
    };
    const violations = checkReleaseLinkedVersions({ config, manifestKeys: MANIFEST_KEYS, packageJsons: PACKAGES });
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.kind === "unlinked_dependency_edge" && v.fromGroup === "a" && v.toGroup === "b")).toBe(true);
  });

  it("REGRESSION: catches a config-tracked package with no manifest entry, which sync-release-manifest silently skips", () => {
    const violations = checkReleaseLinkedVersions({ config: CONFIG, manifestKeys: MANIFEST_KEYS.filter((k) => k !== "packages/loopover-contract"), packageJsons: PACKAGES });
    expect(violations).toEqual([{ kind: "missing_manifest_entry", workspacePath: "packages/loopover-contract" }]);
  });

  it("INVARIANT: a package with no dependency edge stays ungrouped without complaint (ui-kit's whole point)", () => {
    // ui-kit is deliberately outside the group; that must never be reported, or the check would push
    // unrelated packages into permanent version lockstep.
    const violations = checkReleaseLinkedVersions({ config: CONFIG, manifestKeys: MANIFEST_KEYS, packageJsons: PACKAGES });
    expect(violations.some((v) => JSON.stringify(v).includes("ui-kit"))).toBe(false);
  });

  it("ignores edges to packages release-please does not track -- they cannot race a release", () => {
    const packageJsons = { ...PACKAGES, "packages/loopover-mcp": { name: "@loopover/mcp", dependencies: { zod: "^4.4.3", "@modelcontextprotocol/sdk": "1.29.0" } } };
    expect(checkReleaseLinkedVersions({ config: CONFIG, manifestKeys: MANIFEST_KEYS, packageJsons })).toEqual([]);
  });

  it("checks every shipping dependency field, not just `dependencies`", () => {
    for (const field of SHIP_AFFECTING_DEPENDENCY_FIELDS) {
      const packageJsons = { ...PACKAGES, "packages/loopover-ui-kit": { name: "@loopover/ui-kit", [field]: { "@loopover/engine": "^3.16.0" } } };
      const violations = checkReleaseLinkedVersions({ config: CONFIG, manifestKeys: MANIFEST_KEYS, packageJsons });
      expect(violations).toEqual([{ kind: "unlinked_dependency_edge", fromPackage: "@loopover/ui-kit", toPackage: "@loopover/engine", field, fromGroup: null, toGroup: "engine-and-dependents" }]);
    }
  });

  it("does NOT flag a devDependency edge -- deliberately excluded, since it never reaches a consumer", () => {
    const packageJsons = { ...PACKAGES, "packages/loopover-ui-kit": { name: "@loopover/ui-kit", devDependencies: { "@loopover/engine": "^3.16.0" } } };
    expect(checkReleaseLinkedVersions({ config: CONFIG, manifestKeys: MANIFEST_KEYS, packageJsons })).toEqual([]);
  });

  it("skips a tracked workspace whose package.json is unreadable rather than crashing the whole check", () => {
    const packageJsons = { ...PACKAGES, "packages/loopover-mcp": { dependencies: { "@loopover/contract": "^0.1.0" } } }; // no `name`
    expect(checkReleaseLinkedVersions({ config: CONFIG, manifestKeys: MANIFEST_KEYS, packageJsons })).toEqual([]);
  });

  it("tolerates an empty config", () => {
    expect(checkReleaseLinkedVersions({ config: { packages: {} }, manifestKeys: [], packageJsons: {} })).toEqual([]);
  });
});

describe("check-release-linked-versions main()", () => {
  const io = (files: Record<string, unknown>) => {
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    return {
      io: { readFileSync: (path: string) => JSON.stringify(files[path]), log, error, exit },
      log,
      error,
      exit,
    };
  };

  const FILES = {
    [CONFIG_PATH]: CONFIG,
    [MANIFEST_PATH]: Object.fromEntries(MANIFEST_KEYS.map((k) => [k, "1.0.0"])),
    ...Object.fromEntries(Object.entries(PACKAGES).map(([path, pkg]) => [`${path}/package.json`, pkg])),
  };

  it("exits 0 and reports the tracked count when the config is coherent", () => {
    const { io: stub, log, exit } = io(FILES);
    expect(main(stub)).toBe(0);
    expect(exit).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain("4 tracked package(s)");
  });

  it("exits 1 and names the offending edge when a dependency escapes the group", () => {
    const broken = { ...FILES, [CONFIG_PATH]: { ...CONFIG, plugins: [{ type: "linked-versions", groupName: "g", components: ["engine", "mcp"] }] } };
    const { io: stub, error, exit } = io(broken);
    expect(main(stub)).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join(" ")).toContain("@loopover/mcp depends on @loopover/contract");
  });

  it("exits 1 and explains the consequence when the manifest entry is missing", () => {
    const broken = { ...FILES, [MANIFEST_PATH]: { "packages/loopover-engine": "1.0.0" } };
    const { io: stub, error, exit } = io(broken);
    expect(main(stub)).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join(" ")).toContain("silently exempt");
  });
});
