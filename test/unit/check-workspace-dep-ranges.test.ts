import { describe, expect, it } from "vitest";
import { findWorkspaceRangeDrift, type WorkspaceManifest } from "../../scripts/check-workspace-dep-ranges";

// apps/loopover-ui declared "@loopover/contract": "^0.1.0". That matched while contract sat at 0.1.0, so npm
// linked the workspace copy. The moment release-please bumped contract to 3.17.0 the range stopped matching
// and npm — without failing — resolved it from the REGISTRY instead, installing the published 0.1.0 tarball
// while every other consumer used 3.17.0. It surfaced only as an opaque `npm ci` lockfile-sync error.

describe("findWorkspaceRangeDrift", () => {
  it("REGRESSION: reproduces the real drift — a range the bumped workspace version no longer satisfies", () => {
    const manifests: WorkspaceManifest[] = [
      { name: "@loopover/contract", version: "3.17.0" },
      { name: "@loopover/mcp", version: "3.17.0", dependencies: { "@loopover/contract": "^0.1.0" } },
    ];
    const violations = findWorkspaceRangeDrift(manifests);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ consumer: "@loopover/mcp", dependency: "@loopover/contract", workspaceVersion: "3.17.0" });
    expect(violations[0]?.reason).toContain("silently install a published copy");
  });

  it("REGRESSION: catches the trap BEFORE the bump springs it, for a private consumer", () => {
    // The decisive case. At contract@0.1.0 the range is satisfied, so a satisfaction-only check sees nothing
    // and the bug lands later, in a release PR, disguised as a lockfile problem. A private app gains nothing
    // from a range, so requiring "*" makes the problem visible while it is still cheap to fix.
    const manifests: WorkspaceManifest[] = [
      { name: "@loopover/contract", version: "0.1.0" },
      { name: "@loopover/ui", version: "0.0.0", private: true, dependencies: { "@loopover/contract": "^0.1.0" } },
    ];
    const violations = findWorkspaceRangeDrift(manifests);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("is private");
  });

  it('"*" is accepted — it is the only range that cannot drift', () => {
    const manifests: WorkspaceManifest[] = [
      { name: "@loopover/contract", version: "3.17.0" },
      { name: "@loopover/ui", version: "0.0.0", private: true, dependencies: { "@loopover/contract": "*" } },
    ];
    expect(findWorkspaceRangeDrift(manifests)).toEqual([]);
  });

  it("a PUBLISHED package keeps a real range, and a matching one passes", () => {
    // Published packages must not use "*" — consumers install them from npm and need a meaningful range —
    // so for them the rule is only that the range actually matches.
    const manifests: WorkspaceManifest[] = [
      { name: "@loopover/engine", version: "3.17.0" },
      { name: "@loopover/mcp", version: "3.17.0", dependencies: { "@loopover/engine": "^3.17.0" } },
    ];
    expect(findWorkspaceRangeDrift(manifests)).toEqual([]);
  });

  it("third-party dependencies are ignored entirely", () => {
    const manifests: WorkspaceManifest[] = [{ name: "@loopover/mcp", version: "1.0.0", dependencies: { zod: "^4.0.0", "posthog-node": "^5.0.0" } }];
    expect(findWorkspaceRangeDrift(manifests)).toEqual([]);
  });

  it("an unparseable range is reported rather than silently skipped", () => {
    const manifests: WorkspaceManifest[] = [
      { name: "@loopover/engine", version: "3.17.0" },
      { name: "@loopover/mcp", version: "1.0.0", dependencies: { "@loopover/engine": "not-a-range" } },
    ];
    expect(findWorkspaceRangeDrift(manifests)[0]?.reason).toContain("not a valid semver range");
  });

  it("devDependencies are checked too — a stale one still resolves from the registry at build time", () => {
    const manifests: WorkspaceManifest[] = [
      { name: "@loopover/engine", version: "3.17.0" },
      { name: "@loopover/mcp", version: "1.0.0", devDependencies: { "@loopover/engine": "^1.0.0" } },
    ];
    expect(findWorkspaceRangeDrift(manifests)).toHaveLength(1);
  });

  it("INVARIANT: this repo's own workspace is clean", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const manifests: WorkspaceManifest[] = [];
    for (const group of ["packages", "apps"]) {
      for (const entry of readdirSync(group, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          manifests.push(JSON.parse(readFileSync(`${group}/${entry.name}/package.json`, "utf8")) as WorkspaceManifest);
        } catch {
          // not a workspace package
        }
      }
    }
    expect(findWorkspaceRangeDrift(manifests)).toEqual([]);
  });
});
