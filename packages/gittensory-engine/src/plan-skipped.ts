import type { PlanDag } from "./plan-export.js";

/**
 * Return whether any step in the plan was skipped. Pure — reads the plan DAG only.
 */
export function hasPlanSkippedSteps(plan: PlanDag): boolean {
  return plan.steps.some((step) => step.status === "skipped");
}
