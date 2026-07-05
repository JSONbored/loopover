import { describe, expect, it } from "vitest";

import { countPlanSteps } from "../../packages/gittensory-engine/src/plan-step-count";
import type { PlanStep } from "../../packages/gittensory-engine/src/plan-export";

function step(over: Partial<PlanStep> & { id: string; title: string }): PlanStep {
  return {
    actionClass: undefined,
    dependsOn: [],
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    ...over,
  };
}

describe("countPlanSteps", () => {
  it("returns zero for an empty plan", () => {
    expect(countPlanSteps({ steps: [] })).toBe(0);
  });

  it("returns the total number of steps regardless of status", () => {
    expect(
      countPlanSteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "pending" }),
          step({ id: "c", title: "Deploy", status: "failed" }),
        ],
      }),
    ).toBe(3);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.countPlanSteps).toBe("function");
    expect(
      barrel.countPlanSteps({
        steps: [step({ id: "a", title: "A" }), step({ id: "b", title: "B" })],
      }),
    ).toBe(2);
  });
});
