import { describe, expect, it } from "vitest";

import { countPlanReadySteps, hasPlanReadySteps } from "../../packages/gittensory-engine/src/plan-ready";
import type { PlanStep } from "../../packages/gittensory-engine/src/plan-export";
import { nextReadySteps } from "../../src/services/plan-dag";

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

describe("countPlanReadySteps", () => {
  it("returns zero for an empty plan", () => {
    expect(countPlanReadySteps({ steps: [] })).toBe(0);
    expect(hasPlanReadySteps({ steps: [] })).toBe(false);
  });

  it("returns one when a single pending step has no dependencies", () => {
    const plan = { steps: [step({ id: "a", title: "Build", status: "pending" })] };
    expect(countPlanReadySteps(plan)).toBe(1);
    expect(hasPlanReadySteps(plan)).toBe(true);
  });

  it("returns two when two independent pending steps are ready", () => {
    const plan = {
      steps: [
        step({ id: "a", title: "Build", status: "pending" }),
        step({ id: "b", title: "Lint", status: "pending" }),
      ],
    };
    expect(countPlanReadySteps(plan)).toBe(2);
  });

  it("returns one when only the root pending step is ready in a chain", () => {
    const plan = {
      steps: [
        step({ id: "a", title: "Build", status: "pending" }),
        step({ id: "b", title: "Test", status: "pending", dependsOn: ["a"] }),
      ],
    };
    expect(countPlanReadySteps(plan)).toBe(1);
  });

  it("returns one when a pending step's dependencies are satisfied", () => {
    const plan = {
      steps: [
        step({ id: "a", title: "Build", status: "completed" }),
        step({ id: "b", title: "Test", status: "pending", dependsOn: ["a"] }),
      ],
    };
    expect(countPlanReadySteps(plan)).toBe(1);
  });

  it("returns zero for a cyclic deadlock with no ready steps", () => {
    const plan = {
      steps: [
        step({ id: "a", title: "A", dependsOn: ["b"] }),
        step({ id: "b", title: "B", dependsOn: ["a"] }),
      ],
    };
    expect(countPlanReadySteps(plan)).toBe(0);
    expect(hasPlanReadySteps(plan)).toBe(false);
  });

  it("returns zero when a pending step depends on a missing step id", () => {
    const plan = { steps: [step({ id: "a", title: "A", dependsOn: ["ghost"] })] };
    expect(countPlanReadySteps(plan)).toBe(0);
  });

  it("returns zero when every step is completed or skipped", () => {
    const plan = {
      steps: [
        step({ id: "a", title: "Build", status: "completed" }),
        step({ id: "b", title: "Deploy", status: "skipped" }),
      ],
    };
    expect(countPlanReadySteps(plan)).toBe(0);
  });

  it("returns zero when only running or failed steps remain", () => {
    const plan = {
      steps: [
        step({ id: "a", title: "Build", status: "running" }),
        step({ id: "b", title: "Deploy", status: "failed" }),
      ],
    };
    expect(countPlanReadySteps(plan)).toBe(0);
  });

  it("matches hosted nextReadySteps(plan).length on shared fixtures", () => {
    const plan = {
      steps: [
        step({ id: "a", title: "Build", status: "completed" }),
        step({ id: "b", title: "Test", status: "pending", dependsOn: ["a"] }),
        step({ id: "c", title: "Deploy", status: "pending", dependsOn: ["b"] }),
      ],
    };
    expect(countPlanReadySteps(plan)).toBe(nextReadySteps(plan).length);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.countPlanReadySteps).toBe("function");
    expect(
      barrel.countPlanReadySteps({
        steps: [step({ id: "a", title: "A", status: "pending" })],
      }),
    ).toBe(1);
  });
});
