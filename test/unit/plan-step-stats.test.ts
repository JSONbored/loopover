import { describe, expect, it } from "vitest";

import { countPlanStepsByStatus } from "../../packages/gittensory-engine/src/plan-step-stats";
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

describe("countPlanStepsByStatus", () => {
  it("returns zero for an empty plan", () => {
    expect(countPlanStepsByStatus({ steps: [] }, "pending")).toBe(0);
  });

  it("counts only steps that match the requested status", () => {
    const plan = {
      steps: [
        step({ id: "a", title: "Build", status: "completed" }),
        step({ id: "b", title: "Test", status: "pending" }),
        step({ id: "c", title: "Deploy", status: "pending" }),
        step({ id: "d", title: "Verify", status: "failed" }),
      ],
    };
    expect(countPlanStepsByStatus(plan, "pending")).toBe(2);
    expect(countPlanStepsByStatus(plan, "completed")).toBe(1);
    expect(countPlanStepsByStatus(plan, "failed")).toBe(1);
    expect(countPlanStepsByStatus(plan, "running")).toBe(0);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.countPlanStepsByStatus).toBe("function");
    expect(
      barrel.countPlanStepsByStatus(
        { steps: [step({ id: "a", title: "A", status: "skipped" })] },
        "skipped",
      ),
    ).toBe(1);
  });
});
