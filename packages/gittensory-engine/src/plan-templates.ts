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
export type PlanTemplateStage = "discover" | "analyze" | "create" | "manage" | "plan" | "prepare";

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

// discover: rank candidate opportunities, validate lane fit, then run a pre-start check before analyze.
export function discoverPlanTemplate(context: PlanTemplateContext = {}): RawPlanStep[] {
  const subject = normalizeSubject(context.subject);
  return [
    { id: "opportunity-rank", title: titleFor("Rank candidate opportunities", subject), actionClass: "discover", dependsOn: [], maxAttempts: 2 },
    { id: "lane-fit-check", title: titleFor("Validate miner goal lane fit", subject), actionClass: "analyze", dependsOn: ["opportunity-rank"], maxAttempts: 1 },
    { id: "pre-start-check", title: titleFor("Run pre-start check", subject), actionClass: "analyze", dependsOn: ["lane-fit-check"], maxAttempts: 2 },
  ];
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

// plan: validate the analyze prompt packet, build the execution DAG, then run a readiness check before prepare.
export function planPlanTemplate(context: PlanTemplateContext = {}): RawPlanStep[] {
  const subject = normalizeSubject(context.subject);
  return [
    { id: "packet-validate", title: titleFor("Validate prompt packet", subject), actionClass: "analyze", dependsOn: [], maxAttempts: 1 },
    { id: "plan-dag-build", title: titleFor("Build execution plan DAG", subject), actionClass: "compose", dependsOn: ["packet-validate"], maxAttempts: 2 },
    { id: "readiness-check", title: titleFor("Run plan readiness check", subject), actionClass: "analyze", dependsOn: ["plan-dag-build"], maxAttempts: 1 },
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

// create: commit the working tree, push the branch, then open the pull request with the public-safe packet.
export function createPlanTemplate(context: PlanTemplateContext = {}): RawPlanStep[] {
  const subject = normalizeSubject(context.subject);
  return [
    { id: "commit-changes", title: titleFor("Commit working tree changes", subject), actionClass: "vcs", dependsOn: [], maxAttempts: 2 },
    { id: "push-branch", title: titleFor("Push feature branch", subject), actionClass: "vcs", dependsOn: ["commit-changes"], maxAttempts: 3 },
    { id: "open-pull-request", title: titleFor("Open pull request", subject), actionClass: "github", dependsOn: ["push-branch"], maxAttempts: 2 },
  ];
}

// manage: wait for CI, read the gate verdict, then sync the fork default branch for the next cycle.
export function managePlanTemplate(context: PlanTemplateContext = {}): RawPlanStep[] {
  const subject = normalizeSubject(context.subject);
  return [
    { id: "wait-ci", title: titleFor("Wait for CI completion", subject), actionClass: "test", dependsOn: [], maxAttempts: 5 },
    { id: "read-gate-result", title: titleFor("Read gate verdict", subject), actionClass: "analyze", dependsOn: ["wait-ci"], maxAttempts: 2 },
    { id: "sync-fork", title: titleFor("Sync fork default branch", subject), actionClass: "vcs", dependsOn: ["read-gate-result"], maxAttempts: 3 },
  ];
}

// Registry of every stage transition to its template builder, so callers can enumerate or dispatch by stage.
// Frozen so a consumer cannot mutate the shared registry and change dispatch behavior process-wide.
export const PLAN_TEMPLATE_BUILDERS: Readonly<Record<PlanTemplateStage, (context?: PlanTemplateContext) => RawPlanStep[]>> =
  Object.freeze({
    discover: discoverPlanTemplate,
    analyze: analyzePlanTemplate,
    create: createPlanTemplate,
    manage: managePlanTemplate,
    plan: planPlanTemplate,
    prepare: preparePlanTemplate,
  });

// Build the raw-step template for a stage. Pure — a thin dispatcher over `PLAN_TEMPLATE_BUILDERS` that rejects an
// unknown stage with a clear error rather than a generic "not a function" TypeError (guards non-TypeScript callers).
export function buildPlanTemplate(stage: PlanTemplateStage, context: PlanTemplateContext = {}): RawPlanStep[] {
  const builder = Object.prototype.hasOwnProperty.call(PLAN_TEMPLATE_BUILDERS, stage)
    ? PLAN_TEMPLATE_BUILDERS[stage]
    : undefined;
  if (typeof builder !== "function") throw new Error(`Unknown plan-template stage: ${String(stage)}`);
  return builder(context);
}
