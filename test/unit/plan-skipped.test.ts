import { describe, expect, it } from "vitest";

import { hasPlanSkippedSteps } from "../../packages/gittensory-engine/src/plan-skipped";
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

describe("hasPlanSkippedSteps", () => {
  it("returns false for an empty plan", () => {
    expect(hasPlanSkippedSteps({ steps: [] })).toBe(false);
  });

  it("returns false when no step was skipped", () => {
    expect(
      hasPlanSkippedSteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "pending" }),
        ],
      }),
    ).toBe(false);
  });

  it("returns true when at least one step was skipped", () => {
    expect(
      hasPlanSkippedSteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "skipped" }),
        ],
      }),
    ).toBe(true);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.hasPlanSkippedSteps).toBe("function");
    expect(
      barrel.hasPlanSkippedSteps({
        steps: [step({ id: "a", title: "A", status: "skipped" })],
      }),
    ).toBe(true);
  });
});
