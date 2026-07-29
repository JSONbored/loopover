// Remote server `agent` category (#9518, part 5 -- the last remote category).
//
// Three sub-families live here and they are not the same kind of thing:
//
//   1. The rented-loop surfaces (intake_idea, plan_idea_claims, build_results_payload,
//      build_progress_snapshot, evaluate_escalation). Every one has a REST mirror under /v1/loop/*
//      whose OpenAPI component is asserted field-for-field against these shapes, so a field added
//      here without a matching component change fails test/unit/openapi.test.ts.
//   2. The local-execution write specs (#780). LoopOver NEVER performs these writes -- each tool
//      returns a spec the caller runs with its own credentials. That is why they all share one
//      output shape and why `annotations.readOnlyHint` is true: the tool call itself writes nothing.
//   3. The automation control surface (#784, #6087) plus the stateless plan DAG (#783), which is
//      stateless in the strict sense -- the caller holds the plan and passes it back each call, so
//      LoopOver keeps no record of it.
//
// Descriptions are relocated verbatim, same discipline as the other batches.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { AUTONOMY_LEVELS, FEASIBILITY_VERDICTS, MAINTAIN_ACTION_CLASSES, PLAN_STEP_STATUSES, PROPOSE_ACTION_CLASSES, TEST_FRAMEWORKS } from "../enums.js";
import { SCENARIO_LIMITS, WRITE_TOOL_LIMITS } from "../limits.js";
import { AgentRunBundleOutput } from "./branch.js";
import { ownerRepoInput } from "../shared.js";

const repoFullName = z.string().min(3).max(SCENARIO_LIMITS.repoFullNameChars);
const issueOrPrNumber = z.number().int().positive();

// ── rented-loop surfaces ────────────────────────────────────────────────────────────────────────

export const IntakeIdeaInput = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  targetRepo: z.string().optional(),
  constraints: z.array(z.string()).max(50).optional(),
  acceptanceHints: z.array(z.string()).max(50).optional(),
  priority: z.string().optional(),
  decomposition: z
    .array(z.object({ key: z.string(), title: z.string(), body: z.string(), dependsOn: z.array(z.string()).max(50).optional() }))
    .max(50)
    .optional(),
});

/** Every field is optional on purpose: a malformed submission must reach the handler so it can
 *  answer with an actionable `errors` list, rather than being rejected at the schema boundary with
 *  a zod message the caller cannot act on. */
export const IntakeIdeaOutput = z.looseObject({
  ok: z.boolean(),
  verdict: z.enum(FEASIBILITY_VERDICTS).optional(),
  taskGraph: z.unknown().optional(),
  errors: z.array(z.string()).optional(),
});
export const intakeIdeaTool = defineTool({
  name: "loopover_intake_idea",
  title: "Intake idea",
  description:
    "Turn a freeform renter idea into a strict, claimable task-graph (spec #4779) and score it against the same feasibility gate the loop runs on. Deterministic and source-free: validates the submission, assembles constituent issues (an optional caller-supplied decomposition, else a single-issue baseline), and returns the graph plus its go/raise/avoid verdict. A malformed or empty submission returns an actionable error list, not a silent failure.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: IntakeIdeaInput,
  output: IntakeIdeaOutput,
});

export const PlanIdeaClaimsOutput = z.looseObject({
  ok: z.boolean(),
  verdict: z.enum(FEASIBILITY_VERDICTS).optional(),
  claimPlan: z.unknown().optional(),
  errors: z.array(z.string()).optional(),
});
export const planIdeaClaimsTool = defineTool({
  name: "loopover_plan_idea_claims",
  title: "Plan idea claims",
  description:
    "Route a freeform idea through the intake bridge (#4798) into a claim/code/submit-loop plan (#4799): validates the submission, builds the scored task-graph, and returns which constituent issues the loop can claim now vs. defer (held on a prerequisite) vs. skip (unshippable) — dependency-ordered so a prerequisite is always claimed before its dependents. Deterministic and source-free; it decides what to claim, it does not claim or run anything. A malformed/empty submission returns an actionable error list.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  // Same input as intake_idea: this tool is the claim-planning half of the same submission.
  input: IntakeIdeaInput,
  output: PlanIdeaClaimsOutput,
});

export const BuildResultsPayloadInput = z.object({
  repoFullName: z.string().min(1),
  prNumber: z.number().int().nullable().optional(),
  title: z.string(),
  changedFiles: z
    .array(z.object({ path: z.string(), additions: z.number().int().optional(), deletions: z.number().int().optional() }))
    .max(5000)
    .optional(),
  status: z.enum(["open", "merged", "closed"]).optional(),
});
export const BuildResultsPayloadOutput = z.looseObject({
  prLink: z.string().nullable().optional(),
  summary: z.string().optional(),
  diffPreview: z.unknown().optional(),
  totals: z.unknown().optional(),
});
export const buildResultsPayloadTool = defineTool({
  name: "loopover_build_results_payload",
  title: "Build results payload",
  description:
    "Package a completed loop iteration into the customer-facing result (#4801): a PR link, a plain-language summary, and a bounded diff preview, from already-computed iteration metadata. Deterministic and source-free — it formats the result, it does not fetch, open, or deliver anything.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: BuildResultsPayloadInput,
  output: BuildResultsPayloadOutput,
});

export const BuildProgressSnapshotInput = z.object({
  iteration: z.number().int(),
  maxIterations: z.number().int().nullable().optional(),
  phase: z.enum(["queued", "claiming", "coding", "reviewing", "submitting", "done"]),
  status: z.enum(["running", "converged", "abandoned", "error"]),
  recentActivity: z
    .array(z.object({ step: z.string(), detail: z.string().optional(), at: z.string().optional() }))
    .max(1000)
    .optional(),
});
export const BuildProgressSnapshotOutput = z.looseObject({
  phase: z.string().optional(),
  status: z.string().optional(),
  iteration: z.number().optional(),
  maxIterations: z.number().nullable().optional(),
  percentComplete: z.number().nullable().optional(),
  recentActivity: z.unknown().optional(),
  done: z.boolean().optional(),
});
export const buildProgressSnapshotTool = defineTool({
  name: "loopover_build_progress_snapshot",
  title: "Build progress snapshot",
  description:
    "Build a near-real-time progress snapshot for a running rented loop (#4800): phase, status, iteration/percent-complete, and a bounded recent-activity tail, from already-computed loop state. Deterministic and source-free; a customer surface pushes it on change (via the engine's progressChanged) rather than polling on a fixed interval.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: BuildProgressSnapshotInput,
  output: BuildProgressSnapshotOutput,
});

export const EvaluateEscalationInput = z.object({
  runStatus: z.enum(["running", "converged", "abandoned", "error"]),
  healthStatus: z.enum(["healthy", "degraded", "critical"]).optional(),
  customerFlagged: z.boolean().optional(),
  killRequested: z.boolean().optional(),
});
export const EvaluateEscalationOutput = z.looseObject({
  shouldEscalate: z.boolean().optional(),
  action: z.enum(["none", "notify", "human_review", "stop"]).optional(),
  severity: z.enum(["none", "low", "medium", "high"]).optional(),
  reasons: z.array(z.string()).optional(),
});
export const evaluateEscalationTool = defineTool({
  name: "loopover_evaluate_escalation",
  title: "Evaluate escalation",
  description:
    "Decide whether a rented loop needs a human, and what action to take (#4806), from an already-computed run outcome, health tier, and operator/customer signals — the deterministic support/escalation-path logic. Source-free; returns shouldEscalate + action (none/notify/human_review/stop) + severity + reasons. It decides; the caller wires the action.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: EvaluateEscalationInput,
  output: EvaluateEscalationOutput,
});

// ── local-execution write specs (#780) ──────────────────────────────────────────────────────────

/** Shared by every write-spec tool. `command` is what the CALLER runs; `boundary` states in words
 *  that LoopOver did not and will not run it. */
export const LocalWriteActionOutput = z.looseObject({
  action: z.string(),
  description: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  command: z.string(),
  boundary: z.string(),
});

/** These tools produce a spec and touch nothing. The hints describe the TOOL CALL, not the command
 *  the caller may later choose to run with its own credentials. */
const writeSpecAnnotations = { readOnlyHint: true, destructiveHint: false } as const;

export const OpenPrInput = z.object({
  repoFullName,
  base: z.string().min(1).max(SCENARIO_LIMITS.branchRefChars),
  head: z.string().min(1).max(SCENARIO_LIMITS.branchRefChars),
  title: z.string().min(1).max(WRITE_TOOL_LIMITS.titleChars),
  body: z.string().max(WRITE_TOOL_LIMITS.bodyChars),
  draft: z.boolean().optional(),
});
export const openPrTool = defineTool({
  name: "loopover_open_pr",
  title: "Open PR (local spec)",
  description:
    "Build a LOCAL-execution spec to open a pull request from your branch (run it with your own gh creds; loopover never performs the write).",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: writeSpecAnnotations,
  input: OpenPrInput,
  output: LocalWriteActionOutput,
});

export const FileIssueInput = z.object({
  repoFullName,
  title: z.string().min(1).max(WRITE_TOOL_LIMITS.titleChars),
  body: z.string().max(WRITE_TOOL_LIMITS.bodyChars),
  labels: z.array(z.string().min(1).max(100)).max(20).optional(),
});
export const fileIssueTool = defineTool({
  name: "loopover_file_issue",
  title: "File issue (local spec)",
  description: "Build a LOCAL-execution spec to file an issue (run it with your own gh creds; loopover never performs the write).",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: writeSpecAnnotations,
  input: FileIssueInput,
  output: LocalWriteActionOutput,
});

export const ApplyLabelsInput = z.object({
  repoFullName,
  number: issueOrPrNumber,
  labels: z.array(z.string().min(1).max(100)).min(1).max(20),
});
export const applyLabelsTool = defineTool({
  name: "loopover_apply_labels",
  title: "Apply labels (local spec)",
  description:
    "Build a LOCAL-execution spec to add labels to an issue or PR (run it with your own gh creds; loopover never performs the write).",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: writeSpecAnnotations,
  input: ApplyLabelsInput,
  output: LocalWriteActionOutput,
});

export const PostEligibilityCommentInput = z.object({
  repoFullName,
  number: issueOrPrNumber,
  body: z.string().min(1).max(WRITE_TOOL_LIMITS.bodyChars),
});
export const postEligibilityCommentTool = defineTool({
  name: "loopover_post_eligibility_comment",
  title: "Post eligibility comment (local spec)",
  description:
    "Build a LOCAL-execution spec to post an eligibility/context comment on an issue or PR (run it with your own gh creds; loopover never performs the write).",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: writeSpecAnnotations,
  input: PostEligibilityCommentInput,
  output: LocalWriteActionOutput,
});

export const PostSoftClaimInput = z.object({
  repoFullName,
  number: issueOrPrNumber,
  minerId: z.string().min(1).max(200),
  claimedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});
export const postSoftClaimTool = defineTool({
  name: "loopover_post_soft_claim",
  title: "Post soft claim (local spec)",
  description:
    "Build a LOCAL-execution spec to post a soft-claim comment on an issue, signaling a miner is working on it to reduce duplicate work (run it with your own gh creds; loopover never performs the write). Not an assignment -- purely advisory.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: writeSpecAnnotations,
  input: PostSoftClaimInput,
  output: LocalWriteActionOutput,
});

export const CreateBranchInput = z.object({
  branch: z.string().min(1).max(WRITE_TOOL_LIMITS.branchChars),
  base: z.string().min(1).max(WRITE_TOOL_LIMITS.branchChars).optional(),
});
export const createBranchTool = defineTool({
  name: "loopover_create_branch",
  title: "Create branch (local spec)",
  description: "Build a LOCAL-execution spec to create a branch (run it locally; loopover never performs the write).",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: writeSpecAnnotations,
  input: CreateBranchInput,
  output: LocalWriteActionOutput,
});

export const DeleteBranchInput = z.object({
  branch: z.string().min(1).max(WRITE_TOOL_LIMITS.branchChars),
  remote: z.boolean().optional(),
});
export const deleteBranchTool = defineTool({
  name: "loopover_delete_branch",
  title: "Delete branch (local spec)",
  description: "Build a LOCAL-execution spec to delete a branch (run it locally; loopover never performs the write).",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: writeSpecAnnotations,
  input: DeleteBranchInput,
  output: LocalWriteActionOutput,
});

/** #2188: the framework list mirrors detectTestConvention's TEST_FRAMEWORKS (#2187) so a caller
 *  cannot request a spec for a framework the detector could never have produced. */
export const GenerateTestsInput = z.object({
  repoFullName,
  targetFiles: z.array(z.string().min(1).max(500)).min(1).max(WRITE_TOOL_LIMITS.targetFiles),
  framework: z.enum(TEST_FRAMEWORKS),
  testDir: z.string().min(1).max(255).optional(),
  criteria: z.array(z.string().min(1).max(300)).max(20).optional(),
});
export const generateTestsTool = defineTool({
  name: "loopover_generate_tests",
  title: "Generate tests (local spec)",
  description:
    "Build a LOCAL-execution spec describing WHAT boundary-safe test cases should exist for the given target files, using the repo's detected framework/convention (see loopover's test-evidence signal). LoopOver supplies the criteria; your OWN agent scaffolds and runs the actual test files locally — no source code is uploaded and loopover never performs the write.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: writeSpecAnnotations,
  input: GenerateTestsInput,
  output: LocalWriteActionOutput,
});

export const FileFollowUpIssueInput = z.object({
  repoFullName,
  path: z.string().min(1).max(500),
  line: z.number().int().positive().optional(),
  finding: z.string().min(1).max(WRITE_TOOL_LIMITS.bodyChars),
  label: z.string().min(1).max(100).optional(),
});
export const fileFollowUpIssueTool = defineTool({
  name: "loopover_file_follow_up_issue",
  title: "File follow-up issue (local spec)",
  description:
    "Build a LOCAL-execution spec to file a follow-up issue for a review finding a maintainer wants TRACKED rather than blocked on this PR. Composes a bounded, public-safe title/body from the finding (run it with your own gh creds; loopover never performs the write).",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: writeSpecAnnotations,
  input: FileFollowUpIssueInput,
  output: LocalWriteActionOutput,
});

export const ClosePrInput = z.object({
  repoFullName,
  number: issueOrPrNumber,
  comment: z.string().max(WRITE_TOOL_LIMITS.bodyChars).optional(),
});
export const closePrTool = defineTool({
  name: "loopover_close_pr",
  title: "Close PR (local spec)",
  description:
    "Build a LOCAL-execution spec to close a pull request, optionally with a comment (run it with your own gh creds; loopover never performs the write).",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: writeSpecAnnotations,
  input: ClosePrInput,
  output: LocalWriteActionOutput,
});

// ── stateless plan DAG (#783) ───────────────────────────────────────────────────────────────────

/** The pre-normalization step a caller submits to loopover_build_plan. `.strict()` on purpose: an
 *  unrecognized key here is a caller mistake worth surfacing, not a field to silently drop. */
export const rawPlanStepSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    actionClass: z.string().min(1).max(60).optional(),
    dependsOn: z.array(z.string().min(1).max(100)).max(50).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    codingAgentMode: z.enum(["paused", "dry_run", "live"]).optional(),
  })
  .strict();

/** The normalized step the plan tools hand back and accept again. */
export const planStepSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    actionClass: z.string().min(1).max(60).optional(),
    dependsOn: z.array(z.string().min(1).max(100)).max(50),
    status: z.enum(PLAN_STEP_STATUSES),
    attempts: z.number().int().min(0),
    maxAttempts: z.number().int().min(1).max(10),
    lastError: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const planDagSchema = z.object({ steps: z.array(planStepSchema).max(100) }).strict();

export const BuildPlanInput = z.object({ steps: z.array(rawPlanStepSchema).min(1).max(100) });
export const PlanStatusInput = z.object({ plan: planDagSchema });
export const RecordStepResultInput = z.object({
  plan: planDagSchema,
  stepId: z.string().min(1).max(100),
  outcome: z.enum(["completed", "failed", "skipped"]),
  error: z.string().max(2000).optional(),
});

/** All three plan tools answer with the same view of the plan. */
export const PlanViewOutput = z.looseObject({
  plan: planDagSchema.optional(),
  progress: z
    .looseObject({
      total: z.number(),
      completed: z.number(),
      failed: z.number(),
      running: z.number(),
      pending: z.number(),
      skipped: z.number(),
      status: z.string(),
    })
    .optional(),
  readySteps: z.array(z.looseObject({ id: z.string(), title: z.string() })).optional(),
  validation: z.looseObject({ valid: z.boolean(), errors: z.array(z.string()) }).optional(),
});

export const buildPlanTool = defineTool({
  name: "loopover_build_plan",
  title: "Build plan",
  description:
    "Normalize raw steps into a validated multi-step plan DAG (per-step state + retries). Returns the plan to hold and pass back to the other plan tools.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: BuildPlanInput,
  output: PlanViewOutput,
});

export const planStatusTool = defineTool({
  name: "loopover_plan_status",
  title: "Plan status",
  description: "Return a plan's progress, validation, and the steps ready to run now (all dependencies met).",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: PlanStatusInput,
  output: PlanViewOutput,
});

export const recordStepResultTool = defineTool({
  name: "loopover_record_step_result",
  title: "Record step result",
  description:
    "Record a step's outcome (completed / failed / skipped). A failure retries until maxAttempts is exhausted. Returns the advanced plan + the next ready steps.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: RecordStepResultInput,
  output: PlanViewOutput,
});

// ── automation control surface (#784, #6087) ────────────────────────────────────────────────────

export const GetAutomationStateInput = ownerRepoInput;
export const GetAutomationStateOutput = z.looseObject({
  repoFullName: z.string().optional(),
  configured: z.boolean().optional(),
  autonomy: z.record(z.string(), z.string()).optional(),
  autoMaintain: z.looseObject({ requireApprovals: z.number(), mergeMethod: z.string() }).optional(),
  agentPaused: z.boolean().optional(),
  agentDryRun: z.boolean().optional(),
  mode: z.string().optional(),
  permissionReadiness: z.string().optional(),
  actingActionClasses: z.array(z.string()).optional(),
  pendingActionCount: z.number().optional(),
});
export const getAutomationStateTool = defineTool({
  name: "loopover_get_automation_state",
  title: "Get automation state",
  description:
    "Return a repo's agent automation state: the per-action autonomy levels, kill-switch / dry-run mode, GitHub write-permission readiness, and how many auto_with_approval actions are awaiting a maintainer decision.",
  category: "agent",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetAutomationStateInput,
  output: GetAutomationStateOutput,
});

export const SetAgentPausedInput = ownerRepoInput.extend({ paused: z.boolean() });
export const SetAgentPausedOutput = z.looseObject({
  repoFullName: z.string().optional(),
  agentPaused: z.boolean().optional(),
});
export const setAgentPausedTool = defineTool({
  name: "loopover_set_agent_paused",
  title: "Set agent paused",
  description:
    "Pause or resume ALL agent actions on a repo (the kill-switch toggle) -- the write-side counterpart to loopover_get_automation_state's agentPaused/mode fields, same as `loopover-mcp maintain pause|resume`. Maintainer access required.",
  category: "agent",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: SetAgentPausedInput,
  output: SetAgentPausedOutput,
});

export const SetActionAutonomyInput = ownerRepoInput.extend({
  action: z.enum(MAINTAIN_ACTION_CLASSES),
  level: z.enum(AUTONOMY_LEVELS),
});
export const SetActionAutonomyOutput = z.looseObject({
  repoFullName: z.string().optional(),
  action: z.string().optional(),
  level: z.string().optional(),
  autonomy: z.record(z.string(), z.string()).optional(),
});
export const setActionAutonomyTool = defineTool({
  name: "loopover_set_action_autonomy",
  title: "Set action autonomy",
  description:
    "Set the autonomy level for one action class via a read-merge-write so other classes are left untouched -- the write-side counterpart to loopover_get_automation_state's autonomy map, same as `loopover-mcp maintain set-level <action> <level>`. Maintainer access required.",
  category: "agent",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: SetActionAutonomyInput,
  output: SetActionAutonomyOutput,
});

export const ProposeActionInput = ownerRepoInput.extend({
  pullNumber: issueOrPrNumber,
  actionClass: z.enum(PROPOSE_ACTION_CLASSES),
  reason: z.string().max(500).optional(),
  label: z.string().min(1).max(100).optional(),
  reviewBody: z.string().max(WRITE_TOOL_LIMITS.bodyChars).optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  closeComment: z.string().max(WRITE_TOOL_LIMITS.bodyChars).optional(),
});
export const ProposeActionOutput = z.looseObject({
  created: z.boolean().optional(),
  action: z
    .looseObject({ id: z.string(), actionClass: z.string(), pullNumber: z.number(), status: z.string(), reason: z.string().nullable() })
    .optional(),
});
export const proposeActionTool = defineTool({
  name: "loopover_propose_action",
  title: "Propose action",
  description:
    "Stage a PR action (label / request_changes / approve / merge / close) into the repo's approval queue for a maintainer to accept or reject. Maintainer access required; the action is NOT executed until approved.",
  category: "agent",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: ProposeActionInput,
  output: ProposeActionOutput,
});

/** One row of the approval queue. Shared by the list and decide tools. */
export const pendingActionEntrySchema = z.looseObject({
  id: z.string(),
  actionClass: z.string(),
  pullNumber: z.number(),
  status: z.string(),
  autonomyLevel: z.string(),
  reason: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const ListPendingActionsInput = ownerRepoInput.extend({
  status: z.enum(["pending", "accepted", "rejected", "errored"]).optional(),
});
export const ListPendingActionsOutput = z.looseObject({
  repoFullName: z.string().optional(),
  status: z.string().optional(),
  pendingActions: z.array(pendingActionEntrySchema).optional(),
});
/**
 * The stdio server's narrowed variant, DERIVED rather than restated.
 *
 * `GET /agent/pending-actions` takes no query parameters and hardcodes status "pending", so the
 * stdio server cannot honour the filter its remote counterpart offers. An agent reads the published
 * schema to decide what to send, so advertising a filter that silently does nothing is worse than
 * not advertising it -- this is the one place in the migration where a server deliberately serves
 * LESS than the contract, and it says so in code rather than by omission.
 */
export const ListPendingActionsStdioInput = ListPendingActionsInput.omit({ status: true });

export const listPendingActionsTool = defineTool({
  name: "loopover_list_pending_actions",
  title: "List pending actions",
  description:
    "List the agent actions staged in a repo's approval queue (default status=pending), so a maintainer can review what is awaiting a decision. Maintainer access required.",
  category: "agent",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: ListPendingActionsInput,
  output: ListPendingActionsOutput,
});

export const DecidePendingActionInput = ownerRepoInput.extend({
  id: z.string().min(1),
  decision: z.enum(["accept", "reject"]),
});
export const DecidePendingActionOutput = z.looseObject({
  status: z.string().optional(),
  executionOutcome: z.string().optional(),
  action: pendingActionEntrySchema.optional(),
});
export const decidePendingActionTool = defineTool({
  name: "loopover_decide_pending_action",
  title: "Decide pending action",
  description:
    "Accept (execute) or reject a staged approval-queue action by id. Accept runs it through the live executor gates; reject cancels it. Idempotent and scoped to this repo. Maintainer access required.",
  category: "agent",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  // Accept really does execute the staged action against GitHub -- the one tool in this file that
  // performs the write itself rather than describing one.
  annotations: { readOnlyHint: false, destructiveHint: true },
  input: DecidePendingActionInput,
  output: DecidePendingActionOutput,
});

export const GetAgentAuditFeedInput = ownerRepoInput.extend({
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export const GetAgentAuditFeedOutput = z.looseObject({
  repoFullName: z.string().optional(),
  events: z
    .array(
      // `.nullish()`, not `.nullable()`: the REST route this proxies OMITS these for an event that
      // has none rather than sending an explicit null, and modelling them as merely nullable made
      // every real audit feed fail output validation (#9537).
      z.looseObject({
        eventType: z.string(),
        pullNumber: z.number().nullish(),
        outcome: z.string(),
        actor: z.string().nullish(),
        detail: z.string().nullish(),
        createdAt: z.string(),
      }),
    )
    .optional(),
});
export const getAgentAuditFeedTool = defineTool({
  name: "loopover_get_agent_audit_feed",
  title: "Get agent audit feed",
  description:
    "Return a repo's agent audit feed: executed actions (agent.action.*) and approval-queue decisions (accepted/rejected), newest first. Read-only and public-safe (action posture only). Maintainer access required.",
  category: "agent",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetAgentAuditFeedInput,
  output: GetAgentAuditFeedOutput,
});

// ── base-agent planner ──────────────────────────────────────────────────────────────────────────

export const AgentPlanInput = z.object({
  login: z.string().min(1),
  objective: z.string().min(1).max(500).optional(),
  repoFullName: z.string().min(3).optional(),
});

export const AgentPlanNextWorkOutput = AgentRunBundleOutput.extend({
  planningElicitation: z.unknown().optional(),
  planningChoices: z.unknown().optional(),
});
export const agentPlanNextWorkTool = defineTool({
  name: "loopover_agent_plan_next_work",
  title: "Agent: plan next work",
  description: "Run the deterministic LoopOver base-agent planner and rank the next Gittensor OSS contribution actions.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: AgentPlanInput,
  output: AgentPlanNextWorkOutput,
});

export const AgentExplainNextActionOutput = AgentRunBundleOutput.extend({
  topAction: z.unknown().optional(),
});
export const agentExplainNextActionTool = defineTool({
  name: "loopover_agent_explain_next_action",
  title: "Agent: explain next action",
  description: "Explain the top deterministic next action and its scoreability/risk/maintainer impact.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: AgentPlanInput,
  output: AgentExplainNextActionOutput,
});

export const AgentStartRunInput = z.object({
  objective: z.string().min(1).max(500),
  actorLogin: z.string().min(1),
  targetRepoFullName: z.string().min(3).optional(),
  targetPullNumber: issueOrPrNumber.optional(),
  targetIssueNumber: issueOrPrNumber.optional(),
});
export const agentStartRunTool = defineTool({
  name: "loopover_agent_start_run",
  title: "Agent: start run",
  description: "Create a queued copilot-only LoopOver agent run. The agent plans and explains; it does not edit code or open PRs.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: AgentStartRunInput,
  output: AgentRunBundleOutput,
});

export const AgentGetRunInput = z.object({ runId: z.string().min(1) });
export const agentGetRunTool = defineTool({
  name: "loopover_agent_get_run",
  title: "Agent: get run",
  description: "Fetch a persisted LoopOver agent run with ranked actions and context snapshots.",
  category: "agent",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: AgentGetRunInput,
  output: AgentRunBundleOutput,
});
