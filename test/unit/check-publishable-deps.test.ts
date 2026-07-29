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
  it("derives the published set from the workflows themselves, not from filenames or a hand-kept list", () => {
    // `publish-ui-kit.yml` publishes `@loopover/ui-kit`; a future workflow could name its package anything,
    // so the mapping is read from the file rather than inferred from the slug.
    const names = publishedPackageNames([
      { name: "publish-ui-kit.yml", text: "run: npm run test --workspace @loopover/ui-kit" },
      { name: "publish-engine.yml", text: "npm pack --workspace @loopover/engine --json" },
    ]);
    expect([...names].sort()).toEqual(["@loopover/engine", "@loopover/ui-kit"]);
  });

  it("ignores workflows that are not publish-*, so a CI file mentioning a package cannot fake it published", () => {
    const names = publishedPackageNames([
      { name: "ci.yml", text: "npm run build --workspace @loopover/contract" },
      { name: "release-selfhost.yml", text: "@loopover/engine" },
    ]);
    expect(names.size).toBe(0);
  });

  it("accepts both .yml and .yaml, and dedupes repeated mentions within one workflow", () => {
    const names = publishedPackageNames([
      { name: "publish-mcp.yaml", text: "@loopover/mcp ... @loopover/mcp ... @loopover/mcp" },
    ]);
    expect([...names]).toEqual(["@loopover/mcp"]);
  });
});
