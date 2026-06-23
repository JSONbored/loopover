import { describe, expect, it } from "vitest";
import { applyStepResult, buildPlanDag, markStepRunning, nextReadySteps, planProgress, validatePlanDag, type PlanDag } from "../../src/services/plan-dag";

const chain = () =>
  buildPlanDag([
    { id: "a", title: "close stale PR" },
    { id: "b", title: "land PR 2", dependsOn: ["a"] },
    { id: "c", title: "open direct PR", dependsOn: ["b"] },
  ]);

describe("plan DAG (#783)", () => {
  it("buildPlanDag normalizes defaults, clamps maxAttempts, and drops self/duplicate deps", () => {
    const plan = buildPlanDag([{ id: "a", title: "A", actionClass: "close", dependsOn: ["a", "a"], maxAttempts: 99 }]);
    expect(plan.steps[0]).toMatchObject({ status: "pending", attempts: 0, maxAttempts: 10, dependsOn: [], actionClass: "close" });
    expect(buildPlanDag([{ id: "x", title: "X", maxAttempts: 0 }]).steps[0]?.maxAttempts).toBe(1);
  });

  it("validatePlanDag flags duplicate ids, missing deps, and cycles", () => {
    expect(validatePlanDag(buildPlanDag([{ id: "a", title: "A" }, { id: "a", title: "A2" }])).errors).toContain("duplicate step ids");
    expect(validatePlanDag(buildPlanDag([{ id: "a", title: "A", dependsOn: ["ghost"] }])).valid).toBe(false);
    const cyclic: PlanDag = {
      steps: [
        { id: "a", title: "A", dependsOn: ["b"], status: "pending", attempts: 0, maxAttempts: 1 },
        { id: "b", title: "B", dependsOn: ["a"], status: "pending", attempts: 0, maxAttempts: 1 },
      ],
    };
    expect(validatePlanDag(cyclic).errors).toContain("plan has a dependency cycle");
    expect(validatePlanDag(chain())).toEqual({ valid: true, errors: [] });
  });

  it("nextReadySteps returns only steps whose dependencies are all done", () => {
    const plan = chain();
    expect(nextReadySteps(plan).map((s) => s.id)).toEqual(["a"]);
    const afterA = applyStepResult(plan, "a", { outcome: "completed" });
    expect(nextReadySteps(afterA).map((s) => s.id)).toEqual(["b"]);
  });

  it("applyStepResult: completed/skipped are terminal; failed retries then fails terminally", () => {
    let plan = buildPlanDag([{ id: "a", title: "A", maxAttempts: 2 }]);
    plan = applyStepResult(plan, "a", { outcome: "failed", error: "boom" });
    expect(plan.steps[0]).toMatchObject({ status: "pending", attempts: 1, lastError: "boom" });
    plan = applyStepResult(plan, "a", { outcome: "failed" });
    expect(plan.steps[0]).toMatchObject({ status: "failed", attempts: 2, lastError: "step failed" });
    expect(applyStepResult(buildPlanDag([{ id: "x", title: "X" }]), "x", { outcome: "skipped" }).steps[0]?.status).toBe("skipped");

    const completed = applyStepResult(buildPlanDag([{ id: "done", title: "Done" }]), "done", { outcome: "completed" });
    expect(applyStepResult(completed, "done", { outcome: "failed", error: "late failure" }).steps[0]).toMatchObject({ status: "completed", attempts: 0, lastError: null });

    const skipped = applyStepResult(buildPlanDag([{ id: "skip", title: "Skip" }]), "skip", { outcome: "skipped" });
    expect(applyStepResult(skipped, "skip", { outcome: "completed" }).steps[0]).toMatchObject({ status: "skipped", attempts: 0, lastError: null });

    const failed = applyStepResult(buildPlanDag([{ id: "fail", title: "Fail" }]), "fail", { outcome: "failed", error: "boom" });
    expect(applyStepResult(failed, "fail", { outcome: "completed" }).steps[0]).toMatchObject({ status: "failed", attempts: 1, lastError: "boom" });

    // unknown id → no-op
    expect(applyStepResult(buildPlanDag([{ id: "x", title: "X" }]), "nope", { outcome: "completed" }).steps[0]?.status).toBe("pending");
  });

  it("markStepRunning marks a pending step running and is a no-op otherwise", () => {
    const plan = buildPlanDag([{ id: "a", title: "A" }]);
    expect(markStepRunning(plan, "a").steps[0]?.status).toBe("running");
    const completed = applyStepResult(plan, "a", { outcome: "completed" });
    expect(markStepRunning(completed, "a").steps[0]?.status).toBe("completed");
  });

  it("planProgress tracks the lifecycle: pending → running → completed", () => {
    let plan = chain();
    expect(planProgress(plan).status).toBe("pending");
    plan = markStepRunning(plan, "a");
    expect(planProgress(plan).status).toBe("running");
    plan = applyStepResult(plan, "a", { outcome: "completed" });
    plan = applyStepResult(plan, "b", { outcome: "completed" });
    plan = applyStepResult(plan, "c", { outcome: "skipped" });
    expect(planProgress(plan)).toMatchObject({ status: "completed", completed: 2, skipped: 1, total: 3 });
  });

  it("planProgress reports failed when a step exhausts its retries", () => {
    const plan = applyStepResult(chain(), "a", { outcome: "failed" }); // maxAttempts 1 → terminal
    expect(planProgress(plan)).toMatchObject({ status: "failed", failed: 1 });
  });

  it("planProgress reports blocked for a deadlocked (cyclic) plan with no ready steps", () => {
    const deadlocked: PlanDag = {
      steps: [
        { id: "a", title: "A", dependsOn: ["b"], status: "pending", attempts: 0, maxAttempts: 1 },
        { id: "b", title: "B", dependsOn: ["a"], status: "pending", attempts: 0, maxAttempts: 1 },
      ],
    };
    expect(planProgress(deadlocked).status).toBe("blocked");
  });

  it("planProgress on an empty plan is pending", () => {
    expect(planProgress({ steps: [] }).status).toBe("pending");
  });
});
