import type { PlanDag } from "./plan-export.js";

/**
 * Return whether any step in the plan is still pending. Pure — reads the plan DAG only.
 */
export function hasPlanPendingSteps(plan: PlanDag): boolean {
  return plan.steps.some((step) => step.status === "pending");
}
