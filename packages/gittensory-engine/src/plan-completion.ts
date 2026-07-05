import type { PlanDag } from "./plan-export.js";

/**
 * Return whether every step in the plan is completed. Empty plans are not considered complete.
 * Pure — reads the plan DAG only.
 */
export function isPlanFullyCompleted(plan: PlanDag): boolean {
  return plan.steps.length > 0 && plan.steps.every((step) => step.status === "completed");
}
