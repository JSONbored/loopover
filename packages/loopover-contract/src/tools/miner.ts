// AMS miner tool contracts (#9536).
//
// Every tool here is `locality: "miner"`: it reads the miner box's own local SQLite stores (plan,
// event ledger, governor ledger, run state, portfolio queue, claim ledger, prediction ledger).
// That is not a deployment preference -- no hosted Worker can reach those files, which is exactly
// why LoopOver runs a separate MCP server for AMS rather than collapsing to one process.
//
// Before this migration not one of these tools declared an output schema or returned
// structuredContent; every handler stringified JSON into a text block. The schemas below are
// modelled from the aggregators the handlers actually call, so the structured payload each tool
// gains is a description of what it already returns, not a new shape.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { toolErrorFields } from "../shared.js";
import { CLAIM_STATUSES, MINER_RUN_STATES, PLAN_STEP_STATUSES, QUEUE_STATUSES } from "../enums.js";

/** Statuses a portfolio-queue entry can hold. */

/** Statuses a local claim-ledger row can hold. */

/** Per-status counts, repeated at both the global and per-repo level of the dashboard. */
const queueStatusCounts = z.looseObject({
  queued: z.number(),
  in_progress: z.number(),
  done: z.number(),
});

// ── ping ────────────────────────────────────────────────────────────────────────────────────────

export const MinerPingInput = z.object({});

/** Static, and deliberately so: this tool exists to prove the server is reachable without touching
 *  any store, so its output is a fixed literal rather than anything derived. */
export const MinerPingOutput = z.looseObject({
  status: z.literal("ok"),
  tool: z.literal("loopover_miner_ping"),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerPingTool = defineTool({
  name: "loopover_miner_ping",
  title: "Miner health check",
  description:
    "Health check for the loopover-miner MCP server. Returns a static status object confirming the server is reachable. Reads no AMS state and takes no arguments.",
  category: "utility",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerPingInput,
  output: MinerPingOutput,
});

// ── portfolio dashboard ─────────────────────────────────────────────────────────────────────────

export const MinerPortfolioDashboardInput = z.object({});

/** `PortfolioDashboardSummary` (packages/loopover-miner/lib/portfolio-dashboard.ts).
 *  `oldestQueuedAgeMs` is null when no clock was supplied or nothing is queued -- a real absence,
 *  not a zero. */
export const MinerPortfolioDashboardOutput = z.looseObject({
  total: z.number(),
  byStatus: queueStatusCounts,
  repos: z.array(
    z.looseObject({
      apiBaseUrl: z.string(),
      repoFullName: z.string(),
      byStatus: queueStatusCounts,
      total: z.number(),
    }),
  ),
  oldestQueuedAgeMs: z.number().nullable(),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerPortfolioDashboardTool = defineTool({
  name: "loopover_miner_get_portfolio_dashboard",
  title: "Miner portfolio dashboard",
  description:
    "Read-only per-repo portfolio-queue backlog dashboard: status counts (queued/in_progress/done), totals, and the oldest-queued age in ms. Wraps the existing collectPortfolioDashboard aggregator (no new logic) -- the same data `loopover-miner queue dashboard --json` prints locally. Takes no arguments; mutates nothing.",
  category: "agent",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerPortfolioDashboardInput,
  output: MinerPortfolioDashboardOutput,
});

// ── manage status ───────────────────────────────────────────────────────────────────────────────

/** `ManageStatusRow`. Every field but the identifiers is nullable: a PR can be tracked before CI
 *  has reported, before the gate has run, and before it has an outcome. */
export const manageStatusRowSchema = z.looseObject({
  repoFullName: z.string(),
  prNumber: z.number(),
  branch: z.string().nullable(),
  ciState: z.string().nullable(),
  gateVerdict: z.string().nullable(),
  outcome: z.string().nullable(),
  lastPolledAt: z.string().nullable(),
  queueStatus: z.enum(QUEUE_STATUSES).nullable(),
  priority: z.number().nullable(),
});

export const MinerManageStatusInput = z.object({});

/** `{ rows, runPortfolio }` -- the same pair `manage status --json` prints. */
export const MinerManageStatusOutput = z.looseObject({
  rows: z.array(manageStatusRowSchema),
  runPortfolio: z.array(
    z.looseObject({
      repoFullName: z.string(),
      runState: z.string().nullable(),
      runStateUpdatedAt: z.string().nullable(),
      prCount: z.number(),
      prs: z.array(manageStatusRowSchema),
    }),
  ),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerManageStatusTool = defineTool({
  name: "loopover_miner_get_manage_status",
  title: "Miner manage-phase status",
  description:
    "Read-only manage-phase status: the per-managed-PR rows `loopover-miner manage status` reports (branch, CI state, gate verdict, outcome, last-polled-at, queue status/priority) plus the run-level portfolio view (one row per tracked repo: run state, updated-at, PR count). Joins the portfolio queue, the append-only event ledger, and run-state by reusing the existing collectManageStatus/collectRunPortfolio aggregators -- no new join logic. Read-only: never calls GitHub, never mutates local stores. Takes no arguments.",
  category: "agent",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerManageStatusInput,
  output: MinerManageStatusOutput,
});

// ── claims ──────────────────────────────────────────────────────────────────────────────────────

export const MinerListClaimsInput = z.object({
  repoFullName: z.string().optional(),
  status: z.enum(CLAIM_STATUSES).optional(),
});

/** The ledger's own row shape. Left open below the named fields because `listClaims` returns rows
 *  straight from SQLite, and the store has added columns over time without the MCP surface
 *  changing -- pinning it closed would make the next column a breaking change. */
export const MinerListClaimsOutput = z.looseObject({
  claims: z.array(
    z.looseObject({
      repoFullName: z.string(),
      issueNumber: z.number(),
      status: z.string(),
      claimedAt: z.string().nullish(),
      note: z.string().nullish(),
    }),
  ),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerListClaimsTool = defineTool({
  name: "loopover_miner_list_claims",
  title: "List miner claims",
  description:
    "Read-only listing of the local claim ledger: which issues this miner has claimed (repo, issue number, status, claimed-at, note). Optional repoFullName/status filters pass through to the existing listClaims query. Exposes no claim/release mutation and no conflict-resolution logic.",
  category: "agent",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerListClaimsInput,
  output: MinerListClaimsOutput,
});

// ── audit feed ──────────────────────────────────────────────────────────────────────────────────

export const MinerAuditFeedInput = z.object({
  repoFullName: z.string().min(1).optional(),
  since: z.number().int().nonnegative().optional(),
  type: z.string().min(1).optional(),
});

/** `{ repoFullName?, events }` -- `collectEventLedgerAuditFeed`'s real return shape. Each event is
 *  metadata only: `payload_json` and other raw ledger columns are never included by construction
 *  (an explicit named-column read, not a redaction step). */
export const MinerAuditFeedOutput = z.looseObject({
  repoFullName: z.string().optional(),
  events: z.array(
    z.looseObject({
      eventType: z.string(),
      repoFullName: z.string().nullable(),
      outcome: z.string().nullable(),
      actor: z.string().nullable(),
      detail: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerAuditFeedTool = defineTool({
  name: "loopover_miner_get_audit_feed",
  title: "Miner audit feed",
  description:
    "Read-only, metadata-only audit feed from the local append-only event ledger: eventType, repoFullName, outcome, actor, detail, and createdAt per row. Wraps collectEventLedgerAuditFeed() (no new query logic) -- the same read filters as `loopover-miner ledger list` (--repo, --since, --type). Never returns payload_json or other raw ledger columns; never writes to the ledger.",
  category: "agent",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerAuditFeedInput,
  output: MinerAuditFeedOutput,
});

// ── run state ───────────────────────────────────────────────────────────────────────────────────

/** `RunState` (packages/loopover-miner/lib/run-state.ts). */

export const MinerGetRunStateInput = z.object({
  repoFullName: z.string().min(1).optional(),
});

/** Two distinct shapes depending on whether `repoFullName` was supplied -- a single-repo lookup
 *  (whose `state` is null when nothing has been recorded yet) versus the full listing. Both fields
 *  optional here so one schema describes both without a discriminated union, which the MCP output
 *  schema does not need to enforce mutual exclusivity to be useful. */
export const MinerGetRunStateOutput = z.looseObject({
  repoFullName: z.string().optional(),
  state: z.enum(MINER_RUN_STATES).nullable().optional(),
  states: z.array(z.looseObject({ repoFullName: z.string(), state: z.enum(MINER_RUN_STATES).nullable() })).optional(),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerGetRunStateTool = defineTool({
  name: "loopover_miner_get_run_state",
  title: "Miner run state",
  description:
    "Read-only per-repo miner run-state (idle/discovering/planning/preparing). Pass repoFullName for a single repo (a null state means none has been recorded for it yet), or omit it to list every repo's state. The read-only analog of ORB's loopover_get_automation_state; adds no state-set or mutation capability.",
  category: "agent",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerGetRunStateInput,
  output: MinerGetRunStateOutput,
});

// ── plan store ──────────────────────────────────────────────────────────────────────────────────

/** `PlanStatus` (packages/loopover-miner/lib/plan-store.ts). */
export const MINER_PLAN_STATUSES = ["pending", "running", "completed", "failed"] as const;

/** `PlanStepStatus`, same file. Aliases the shared vocabulary rather than restating it -- the plan
 *  store and the remote plan-DAG tools move the same steps through the same states. */
export const MINER_PLAN_STEP_STATUSES = PLAN_STEP_STATUSES;

/** `PlanStep`. `lastError` is nullish (both unset and explicit null appear -- the store's own type
 *  spells it `string | null | undefined`). */
export const minerPlanStepSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  actionClass: z.string().optional(),
  dependsOn: z.array(z.string()),
  status: z.enum(MINER_PLAN_STEP_STATUSES),
  attempts: z.number(),
  maxAttempts: z.number(),
  lastError: z.string().nullish(),
});

/** `PlanDag`. */
export const minerPlanDagSchema = z.looseObject({
  steps: z.array(minerPlanStepSchema),
});

/** `PlanRecord`. */
export const minerPlanRecordSchema = z.looseObject({
  planId: z.string(),
  plan: minerPlanDagSchema,
  status: z.enum(MINER_PLAN_STATUSES),
  updatedAt: z.string(),
});

export const MinerListPlansInput = z.object({
  status: z.enum(MINER_PLAN_STATUSES).optional(),
});

export const MinerListPlansOutput = z.looseObject({
  plans: z.array(minerPlanRecordSchema),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerListPlansTool = defineTool({
  name: "loopover_miner_list_plans",
  title: "List miner plans",
  description:
    "Read-only list of the miner's PERSISTED plan store (planId, plan DAG, status, updatedAt), optionally filtered by status. Wraps plan-store.js's existing listPlans query -- no new logic, no mutation. NOTE: this is the store-backed AMS plan store; it is distinct from ORB's stateless loopover_plan_status tool, which reads the caller's in-memory plan object rather than any persisted store.",
  category: "agent",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerListPlansInput,
  output: MinerListPlansOutput,
});

export const MinerGetPlanInput = z.object({
  planId: z.string().min(1),
});

/** `{ planId, found: false }` for an unknown id, or `{ found: true, plan }` -- deliberately not a
 *  discriminated union in the schema for the same reason as get_run_state above. */
export const MinerGetPlanOutput = z.looseObject({
  planId: z.string().optional(),
  found: z.boolean(),
  plan: minerPlanRecordSchema.optional(),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerGetPlanTool = defineTool({
  name: "loopover_miner_get_plan",
  title: "Get miner plan",
  description:
    "Read-only fetch of one persisted plan record by planId (the full plan DAG, status, updatedAt), or an explicit { planId, found: false } for an unknown id. Wraps plan-store.js's existing loadPlan lookup -- no mutation, no DAG/planning logic. Store-backed AMS plan store; distinct from ORB's stateless loopover_plan_status tool.",
  category: "agent",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerGetPlanInput,
  output: MinerGetPlanOutput,
});

// ── governor decisions ──────────────────────────────────────────────────────────────────────────

export const MinerGovernorDecisionsInput = z.object({
  repoFullName: z.string().optional(),
});

/** `GovernorDecisionEntry` = `Omit<GovernorLedgerEntry, "payload">` -- the raw `payload` column is
 *  excluded by an explicit named-column SELECT, not filtered after the fact. */
export const MinerGovernorDecisionsOutput = z.looseObject({
  decisions: z.array(
    z.looseObject({
      id: z.number(),
      ts: z.string(),
      eventType: z.string(),
      repoFullName: z.string().nullable(),
      actionClass: z.string(),
      decision: z.string(),
      reason: z.string(),
    }),
  ),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerGovernorDecisionsTool = defineTool({
  name: "loopover_miner_get_governor_decisions",
  title: "Miner governor decisions",
  description:
    "Read-only governor decision log: every accept/deny decision the local governor recorded, with its reason -- an explicit named-column SELECT, never SELECT *. Optional repoFullName filter (the only filter the ledger's readGovernorDecisions accepts). Excludes the raw payload column by construction; adds no decision-making, override, or write capability.",
  category: "agent",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerGovernorDecisionsInput,
  output: MinerGovernorDecisionsOutput,
});

// ── status + doctor ─────────────────────────────────────────────────────────────────────────────

export const MinerStatusInput = z.object({});

/** `{ status: MinerStatus, doctor: DoctorCheck[] }`. `MinerStatus`/`DoctorCheck`/`MinerDriverStatus`
 *  are all in packages/loopover-miner/lib/status.ts. Deliberately names/booleans/paths only, never
 *  an env-var VALUE, token, key, or credential -- `modelEnvVar` is the variable's NAME. */
export const MinerStatusOutput = z.looseObject({
  status: z.looseObject({
    package: z.looseObject({ name: z.string(), version: z.string().nullable() }),
    engine: z.looseObject({ name: z.string(), version: z.string().nullable() }),
    node: z.string(),
    stateDir: z.string(),
    configFile: z.string().nullable(),
    driver: z.looseObject({
      provider: z.string().nullable(),
      modelEnvVar: z.string().nullable(),
      cliPresent: z.boolean().nullable(),
    }),
  }),
  doctor: z.array(z.looseObject({ name: z.string(), ok: z.boolean(), detail: z.string() })),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerStatusTool = defineTool({
  name: "loopover_miner_status",
  title: "Miner status and doctor",
  description:
    "Read-only miner status + doctor diagnostics. Returns { status, doctor }: status = package/engine versions (+ skew), node version, state-dir path, config-file path, and the resolved coding-agent driver (provider name, the model ENV-VAR NAME -- never its value -- and a CLI-present boolean); doctor = the same checks `loopover-miner doctor` runs (Docker/CLI presence, config validity, ...) as { name, ok, detail }. Reuses collectStatus/runDoctorChecks so it can never drift from the CLI. Only names / booleans / paths -- never any env-var value, token, key, or credential. Read-only; no writes or state changes.",
  category: "utility",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerStatusInput,
  output: MinerStatusOutput,
});

// ── calibration report ──────────────────────────────────────────────────────────────────────────

export const MinerCalibrationReportInput = z.object({});

/** `CalibrationReport` (packages/loopover-miner/lib/calibration-types.ts). `hasSignal` is true once
 *  at least one project has enough decided samples to read meaningfully; the two precision fields
 *  are null until then, not zero. */
export const MinerCalibrationReportOutput = z.looseObject({
  rows: z.array(
    z.looseObject({
      project: z.string(),
      wouldMerge: z.number(),
      mergeConfirmed: z.number(),
      mergeFalse: z.number(),
      wouldClose: z.number(),
      closeConfirmed: z.number(),
      closeFalse: z.number(),
      hold: z.number(),
      decided: z.number(),
      mergePrecision: z.number().nullable(),
      closePrecision: z.number().nullable(),
    }),
  ),
  hasSignal: z.boolean(),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerCalibrationReportTool = defineTool({
  name: "loopover_miner_get_calibration_report",
  title: "Miner calibration report",
  description:
    "Read-only miner-local prediction-accuracy report: per-project merge/close precision, joining this miner's own recorded gate predictions (prediction ledger) with the realized PR outcomes it later observed (pr_outcome events). Wraps calibration-cli.js's existing toPredictionRecords/toOutcomeRecords mappers and calibration.js's buildCalibrationReport composer -- no new join/scoring logic, no mutation. Strictly local and offline; distinct from ORB's hosted, maintainer-authenticated loopover_get_outcome_calibration tool, which reads a different (D1) data source. Takes no arguments.",
  category: "agent",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerCalibrationReportInput,
  output: MinerCalibrationReportOutput,
});
