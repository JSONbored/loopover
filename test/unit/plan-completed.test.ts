import { describe, expect, it } from "vitest";

import { hasPlanCompletedSteps } from "../../packages/gittensory-engine/src/plan-completed";
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

describe("hasPlanCompletedSteps", () => {
  it("returns false for an empty plan", () => {
    expect(hasPlanCompletedSteps({ steps: [] })).toBe(false);
  });

  it("returns false when no step is completed", () => {
    expect(
      hasPlanCompletedSteps({
        steps: [
          step({ id: "a", title: "Build", status: "pending" }),
          step({ id: "b", title: "Test", status: "running" }),
        ],
      }),
    ).toBe(false);
  });

  it("returns true when at least one step is completed", () => {
    expect(
      hasPlanCompletedSteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "pending" }),
        ],
      }),
    ).toBe(true);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.hasPlanCompletedSteps).toBe("function");
    expect(
      barrel.hasPlanCompletedSteps({
        steps: [step({ id: "a", title: "A", status: "completed" })],
      }),
    ).toBe(true);
  });
});
