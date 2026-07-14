// Issue-to-plan decomposition heuristic (pure) (#4292).
//
// The stateless plan-DAG surface (rawPlanStepSchema / loopover_build_plan, src/mcp/server.ts; plan-store.js
// persistence) consumes a caller-supplied RawPlanStep[], but nothing in the repo turns a TARGET ISSUE into those
// steps — every caller has to hand it one already-built. plan-templates.ts's PLAN_TEMPLATE_BUILDERS describe the
// miner's OWN fixed lifecycle, not the issue's actual implementation work; planPlanTemplate even carries a
// `plan-dag-build` placeholder step with no logic behind it. This module is that missing piece: a deterministic,
// side-effect-free function that folds issue-level metadata (title / body / labels only — never source content)
// into a RawPlanStep[] execution DAG in the SAME raw-step shape plan-templates.ts emits, so build_plan and
// plan-store.js's validatePlanDag validate it identically.

import type { RawPlanStep } from "./plan-templates.js";

/** Issue-level metadata this heuristic decomposes into an execution plan. Every field is optional so a bare issue
 *  (title-only, or nothing at all) still yields a valid baseline DAG. A PromptPacket caller (#2321) can map its
 *  `taskBrief` onto `title` and `retrievalContext`/`constraints` onto `body`. */
export type IssuePlanInput = {
  title?: string | undefined;
  body?: string | undefined;
  labels?: readonly string[] | undefined;
};

// Title ceiling of rawPlanStepSchema.title (max 300) and a subject cap kept well under it, mirroring
// plan-templates.ts, so a long issue title can never produce an out-of-range step title.
const MAX_TITLE_CHARS = 300;
const MAX_SUBJECT_CHARS = 200;

// Collapse any run of whitespace to a single space and trim/bound, so a subject yields a clean deterministic
// one-line title (mirrors plan-templates.ts's normalizeSubject).
function normalizeSubject(subject: string | undefined): string {
  return (subject ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT_CHARS);
}

// Compose a step title from a fixed prefix and the optional subject, hard-capped to the schema's title ceiling.
function titleFor(prefix: string, subject: string): string {
  const full = subject ? `${prefix}: ${subject}` : prefix;
  return full.slice(0, MAX_TITLE_CHARS);
}

// Low-cardinality issue-kind signals derived deterministically from the combined title+body+labels text. Labels
// are folded into the SAME lowercased haystack as the free text, so an issue tagged `bug` and one whose title
// merely says "fix the crash" take the same path without a separate label-only branch.
const BUG_SIGNAL = /\b(bug|bugs|fix|fixes|regression|broken|crash|crashes|incorrect)\b/;
const DOCS_SIGNAL = /\b(doc|docs|documentation|readme|guide)\b/;

/**
 * Decompose a target issue into a deterministic execution-plan DAG of {@link RawPlanStep}s. Same input always
 * yields identical output (no clock, no randomness) — matching every other pure composer in this package. The spine
 * is always `locate → implement → test → verify`; a bug signal inserts a `reproduce` step before `implement` (and
 * asks `test` for a regression test), and a docs signal inserts a `docs` step that `verify` then also waits on.
 * Every `dependsOn` references an EARLIER step, so the result is acyclic with a ready topological order and passes
 * rawPlanStepSchema + plan-store.js's `validatePlanDag` unchanged (unique ids, in-plan deps, no cycles).
 */
export function decomposeIssueToPlan(issue: IssuePlanInput = {}): RawPlanStep[] {
  const subject = normalizeSubject(issue.title);
  const haystack = `${issue.title ?? ""} ${issue.body ?? ""} ${(issue.labels ?? []).join(" ")}`.toLowerCase();
  const isBugFix = BUG_SIGNAL.test(haystack);
  const wantsDocs = DOCS_SIGNAL.test(haystack);

  const steps: RawPlanStep[] = [
    { id: "locate", title: titleFor("Locate the code to change", subject), actionClass: "analyze", dependsOn: [], maxAttempts: 2 },
  ];
  if (isBugFix) {
    steps.push({ id: "reproduce", title: titleFor("Reproduce the reported behavior", subject), actionClass: "analyze", dependsOn: ["locate"], maxAttempts: 1 });
  }
  steps.push({ id: "implement", title: titleFor("Implement the change", subject), actionClass: "codegen", dependsOn: [isBugFix ? "reproduce" : "locate"], maxAttempts: 1 });
  steps.push({ id: "test", title: titleFor(isBugFix ? "Add a regression test and run the suite" : "Add tests and run the suite", subject), actionClass: "test", dependsOn: ["implement"], maxAttempts: 2 });
  if (wantsDocs) {
    steps.push({ id: "docs", title: titleFor("Update documentation", subject), actionClass: "compose", dependsOn: ["implement"], maxAttempts: 1 });
  }
  steps.push({ id: "verify", title: titleFor("Verify the full gate is green", subject), actionClass: "analyze", dependsOn: wantsDocs ? ["test", "docs"] : ["test"], maxAttempts: 2 });
  return steps;
}
