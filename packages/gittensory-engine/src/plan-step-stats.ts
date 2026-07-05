import type { PlanDag, PlanStepStatus } from "./plan-export.js";

/**
 * Count plan steps matching a given status. Pure — reads the plan DAG only.
 */
export function countPlanStepsByStatus(plan: PlanDag, status: PlanStepStatus): number {
  return plan.steps.filter((step) => step.status === status).length;
}
