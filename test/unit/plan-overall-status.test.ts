import { describe, expect, it } from "vitest";

import { resolvePlanOverallStatus } from "../../packages/gittensory-engine/src/plan-overall-status";
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

describe("resolvePlanOverallStatus", () => {
  it("returns pending for an empty plan", () => {
    expect(resolvePlanOverallStatus({ steps: [] })).toBe("pending");
  });

  it("returns completed when every step is completed or skipped", () => {
    expect(
      resolvePlanOverallStatus({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "skipped" }),
        ],
      }),
    ).toBe("completed");
  });

  it("returns failed when any step failed", () => {
    expect(
      resolvePlanOverallStatus({
        steps: [
          step({ id: "a", title: "Build", status: "running" }),
          step({ id: "b", title: "Deploy", status: "failed" }),
        ],
      }),
    ).toBe("failed");
  });

  it("returns running when a step is in flight and none failed", () => {
    expect(
      resolvePlanOverallStatus({
        steps: [
          step({ id: "a", title: "Build", status: "running" }),
          step({ id: "b", title: "Test", status: "pending" }),
        ],
      }),
    ).toBe("running");
  });

  it("returns blocked for a cyclic deadlock with no ready steps", () => {
    expect(
      resolvePlanOverallStatus({
        steps: [
          step({ id: "a", title: "A", dependsOn: ["b"] }),
          step({ id: "b", title: "B", dependsOn: ["a"] }),
        ],
      }),
    ).toBe("blocked");
  });

  it("returns blocked when a pending step depends on a missing step id", () => {
    expect(
      resolvePlanOverallStatus({
        steps: [step({ id: "a", title: "A", dependsOn: ["ghost"] })],
      }),
    ).toBe("blocked");
  });

  it("returns pending when runnable steps remain", () => {
    expect(
      resolvePlanOverallStatus({
        steps: [
          step({ id: "a", title: "Build", status: "pending" }),
          step({ id: "b", title: "Test", status: "pending", dependsOn: ["a"] }),
        ],
      }),
    ).toBe("pending");
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.resolvePlanOverallStatus).toBe("function");
    expect(
      barrel.resolvePlanOverallStatus({
        steps: [step({ id: "a", title: "A", status: "completed" })],
      }),
    ).toBe("completed");
  });
});
