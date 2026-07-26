import { describe, expect, it } from "vitest";
import { extractObjectiveAnchorFeatures } from "../../packages/loopover-engine/src/objective-anchor";

// packages/loopover-engine/src/objective-anchor.ts's CONFIG_FILENAMES set is exercised almost
// exclusively by its own node:test suite (invisible to Codecov's vitest-based coverage), so
// classifying ".loopover.yml" needs a real vitest-side assertion, not just a top-level module-load hit.
describe("loopover-engine objective-anchor config-filename classification", () => {
  it("classifies .loopover.yml as a 'config' change kind", () => {
    const features = extractObjectiveAnchorFeatures({
      paths: [".loopover.yml"],
      labels: [],
      titles: [],
      notes: [],
    });

    expect(features.changeKinds).toContain("config");
    // #8873: a config YAML at the repo root must NOT be tagged "ci" purely by its extension.
    expect(features.changeKinds).not.toContain("ci");
    expect(features.paths).toEqual([".loopover.yml"]);
  });

  // The dependency check must use the same exact-match discipline as the adjacent CONFIG_FILENAMES
  // check: an anchored /^package(?:-lock)?\.json$/ so a differently-prefixed sibling is NOT tagged
  // "dependency" (#8874). Exercised on the vitest side because Codecov grades this file via vitest.
  it("tags only exact package(.-lock).json as a 'dependency' change kind, not a prefixed sibling (#8874)", () => {
    const dependency = extractObjectiveAnchorFeatures({
      paths: ["package.json", "package-lock.json"],
      labels: [],
      titles: [],
      notes: [],
    });
    expect(dependency.changeKinds).toContain("dependency");

    const notDependency = extractObjectiveAnchorFeatures({
      paths: ["sub-package.json", "mock-package.json"],
      labels: [],
      titles: [],
      notes: [],
    });
    expect(notDependency.changeKinds).not.toContain("dependency");
  });

  it("does NOT tag a non-CI YAML file (docs/mkdocs.yml) as a 'ci' change kind (#8873)", () => {
    const features = extractObjectiveAnchorFeatures({ paths: ["docs/mkdocs.yml"], labels: [], titles: [], notes: [] });
    expect(features.changeKinds).not.toContain("ci");
  });

  it("still tags a YAML under a real CI path segment (.github/workflows/ci.yml) as 'ci' (#8873)", () => {
    const features = extractObjectiveAnchorFeatures({ paths: [".github/workflows/ci.yml"], labels: [], titles: [], notes: [] });
    expect(features.changeKinds).toContain("ci");
  });
});
