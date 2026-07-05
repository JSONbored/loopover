import { describe, expect, it } from "vitest";

import { hasPlanPendingSteps } from "../../packages/gittensory-engine/src/plan-pending";
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

describe("hasPlanPendingSteps", () => {
  it("returns false for an empty plan", () => {
    expect(hasPlanPendingSteps({ steps: [] })).toBe(false);
  });

  it("returns false when no step is pending", () => {
    expect(
      hasPlanPendingSteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "failed" }),
        ],
      }),
    ).toBe(false);
  });

  it("returns true when at least one step is pending", () => {
    expect(
      hasPlanPendingSteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "pending" }),
        ],
      }),
    ).toBe(true);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.hasPlanPendingSteps).toBe("function");
    expect(
      barrel.hasPlanPendingSteps({
        steps: [step({ id: "a", title: "A", status: "pending" })],
      }),
    ).toBe(true);
  });
});
