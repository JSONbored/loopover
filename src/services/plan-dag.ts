// #783 multi-step action DAG. A miner plan is a set of steps with dependencies ("close 1 stale PR → land 2 →
// open a new direct PR"); gittensory tracks per-step state + retries so the plan survives across MCP tool
// calls and resumes where it left off. PURE + deterministic — the harness performs each step's real work and
// reports the result back; this module only advances the state machine.

export type PlanStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type PlanStep = {
  id: string;
  title: string;
  actionClass?: string | undefined;
  dependsOn: string[];
  status: PlanStepStatus;
  attempts: number;
  maxAttempts: number;
  lastError?: string | null | undefined;
};

export type PlanDag = { steps: PlanStep[] };

export type PlanOverallStatus = "pending" | "running" | "completed" | "failed" | "blocked";

export type PlanProgress = {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  skipped: number;
  status: PlanOverallStatus;
};

const DEFAULT_MAX_ATTEMPTS = 1;

/** Build a normalized DAG from raw step input: default status pending / attempts 0, clamp maxAttempts to [1,10],
 *  drop self-deps + duplicate dep ids. Pure. */
export function buildPlanDag(steps: Array<{ id: string; title: string; actionClass?: string | undefined; dependsOn?: string[] | undefined; maxAttempts?: number | undefined }>): PlanDag {
  return {
    steps: steps.map((step) => ({
      id: step.id,
      title: step.title,
      ...(step.actionClass !== undefined ? { actionClass: step.actionClass } : {}),
      dependsOn: [...new Set((step.dependsOn ?? []).filter((dep) => dep !== step.id))],
      status: "pending" as PlanStepStatus,
      attempts: 0,
      maxAttempts: Math.min(10, Math.max(1, Math.trunc(step.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))),
    })),
  };
}

/** Validate the DAG: unique ids, every dependency exists, and no cycles. Pure. */
export function validatePlanDag(plan: PlanDag): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = plan.steps.map((step) => step.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) errors.push("duplicate step ids");
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (!idSet.has(dep)) errors.push(`step ${step.id} depends on unknown step ${dep}`);
    }
  }
  // Cycle detection via DFS coloring.
  const color = new Map<string, 0 | 1 | 2>();
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const hasCycle = (id: string): boolean => {
    color.set(id, 1);
    /* v8 ignore next -- hasCycle is only ever called with an id present in byId, so the [] fallback is defensive. */
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const depColor = color.get(dep) ?? 0;
      if (depColor === 1) return true;
      if (depColor === 0 && byId.has(dep) && hasCycle(dep)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const step of plan.steps) {
    if ((color.get(step.id) ?? 0) === 0 && hasCycle(step.id)) {
      errors.push("plan has a dependency cycle");
      break;
    }
  }
  return { valid: errors.length === 0, errors };
}

const isDone = (status: PlanStepStatus): boolean => status === "completed" || status === "skipped";

/** The steps ready to run now: pending, with every dependency completed or skipped. Pure. */
export function nextReadySteps(plan: PlanDag): PlanStep[] {
  const statusById = new Map(plan.steps.map((step) => [step.id, step.status]));
  return plan.steps.filter((step) => step.status === "pending" && step.dependsOn.every((dep) => isDone(statusById.get(dep) ?? "pending")));
}

function mapStep(plan: PlanDag, stepId: string, update: (step: PlanStep) => PlanStep): PlanDag {
  return { steps: plan.steps.map((step) => (step.id === stepId ? update(step) : step)) };
}

/** Mark a ready step as running (the harness has started it). No-op for an unknown/non-pending step. Pure. */
export function markStepRunning(plan: PlanDag, stepId: string): PlanDag {
  return mapStep(plan, stepId, (step) => (step.status === "pending" ? { ...step, status: "running" } : step));
}

/**
 * Record the outcome of a step the harness ran. `completed` / `skipped` are terminal. `failed` increments the
 * attempt count and retries (back to pending) until maxAttempts is exhausted, after which it stays failed. An
 * unknown step id is a no-op. Pure.
 */
export function applyStepResult(plan: PlanDag, stepId: string, result: { outcome: "completed" | "failed" | "skipped"; error?: string | null | undefined }): PlanDag {
  return mapStep(plan, stepId, (step) => {
    if (isDone(step.status) || step.status === "failed") return step;
    if (result.outcome === "completed") return { ...step, status: "completed", lastError: null };
    if (result.outcome === "skipped") return { ...step, status: "skipped", lastError: null };
    const attempts = step.attempts + 1;
    const exhausted = attempts >= step.maxAttempts;
    return { ...step, attempts, status: exhausted ? "failed" : "pending", lastError: result.error ?? "step failed" };
  });
}

/** Aggregate progress + the overall plan status. Pure. */
export function planProgress(plan: PlanDag): PlanProgress {
  const count = (status: PlanStepStatus) => plan.steps.filter((step) => step.status === status).length;
  const completed = count("completed");
  const skipped = count("skipped");
  const failed = count("failed");
  const running = count("running");
  const pending = count("pending");
  const total = plan.steps.length;
  let status: PlanOverallStatus;
  if (total > 0 && completed + skipped === total) status = "completed";
  else if (failed > 0) status = "failed";
  else if (running > 0) status = "running";
  else if (pending > 0 && nextReadySteps(plan).length === 0) status = "blocked";
  else status = "pending";
  return { total, completed, failed, running, pending, skipped, status };
}
