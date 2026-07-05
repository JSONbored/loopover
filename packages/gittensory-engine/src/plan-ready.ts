import type { PlanDag, PlanStep, PlanStepStatus } from "./plan-export.js";

const isDone = (status: PlanStepStatus): boolean => status === "completed" || status === "skipped";

function nextReadySteps(plan: PlanDag): PlanStep[] {
  const statusById = new Map(plan.steps.map((step) => [step.id, step.status]));
  return plan.steps.filter(
    (step) => step.status === "pending" && step.dependsOn.every((dep) => isDone(statusById.get(dep) ?? "pending")),
  );
}

/**
 * Return whether any step is runnable now: `pending` with every dependency `completed` or `skipped`. Mirrors hosted
 * `nextReadySteps(plan).length > 0`. Pure.
 */
export function hasPlanReadySteps(plan: PlanDag): boolean {
  return nextReadySteps(plan).length > 0;
}

/**
 * Count steps runnable now: `pending` with every dependency `completed` or `skipped`. Mirrors hosted
 * `nextReadySteps(plan).length`. Pure.
 */
export function countPlanReadySteps(plan: PlanDag): number {
  return nextReadySteps(plan).length;
}
