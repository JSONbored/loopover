import { describe, expect, it } from "vitest";

import * as barrel from "../../packages/gittensory-engine/src/index";
import { classifyTestCoverage, isTestPath } from "../../packages/gittensory-engine/src/test-evidence";
import { computeLocalScorerTokens } from "../../packages/gittensory-engine/src/local-scorer";

describe("engine test-evidence extraction (#2277)", () => {
  it("exports test-evidence helpers from the engine barrel", () => {
    expect(typeof barrel.isTestPath).toBe("function");
    expect(typeof barrel.classifyTestCoverage).toBe("function");
    expect(typeof barrel.computeLocalScorerTokens).toBe("function");
  });

  it("classifies coverage from engine-local helpers", () => {
    expect(isTestPath("src/widget.test.ts")).toBe(true);
    expect(classifyTestCoverage(["src/a.ts", "src/a.test.ts"])).toBe("adequate");
  });

  it("scores local metadata from the engine local-scorer port", () => {
    const scorer = computeLocalScorerTokens({
      changedFiles: [{ path: "src/a.ts", additions: 4 }],
    });
    expect(scorer.sourceTokenScore).toBe(4);
  });
});
