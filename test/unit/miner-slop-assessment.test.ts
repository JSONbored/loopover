import { describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import { runSlopAssessment } from "../../packages/loopover-miner/lib/slop-assessment";
import { buildSlopAssessment } from "../../packages/loopover-engine/src/index";

describe("runSlopAssessment (#5133)", () => {
  it("is a real, non-stub binding: identical input produces the identical result buildSlopAssessment itself would (clean case)", () => {
    const input = { changedFiles: [{ path: "src/widget.ts", additions: 5, deletions: 1 }], testFiles: ["test/widget.test.ts"], description: "Fixes the widget bug." };
    expect(runSlopAssessment(input)).toEqual(buildSlopAssessment(input));
    expect(runSlopAssessment(input).band).toBe("clean");
  });

  it("real scoring: a large diff with no tests and an empty description scores non-clean", () => {
    const input = {
      changedFiles: [{ path: "src/widget.ts", additions: 200, deletions: 0 }],
      description: "",
    };
    const result = runSlopAssessment(input);
    expect(result.slopRisk).toBeGreaterThan(0);
    expect(result.band).not.toBe("clean");
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("empty input produces a clean assessment with no findings", () => {
    expect(runSlopAssessment({})).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });
});
