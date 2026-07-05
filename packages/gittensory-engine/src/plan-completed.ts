import type { PlanDag } from "./plan-export.js";

/**
 * Return whether any step in the plan is completed. Pure — reads the plan DAG only.
 */
export function hasPlanCompletedSteps(plan: PlanDag): boolean {
  return plan.steps.some((step) => step.status === "completed");
}
