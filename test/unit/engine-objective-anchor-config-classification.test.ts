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

  it("does NOT tag a non-CI YAML file (docs/mkdocs.yml) as a 'ci' change kind (#8873)", () => {
    const features = extractObjectiveAnchorFeatures({ paths: ["docs/mkdocs.yml"], labels: [], titles: [], notes: [] });
    expect(features.changeKinds).not.toContain("ci");
  });

  it("still tags a YAML under a real CI path segment (.github/workflows/ci.yml) as 'ci' (#8873)", () => {
    const features = extractObjectiveAnchorFeatures({ paths: [".github/workflows/ci.yml"], labels: [], titles: [], notes: [] });
    expect(features.changeKinds).toContain("ci");
  });
});
