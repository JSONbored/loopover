export type PlanStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type PlanStep = {
  id: string;
  title: string;
  actionClass?: string;
  dependsOn: string[];
  status: PlanStepStatus;
  attempts: number;
  maxAttempts: number;
  lastError?: string | null;
};

export type PlanDag = {
  steps: PlanStep[];
};

export type PlanStatus = "pending" | "running" | "completed" | "failed";

export type PlanRecord = {
  planId: string;
  plan: PlanDag;
  status: PlanStatus;
  updatedAt: string;
};

export type ListPlansFilter = {
  status?: PlanStatus;
};

export type PlanStore = {
  dbPath: string;
  savePlan(planId: string, plan: PlanDag): PlanRecord;
  loadPlan(planId: string): PlanRecord | null;
  listPlans(filter?: ListPlansFilter): PlanRecord[];
  close(): void;
};

export const PLAN_STATUSES: readonly PlanStatus[];

export function resolvePlanStoreDbPath(env?: Record<string, string | undefined>): string;

export function openPlanStore(dbPath?: string): PlanStore;

export function savePlan(planId: string, plan: PlanDag): PlanRecord;

export function loadPlan(planId: string): PlanRecord | null;

export function listPlans(filter?: ListPlansFilter): PlanRecord[];

export function closeDefaultPlanStore(): void;
