// Plan DAG rendering (pure).
//
// Deterministic, side-effect-free renderers over an already-validated plan DAG (the `planDagSchema` shape used by
// the MCP `gittensory_plan_status` surface in src/mcp/server.ts). No IO and no new logic: given a plan, produce
// either a human-readable Markdown checklist ordered by dependency, or a stable, key-ordered JSON string that is
// byte-identical across runs of the same plan (useful for diffing). The types below mirror the `planDagSchema`
// shape so the engine package stays standalone and does not import the app's Zod schema.

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

// Stable topological order: emit steps whose in-plan dependencies are already emitted, ties broken by the plan's
// original order. A dependency id not present in the plan is treated as satisfied. Any steps left in a cycle are
// appended in original order so nothing is dropped and the function always terminates.
function orderByDependency(steps: PlanStep[]): PlanStep[] {
  const present = new Set(steps.map((step) => step.id));
  const emitted = new Set<string>();
  const ordered: PlanStep[] = [];
  const remaining = [...steps];
  let progressed = true;
  while (remaining.length > 0 && progressed) {
    progressed = false;
    for (let i = 0; i < remaining.length; ) {
      const step = remaining[i]!;
      const ready = step.dependsOn.every((dep) => !present.has(dep) || emitted.has(dep));
      if (ready) {
        ordered.push(step);
        emitted.add(step.id);
        remaining.splice(i, 1);
        progressed = true;
      } else {
        i += 1;
      }
    }
  }
  ordered.push(...remaining);
  return ordered;
}

// Make an untrusted title/error safe to drop into a Markdown checklist line: collapse any CR/LF run to a single
// space (both fields allow newlines in the plan schema) so a step cannot spill onto extra rows, and backslash-escape
// the Markdown control characters that would otherwise re-style the line (emphasis, code, links, html, tables,
// strikethrough) when the artifact is pasted into a review surface. Backslash is escaped by the same class, so the
// single pass is idempotent per character.
function displaySafe(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>|~]/g, "\\$&");
}

/**
 * Render a plan DAG as a Markdown checklist ordered by dependency: one `- [x]`/`- [ ]` line per step (checked when
 * the step is completed), annotated with its status, its attempt count when it has run, and its last error when
 * present. Display fields are collapsed to a single line and Markdown control characters are escaped so each step
 * stays on one row and an untrusted title/error cannot re-style it. Pure — it reads the plan and returns a string.
 */
export function renderPlanAsMarkdown(plan: PlanDag): string {
  const ordered = orderByDependency(plan.steps);
  if (ordered.length === 0) return "_No steps in this plan._";
  return ordered
    .map((step) => {
      const box = step.status === "completed" ? "[x]" : "[ ]";
      let line = `- ${box} ${displaySafe(step.title)} — ${step.status}`;
      if (step.attempts > 0) line += ` (attempt ${step.attempts}/${step.maxAttempts})`;
      if (step.lastError) line += `: ${displaySafe(step.lastError)}`;
      return line;
    })
    .join("\n");
}

// Sort object keys at every level so the output is deterministic; arrays (e.g. `steps`) keep their order.
function sortedKeysReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = source[key];
        return acc;
      }, {});
  }
  return value;
}

/**
 * Render a plan DAG as a stable, deterministically key-ordered JSON string. Two renders of the identical plan are
 * byte-identical (object keys are sorted at every level; array order is preserved), which makes plan snapshots
 * diffable across runs. Pure.
 */
export function renderPlanAsJson(plan: PlanDag): string {
  return JSON.stringify(plan, sortedKeysReplacer, 2);
}
