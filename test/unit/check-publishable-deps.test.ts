import { describe, expect, it } from "vitest";
import { findPublishableDepViolations, publishedPackageNames } from "../../scripts/check-publishable-deps";

// #9749: @loopover/contract became a runtime dependency of two PUBLISHED CLIs but had no publish workflow,
// so it was never on npm. The failure is invisible until the next release — the already-published versions
// predate the dependency and install fine — and by the time a user hits E404 the broken version is public
// and immutable. These pin the check that catches it at the moment the dependency is added.

const PUBLISHED = new Set(["@loopover/mcp", "@loopover/miner", "@loopover/engine"]);

describe("findPublishableDepViolations (#9749)", () => {
  it("REGRESSION: reproduces the real bug — a published CLI depending on an unpublished workspace package", () => {
    const violations = findPublishableDepViolations(
      [
        { name: "@loopover/mcp", dependencies: { "@loopover/contract": "^0.1.0", zod: "^4.0.0" } },
        { name: "@loopover/miner", dependencies: { "@loopover/contract": "^0.1.0" } },
        { name: "@loopover/contract", dependencies: {} },
      ],
      PUBLISHED,
    );
    expect(violations.map((violation) => violation.publishedPackage)).toEqual(["@loopover/mcp", "@loopover/miner"]);
    expect(violations[0]).toMatchObject({ dependency: "@loopover/contract", range: "^0.1.0" });
    expect(violations[0]?.reason).toContain("not published to npm");
  });

  it("passes once the dependency itself becomes published — the fix, not just the detection", () => {
    const violations = findPublishableDepViolations(
      [
        { name: "@loopover/mcp", dependencies: { "@loopover/contract": "^0.1.0" } },
        { name: "@loopover/contract", dependencies: {} },
      ],
      new Set([...PUBLISHED, "@loopover/contract"]),
    );
    expect(violations).toEqual([]);
  });

  it("REGRESSION: a PRIVATE dependency is a distinct, harder failure and says so", () => {
    // Adding a publish workflow fixes the unpublished case; it cannot fix this one, so the message must
    // not send someone down that path.
    const violations = findPublishableDepViolations(
      [
        { name: "@loopover/mcp", dependencies: { "@loopover/internal": "^1.0.0" } },
        { name: "@loopover/internal", private: true },
      ],
      PUBLISHED,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("private and can never be published");
  });

  it("ignores devDependencies — they never ship in the tarball, so they cannot break an install", () => {
    const violations = findPublishableDepViolations(
      [{ name: "@loopover/mcp", dependencies: { zod: "^4.0.0" } }, { name: "@loopover/contract" }],
      PUBLISHED,
    );
    expect(violations).toEqual([]);
  });

  it("ignores third-party dependencies and UNPUBLISHED packages' own dependencies", () => {
    const violations = findPublishableDepViolations(
      [
        // Third-party: on npm by definition of being installable at all.
        { name: "@loopover/mcp", dependencies: { zod: "^4.0.0", "posthog-node": "^5.0.0" } },
        // An unpublished package may depend on whatever it likes -- no user ever installs it directly.
        { name: "@loopover/ui", dependencies: { "@loopover/contract": "^0.1.0" } },
        { name: "@loopover/contract" },
      ],
      PUBLISHED,
    );
    expect(violations).toEqual([]);
  });

  it("an empty workspace is not a violation", () => {
    expect(findPublishableDepViolations([], PUBLISHED)).toEqual([]);
    expect(findPublishableDepViolations([{ dependencies: { "@loopover/contract": "^0.1.0" } }], PUBLISHED)).toEqual([]);
  });
});

describe("publishedPackageNames (#9749)", () => {
  it("reads the package a workflow actually PACKS, not the filename slug", () => {
    // `publish-ui-kit.yml` publishes `@loopover/ui-kit`; the mapping is read from the file so a future
    // workflow can name its package anything.
    const names = publishedPackageNames([
      { name: "publish-ui-kit.yml", text: 'PACK_JSON="$(npm pack --workspace @loopover/ui-kit --json)"' },
      { name: "publish-engine.yml", text: 'npm pack --workspace @loopover/engine --pack-destination "$RUNNER_TEMP" --json' },
    ]);
    expect([...names].sort()).toEqual(["@loopover/engine", "@loopover/ui-kit"]);
  });

  it("REGRESSION: a package merely BUILT by another workflow is not treated as published", () => {
    // Review caught this: deriving from any `@loopover/*` mention meant a publish workflow's own build step
    // could silently mark an unpublished package releasable, masking the exact violation this check exists
    // to catch. publish-contract.yml really does contain such a line for itself, and publish workflows
    // routinely build sibling packages.
    const names = publishedPackageNames([
      {
        name: "publish-mcp.yml",
        text: [
          "npx turbo run build --filter=@loopover/contract",
          "npm run build --workspace @loopover/engine",
          "run: npm run test --workspace @loopover/ui-kit",
          'PACK_JSON="$(npm pack --workspace @loopover/mcp --json)"',
        ].join("\n"),
      },
    ]);
    // ONLY the packed package. The three built/tested siblings are not published by this workflow.
    expect([...names]).toEqual(["@loopover/mcp"]);
  });

  it("a publish workflow with no recognizable pack line contributes NOTHING, never a looser guess", () => {
    // An unreadable workflow must make the check stricter, not quietly more permissive.
    const names = publishedPackageNames([{ name: "publish-broken.yml", text: "echo @loopover/engine # no pack line" }]);
    expect(names.size).toBe(0);
  });

  it("ignores workflows that are not publish-*, so a CI file mentioning a package cannot fake it published", () => {
    const names = publishedPackageNames([
      { name: "ci.yml", text: "npm pack --workspace @loopover/contract" },
      { name: "release-selfhost.yml", text: "npm pack --workspace @loopover/engine" },
    ]);
    expect(names.size).toBe(0);
  });

  it("accepts both .yml and .yaml, and dedupes a package packed more than once", () => {
    const names = publishedPackageNames([
      { name: "publish-mcp.yaml", text: "npm pack --workspace @loopover/mcp\nnpm pack --workspace @loopover/mcp" },
    ]);
    expect([...names]).toEqual(["@loopover/mcp"]);
  });

  it("INVARIANT: every real publish workflow yields at most one package, and only the npm ones yield any", async () => {
    // Guards the assumption the hardening rests on: a publish workflow packs precisely the one package it
    // publishes. Two ways that can rot, both caught here rather than by silently changing what the check
    // considers published:
    //   - a workflow packing TWO packages (the pack line stops being a unique signal), or
    //   - a workflow that SHOULD pack but no longer matches (a reformatted pack line), which would quietly
    //     drop a real package out of the published set and take its dependency violations with it.
    // publish-mcp-registry.yml legitimately yields zero: it publishes to the MCP *registry*, not to npm, so
    // it packs no tarball. It is named explicitly so that a NEW zero-yield workflow fails instead of being
    // waved through as "probably another registry one".
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = ".github/workflows";
    const files = readdirSync(dir)
      .filter((name) => /^publish-.+\.ya?ml$/.test(name))
      .map((name) => ({ name, text: readFileSync(`${dir}/${name}`, "utf8") }));
    expect(files.length).toBeGreaterThan(0);

    const packed = files.map((file) => ({ file: file.name, packages: [...publishedPackageNames([file])] }));
    for (const entry of packed) {
      expect({ file: entry.file, count: entry.packages.length }).toEqual({ file: entry.file, count: entry.packages.length > 0 ? 1 : 0 });
      expect(entry.packages.length).toBeLessThanOrEqual(1);
    }
    expect(packed.filter((entry) => entry.packages.length === 0).map((entry) => entry.file)).toEqual(["publish-mcp-registry.yml"]);
    // And the npm-publishing set is exactly the workspace packages that are actually on npm.
    expect(packed.flatMap((entry) => entry.packages).sort()).toEqual([
      "@loopover/contract",
      "@loopover/engine",
      "@loopover/mcp",
      "@loopover/miner",
      "@loopover/ui-kit",
    ]);
  });
});
