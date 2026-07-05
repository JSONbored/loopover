import type { PlanDag } from "./plan-export.js";

/**
 * Return the total number of steps in the plan. Pure — reads the plan DAG only.
 */
export function countPlanSteps(plan: PlanDag): number {
  return plan.steps.length;
}
