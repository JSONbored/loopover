// The operator queue + safety surface (#9522).
//
// These wrap routes that already exist under `/v1/app/*` and are gated by `requireAppRole(["operator"])`.
// They add no write path of their own: each calls the SAME service function its HTTP route calls, so the
// two transports cannot drift into two behaviors, and every mutation keeps the route's audit event.
//
// availability "both": the dead-letter tools reach the queue backend through the `env.JOBS` binding mirror,
// which only the self-host queue exposes -- on Cloudflare the plain Queue binding has none of those methods
// and the route answers 501 `dead_letter_admin_unavailable`. That is a runtime capability answer, not a
// registration-time one, so the tools are registered on both deployments and report the same structured
// unavailability rather than vanishing from the catalog.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";

/**
 * Every destructive tool in this family takes this literal (#9522 requirement 2). `z.literal(true)` and not
 * `z.boolean()`: a model that omits the field, or passes `false` "to be safe", must fail the schema rather
 * than silently proceed -- omission is the common failure mode, and a plain boolean makes it invisible.
 */
export const DestructiveConfirm = z.literal(true).describe("Must be exactly true. Confirms an irreversible action.");

/** Shared by the three single-job tools; the id is the self-host queue's own row id. */
const DeadLetterJobId = z.number().int().positive().describe("The dead-letter job's id, from loopover_ops_list_dead_letter_jobs.");

/**
 * `unavailable` is how a deployment without dead-letter admin answers -- the 501 the route returns, surfaced
 * as a normal result rather than a tool error, because "this backend has no DLQ" is an answer to the
 * question, not a failure to answer it.
 */
const DeadLetterUnavailable = {
  unavailable: z.boolean().optional().describe("True when this deployment's queue backend exposes no dead-letter admin."),
  message: z.string().optional(),
};

export const OpsListDeadLetterJobsInput = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

export const OpsListDeadLetterJobsOutput = z.looseObject({
  ...DeadLetterUnavailable,
  generatedAt: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  total: z.number().optional(),
  items: z.array(z.looseObject({ id: z.number() })).optional(),
});

export const opsListDeadLetterJobsTool = defineTool({
  name: "loopover_ops_list_dead_letter_jobs",
  title: "List dead-letter jobs",
  description:
    "Operator only. Page the self-hosted queue's dead-letter table: jobs that exhausted their retries and are parked for inspection. Read-only. Returns unavailable=true on a deployment whose queue backend exposes no dead-letter admin (Cloudflare Queues).",
  category: "ops",
  auth: "operator",
  locality: "remote",
  availability: "both",
  input: OpsListDeadLetterJobsInput,
  output: OpsListDeadLetterJobsOutput,
});

export const OpsReplayDeadLetterJobInput = z.object({ id: DeadLetterJobId });

export const OpsReplayDeadLetterJobOutput = z.looseObject({
  ...DeadLetterUnavailable,
  ok: z.boolean().optional(),
  id: z.number().optional(),
  notFound: z.boolean().optional(),
});

export const opsReplayDeadLetterJobTool = defineTool({
  name: "loopover_ops_replay_dead_letter_job",
  title: "Replay a dead-letter job",
  description:
    "Operator only. Re-enqueue one parked dead-letter job for another attempt. Records an operator.dlq_job_replayed audit event. Returns notFound=true if the id is already gone, unavailable=true where the queue backend has no dead-letter admin.",
  category: "ops",
  auth: "operator",
  locality: "remote",
  availability: "both",
  // Mutating but not destructive: replaying re-enqueues the job, it does not discard anything.
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: OpsReplayDeadLetterJobInput,
  output: OpsReplayDeadLetterJobOutput,
});

export const OpsDeleteDeadLetterJobInput = z.object({ id: DeadLetterJobId, confirm: DestructiveConfirm });

export const OpsDeleteDeadLetterJobOutput = OpsReplayDeadLetterJobOutput;

export const opsDeleteDeadLetterJobTool = defineTool({
  name: "loopover_ops_delete_dead_letter_job",
  title: "Delete a dead-letter job",
  description:
    "Operator only. Permanently drop one parked dead-letter job. Irreversible — the job is not re-enqueued and its payload is gone. Requires confirm=true. Records an operator.dlq_job_deleted audit event.",
  category: "ops",
  auth: "operator",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false, destructiveHint: true },
  input: OpsDeleteDeadLetterJobInput,
  output: OpsDeleteDeadLetterJobOutput,
});

export const OpsPurgeDeadLetterJobsInput = z.object({ confirm: DestructiveConfirm });

export const OpsPurgeDeadLetterJobsOutput = z.looseObject({
  ...DeadLetterUnavailable,
  ok: z.boolean().optional(),
  purged: z.number().optional(),
});

export const opsPurgeDeadLetterJobsTool = defineTool({
  name: "loopover_ops_purge_dead_letter_jobs",
  title: "Purge every dead-letter job",
  description:
    "Operator only. Permanently drop ALL parked dead-letter jobs. Irreversible and unbounded — prefer deleting individual ids unless the whole table is known-garbage. Requires confirm=true. Records an operator.dlq_purged audit event.",
  category: "ops",
  auth: "operator",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false, destructiveHint: true },
  input: OpsPurgeDeadLetterJobsInput,
  output: OpsPurgeDeadLetterJobsOutput,
});

export const OpsGetKillSwitchInput = z.object({});

export const OpsGetKillSwitchOutput = z.looseObject({
  frozen: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  generatedAt: z.string(),
});

export const opsGetKillSwitchTool = defineTool({
  name: "loopover_ops_get_kill_switch",
  title: "Read the global agent kill switch",
  description:
    "Operator only. Report whether the global agent kill switch is engaged, and who set it when. Reads strictly — unlike the enforcement hot path, a read failure here surfaces as an error rather than a falsely reassuring 'unfrozen'.",
  category: "ops",
  auth: "operator",
  locality: "remote",
  availability: "both",
  input: OpsGetKillSwitchInput,
  output: OpsGetKillSwitchOutput,
});

export const OpsSetKillSwitchInput = z.object({
  frozen: z.boolean().describe("True freezes every agent action fleet-wide; false releases the freeze."),
  // Freezing is the safe direction and needs no ceremony; UNfreezing re-arms automation across the whole
  // deployment, which is the irreversible-in-effect direction, so only that one demands the literal.
  confirm: z.literal(true).optional().describe("Required (exactly true) when frozen=false, which re-arms fleet-wide automation."),
});

export const OpsSetKillSwitchOutput = OpsGetKillSwitchOutput;

export const opsSetKillSwitchTool = defineTool({
  name: "loopover_ops_set_kill_switch",
  title: "Set the global agent kill switch",
  description:
    "Operator only. Engage or release the global agent kill switch. Engaging (frozen=true) halts every agent action fleet-wide immediately. RELEASING (frozen=false) re-arms automation everywhere and requires confirm=true. Records an audit event either way.",
  category: "ops",
  auth: "operator",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false, destructiveHint: true },
  input: OpsSetKillSwitchInput,
  output: OpsSetKillSwitchOutput,
});

export const OpsGetOperatorDashboardInput = z.object({
  days: z.number().int().min(1).max(90).optional().describe("Trailing window in days; clamped to the dashboard's own supported range."),
});

export const OpsGetOperatorDashboardOutput = z.looseObject({});

export const opsGetOperatorDashboardTool = defineTool({
  name: "loopover_ops_get_operator_dashboard",
  title: "Read the operator dashboard",
  description:
    "Operator only. The operator dashboard rollup over a trailing window: the same payload the HTTP dashboard route serves. Read-only.",
  category: "ops",
  auth: "operator",
  locality: "remote",
  availability: "both",
  input: OpsGetOperatorDashboardInput,
  output: OpsGetOperatorDashboardOutput,
});

export const OPS_TOOLS = [
  opsListDeadLetterJobsTool,
  opsReplayDeadLetterJobTool,
  opsDeleteDeadLetterJobTool,
  opsPurgeDeadLetterJobsTool,
  opsGetKillSwitchTool,
  opsSetKillSwitchTool,
  opsGetOperatorDashboardTool,
] as const;
