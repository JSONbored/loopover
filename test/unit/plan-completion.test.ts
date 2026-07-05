import { describe, expect, it } from "vitest";

import { isPlanFullyCompleted } from "../../packages/gittensory-engine/src/plan-completion";
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

describe("isPlanFullyCompleted", () => {
  it("returns false for an empty plan", () => {
    expect(isPlanFullyCompleted({ steps: [] })).toBe(false);
  });

  it("returns true when every step is completed", () => {
    expect(
      isPlanFullyCompleted({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "completed" }),
        ],
      }),
    ).toBe(true);
  });

  it("returns false when any step is not completed", () => {
    expect(
      isPlanFullyCompleted({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "pending" }),
        ],
      }),
    ).toBe(false);
    expect(
      isPlanFullyCompleted({
        steps: [step({ id: "a", title: "Deploy", status: "failed" })],
      }),
    ).toBe(false);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.isPlanFullyCompleted).toBe("function");
    expect(
      barrel.isPlanFullyCompleted({
        steps: [step({ id: "a", title: "A", status: "completed" })],
      }),
    ).toBe(true);
  });
});
