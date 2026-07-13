import { describe, expect, it } from "vitest";
import { extractObjectiveAnchorFeatures } from "../../packages/gittensory-engine/src/objective-anchor";

// packages/gittensory-engine/src/objective-anchor.ts's CONFIG_FILENAMES set is exercised almost
// exclusively by its own node:test suite (invisible to Codecov's vitest-based coverage), so the
// #4773 dual-read addition of ".loopover.yml" alongside ".gittensory.yml" needs a real vitest-side
// assertion, not just a top-level module-load hit.
describe("gittensory-engine objective-anchor config-filename classification (#4773)", () => {
  it("classifies both .loopover.yml and .gittensory.yml as a 'config' change kind", () => {
    const features = extractObjectiveAnchorFeatures({
      paths: [".loopover.yml", ".gittensory.yml"],
      labels: [],
      titles: [],
      notes: [],
    });

    expect(features.changeKinds).toContain("config");
    expect(features.paths).toEqual([".gittensory.yml", ".loopover.yml"]);
  });
});
