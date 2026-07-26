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
    expect(features.paths).toEqual([".loopover.yml"]);
  });

  // #8873: bare .yml/.yaml extension must not imply "ci" — only real CI path segments.
  // Vitest-side coverage is required so codecov/patch sees both branches of kindsFromPath's CI check
  // (package-local node:test uploads are invisible to the backend vitest lcov).
  it("does not classify non-CI YAML as ci, while still classifying CI workflow YAML (#8873)", () => {
    const nonCi = extractObjectiveAnchorFeatures({
      paths: [".loopover.yml", "docs/mkdocs.yml", "config/app.yaml"],
      labels: [],
      titles: [],
      notes: [],
    });
    expect(nonCi.changeKinds).not.toContain("ci");
    expect(nonCi.changeKinds).toContain("config");
    expect(nonCi.changeKinds).toContain("docs");

    const ciWorkflow = extractObjectiveAnchorFeatures({
      paths: [".github/workflows/ci.yml"],
      labels: [],
      titles: [],
      notes: [],
    });
    expect(ciWorkflow.changeKinds).toContain("ci");
  });
});
