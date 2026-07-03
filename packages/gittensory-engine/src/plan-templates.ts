// Plan-template library (pure).
//
// Reusable plan TEMPLATES for the fixed miner lifecycle (discover -> analyze -> plan -> prepare -> create ->
// manage -> repeat), emitted in the exact stateless raw-step shape the MCP `gittensory_build_plan` tool accepts
// (`rawPlanStepSchema` in src/mcp/server.ts), so `build_plan` can normalize them into a validated DAG. Each builder
// is deterministic and side-effect-free: it only DESCRIBES steps and their `dependsOn` ordering — it never actuates
// anything. The `RawPlanStep` type below mirrors the raw-step schema so the engine package stays standalone and
// does not import the app's Zod schema (the tests validate the output against the real schema to guard drift).

// Mirror of `rawPlanStepSchema` (src/mcp/server.ts): the pre-normalization step shape `gittensory_build_plan` accepts.
export type RawPlanStep = {
  id: string;
  title: string;
  actionClass?: string | undefined;
  dependsOn?: string[] | undefined;
  maxAttempts?: number | undefined;
};

// The lifecycle-stage transitions this library provides a template for.
export type PlanTemplateStage = "analyze" | "prepare";

// Context woven into a template's step titles so a plan reads against the opportunity it targets.
export type PlanTemplateContext = {
  // A short human label for the issue/opportunity the plan is for (e.g. an issue title). Optional so a caller can
  // render a generic template; whitespace is collapsed and the value is length-bounded to keep every title valid.
  subject?: string | undefined;
};

// Title length ceiling of `rawPlanStepSchema.title` (max 300). Titles are hard-capped to this so a long subject can
// never produce an out-of-range step.
const MAX_TITLE_CHARS = 300;
// Keep the woven subject well under the title ceiling so the fixed prefix always survives the cap.
const MAX_SUBJECT_CHARS = 200;

// Collapse any run of whitespace (including newlines) to a single space and trim, so a subject yields a clean,
// deterministic one-line title.
function normalizeSubject(subject: string | undefined): string {
  return (subject ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT_CHARS);
}

// Compose a step title from a fixed prefix and the optional subject, hard-capped to the schema's title ceiling.
function titleFor(prefix: string, subject: string): string {
  const full = subject ? `${prefix}: ${subject}` : prefix;
  return full.slice(0, MAX_TITLE_CHARS);
}

// analyze: feasibility check and repository RAG retrieval run independently, then the prompt-packet build consumes
// both. Mirrors the ANALYZE-phase ordering described in the plan-template issue.
export function analyzePlanTemplate(context: PlanTemplateContext = {}): RawPlanStep[] {
  const subject = normalizeSubject(context.subject);
  return [
    { id: "feasibility-check", title: titleFor("Assess feasibility", subject), actionClass: "analyze", dependsOn: [], maxAttempts: 1 },
    { id: "rag-retrieval", title: titleFor("Retrieve repository context", subject), actionClass: "retrieve", dependsOn: [], maxAttempts: 3 },
    { id: "prompt-packet", title: titleFor("Build prompt packet", subject), actionClass: "compose", dependsOn: ["feasibility-check", "rag-retrieval"], maxAttempts: 2 },
  ];
}

// prepare: a strict chain — create the branch, invoke the coding agent (placeholder step; no actuation here), then
// run the local tests. Mirrors the PREPARE-phase ordering described in the plan-template issue.
export function preparePlanTemplate(context: PlanTemplateContext = {}): RawPlanStep[] {
  const subject = normalizeSubject(context.subject);
  return [
    { id: "branch-create", title: titleFor("Create working branch", subject), actionClass: "vcs", dependsOn: [], maxAttempts: 3 },
    { id: "coding-agent", title: titleFor("Invoke coding agent", subject), actionClass: "codegen", dependsOn: ["branch-create"], maxAttempts: 1 },
    { id: "local-test", title: titleFor("Run local tests", subject), actionClass: "test", dependsOn: ["coding-agent"], maxAttempts: 2 },
  ];
}

// Registry of every stage transition to its template builder, so callers can enumerate or dispatch by stage.
// Frozen so a consumer cannot mutate the shared registry and change dispatch behavior process-wide.
export const PLAN_TEMPLATE_BUILDERS: Readonly<Record<PlanTemplateStage, (context?: PlanTemplateContext) => RawPlanStep[]>> =
  Object.freeze({
    analyze: analyzePlanTemplate,
    prepare: preparePlanTemplate,
  });

// Build the raw-step template for a stage. Pure — a thin dispatcher over `PLAN_TEMPLATE_BUILDERS` that rejects an
// unknown stage with a clear error rather than a generic "not a function" TypeError (guards non-TypeScript callers).
export function buildPlanTemplate(stage: PlanTemplateStage, context: PlanTemplateContext = {}): RawPlanStep[] {
  const builder = PLAN_TEMPLATE_BUILDERS[stage];
  if (!builder) throw new Error(`Unknown plan-template stage: ${String(stage)}`);
  return builder(context);
}
