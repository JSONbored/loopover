// The AMS miner's management surface (#9523).
//
// The miner MCP exposed 11 read-only tools while its entire MUTATING ops surface was CLI-only. These add
// the mutating family, plus the two reads the catalog called for.
//
// Every mutating tool dispatches through the miner's existing governor-gated chat-action chokepoint
// (packages/loopover-miner/lib/chat-action-registry.ts), which structurally refuses any handler not produced
// by `governorGatedHandler()`. That is the same boundary the dashboard's own actions go through, so an MCP
// caller cannot reach a write path the dashboard could not -- and the structural rule is enforced by the
// registry's own brand, not by review discipline.
//
// locality "miner": these run inside the AMS bin against its local stores. availability "selfhost" for the
// same reason the ORB config-admin tools are: the stores are on that host's disk.
//
// DELIBERATELY ABSENT, recorded here so the omissions are visible rather than forgotten:
//   * calibration apply-min-rank / revert-min-rank -- stays CLI-only behind its existing double gate. An
//     agent-reachable path to loosen calibration floors is not wanted.
//   * run-state `set` -- raw run-state mutation is a repair tool, not an operation.
//   * kill-switch trip/untrip -- one-way breaker semantics stay out of agent reach; pause/resume is the
//     agent-safe control and is here instead.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { toolErrorFields } from "../shared.js";
import { INSTANCE_CHECK_STATUSES } from "../enums.js";

const RepoFullName = z.string().min(3).max(200).describe("owner/repo.");

/** Mutating tools take this so an omitted field cannot read as false and proceed. */
const DestructiveConfirm = z.literal(true).describe("Must be exactly true. Confirms an irreversible action.");

export const MinerDoctorInput = z.object({});

export const MinerDoctorOutput = z.looseObject({
  ok: z.boolean().describe("True when no check reported fail. Warnings do not clear it to false."),
  checks: z.array(z.looseObject({ name: z.string(), status: z.enum(INSTANCE_CHECK_STATUSES), detail: z.string().optional() })),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerDoctorTool = defineTool({
  name: "loopover_miner_doctor",
  title: "Diagnose this miner",
  description:
    "Read-only diagnostic checks for this AMS miner: state directory, engine version match, store reachability, credentials, and configuration. Split out of loopover_miner_status (#9523) so status stays cheap and doctor can grow checks. Every check runs and reports its own pass/warn/fail — nothing is mutated and nothing stops at the first failure.",
  category: "ops",
  auth: "token",
  locality: "miner",
  availability: "selfhost",
  input: MinerDoctorInput,
  output: MinerDoctorOutput,
});

export const MinerMetricsSnapshotInput = z.object({});

export const MinerMetricsSnapshotOutput = z.looseObject({
  // Optional: a store-failure envelope from `withMinerToolErrorHandling` carries only `error`, and
  // the MCP SDK validates structuredContent against this schema even when `isError` is set — required
  // success fields made that path a -32602 instead of a clean tool error.
  generatedAt: z.string().optional(),
  families: z
    .array(
      z.looseObject({
        name: z.string(),
        type: z.string(),
        help: z.string().optional(),
        samples: z.array(z.looseObject({ value: z.number(), labels: z.record(z.string(), z.string()).optional() })),
      }),
    )
    .optional(),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerMetricsSnapshotTool = defineTool({
  name: "loopover_miner_get_metrics_snapshot",
  title: "Read the miner's metrics snapshot",
  description:
    "The same Prometheus metric families the `metrics` CLI exports, as structured JSON — so an agent can read them without parsing the text exposition format. Read-only.",
  category: "ops",
  auth: "token",
  locality: "miner",
  availability: "selfhost",
  input: MinerMetricsSnapshotInput,
  output: MinerMetricsSnapshotOutput,
});

/**
 * Shared output for every governor-gated mutation: what happened, and what the chokepoint decided. A refusal
 * is reported as `blocked` with a `reason` rather than thrown -- the governor saying no is an ANSWER the
 * caller needs to see, and a thrown error would flatten it into a generic tool failure.
 */
export const MinerGovernorActionOutput = z.looseObject({
  ok: z.boolean().optional(),
  action: z.string().optional(),
  declined: z.boolean().optional().describe("True when the caller declined an elicited confirmation."),
  blocked: z.boolean().optional().describe("True when the governor chokepoint refused the action."),
  reason: z.string().optional(),
  result: z.unknown().optional(),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const MinerGovernorPauseInput = z.object({
  reason: z.string().max(500).optional().describe("Recorded on the pause so the audit feed says why."),
});

export const minerGovernorPauseTool = defineTool({
  name: "loopover_miner_governor_pause",
  title: "Pause the miner governor",
  description:
    "Pause this miner's governor: no new work is admitted until it resumes. Administrative control, not a content write — the same action the dashboard's pause button dispatches, through the same governor-gated chokepoint, firing the same notification side-channel. Recorded in the event ledger with source=mcp.",
  category: "ops",
  auth: "token",
  locality: "miner",
  availability: "selfhost",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: MinerGovernorPauseInput,
  output: MinerGovernorActionOutput,
});

export const MinerGovernorResumeInput = z.object({});

export const minerGovernorResumeTool = defineTool({
  name: "loopover_miner_governor_resume",
  title: "Resume the miner governor",
  description:
    "Resume this miner's governor after a pause, re-admitting work. The same action the dashboard's resume button dispatches, through the same governor-gated chokepoint. Recorded in the event ledger with source=mcp.",
  category: "ops",
  auth: "token",
  locality: "miner",
  availability: "selfhost",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: MinerGovernorResumeInput,
  output: MinerGovernorActionOutput,
});

const QueueItemTarget = z.object({
  repoFullName: RepoFullName,
  issueNumber: z.number().int().positive(),
});

export const MinerQueueReleaseInput = QueueItemTarget;

export const minerQueueReleaseTool = defineTool({
  name: "loopover_miner_queue_release",
  title: "Release a portfolio queue item",
  description:
    "Release one claimed portfolio-queue item back to unclaimed, so another cycle can pick it up. Mirrors the dashboard's release action and dispatches through the same governor-gated chokepoint. Recorded in the event ledger with source=mcp.",
  category: "ops",
  auth: "token",
  locality: "miner",
  availability: "selfhost",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: MinerQueueReleaseInput,
  output: MinerGovernorActionOutput,
});

export const MinerQueueRequeueInput = QueueItemTarget;

export const minerQueueRequeueTool = defineTool({
  name: "loopover_miner_queue_requeue",
  title: "Requeue a portfolio queue item",
  description:
    "Return one portfolio-queue item to the pending pool for another attempt. Mirrors the dashboard's requeue action and dispatches through the same governor-gated chokepoint. Recorded in the event ledger with source=mcp.",
  category: "ops",
  auth: "token",
  locality: "miner",
  availability: "selfhost",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: MinerQueueRequeueInput,
  output: MinerGovernorActionOutput,
});

export const MinerClaimReleaseInput = QueueItemTarget;

export const minerClaimReleaseTool = defineTool({
  name: "loopover_miner_claim_release",
  title: "Release a claim",
  description:
    "Release this miner's claim on one issue, so the claim ledger no longer reserves it. Dispatches through the governor-gated chokepoint and is recorded in the event ledger with source=mcp.",
  category: "ops",
  auth: "token",
  locality: "miner",
  availability: "selfhost",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: MinerClaimReleaseInput,
  output: MinerGovernorActionOutput,
});

export const MinerDenyHooksDecideInput = z.object({
  // The store keys proposals by (repo, proposalId), so the repo is required rather than guessed -- a
  // proposal id alone would force a scan across every repo's proposals to resolve one.
  repoFullName: RepoFullName,
  hookId: z.string().min(1).max(200).describe("The proposal id, from the deny-hook proposals list."),
  decision: z.enum(["approve", "reject"]),
});

export const minerDenyHooksDecideTool = defineTool({
  name: "loopover_miner_deny_hooks_decide",
  title: "Decide a pending deny-hook",
  description:
    "Approve or reject one synthesized deny-hook awaiting review. Approving puts it into force for future runs; rejecting discards it. Dispatches through the governor-gated chokepoint and is recorded in the event ledger with source=mcp.",
  category: "ops",
  auth: "token",
  locality: "miner",
  availability: "selfhost",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: MinerDenyHooksDecideInput,
  output: MinerGovernorActionOutput,
});

/**
 * No dry-run flag, deliberately: the miner's `migrate` CLI has none either. Applying a migration IS opening
 * the store, so a "preview" would have to be a second implementation of the migration walk -- and a preview
 * that drifts from the real thing is worse than no preview. Reported as applied/up-to-date per store.
 */
export const MinerRunMigrationsInput = z.object({});

/**
 * Every field the handler returns is DECLARED here rather than left to `looseObject`'s catchall: the miner
 * server registers output schemas as `.shape`, which the MCP SDK re-wraps in a plain `z.object` -- dropping
 * the catchall and rejecting any undeclared key with -32602. Same reason the sibling outputs are explicit.
 */
export const MinerRunMigrationsOutput = z.looseObject({
  ok: z.boolean().optional(),
  action: z.string().optional(),
  result: z.unknown().optional(),
  blocked: z.boolean().optional(),
  reason: z.string().optional(),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerRunMigrationsTool = defineTool({
  name: "loopover_miner_run_migrations",
  title: "Run miner store migrations",
  description:
    "Apply pending schema migrations to this miner's EXISTING local stores — it never creates a store that is not already there. Reports each store as migrated, up-to-date, or failed. There is no dry-run mode: applying a migration is opening the store, and the CLI has none either. Dispatches through the governor-gated chokepoint.",
  category: "ops",
  auth: "token",
  locality: "miner",
  availability: "selfhost",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: MinerRunMigrationsInput,
  output: MinerRunMigrationsOutput,
});

export const MinerPurgeRepoInput = z.object({
  repoFullName: RepoFullName,
  confirm: DestructiveConfirm,
});

/** Same `.shape` re-wrap constraint as above: declare everything the handler returns. */
export const MinerPurgeRepoOutput = z.looseObject({
  ok: z.boolean().optional(),
  action: z.string().optional(),
  declined: z.boolean().optional(),
  repoFullName: z.string().optional(),
  // The purge summary verbatim from the CLI's own core -- store list, counts, and timestamp.
  result: z.unknown().optional(),
  blocked: z.boolean().optional(),
  reason: z.string().optional(),
  // #9659: every miner tool answers a store failure with the shared error envelope
  // (`withMinerToolErrorHandling`), so the advertised schema declares it rather than describing only
  // the success shape. `error.code` is the closed telemetry set, which is what lets the code the caller
  // is told and the code telemetry records be the same one.
  ...toolErrorFields,
});

export const minerPurgeRepoTool = defineTool({
  name: "loopover_miner_purge_repo",
  title: "Purge a repo from every miner store",
  description:
    "Right-to-be-forgotten: delete every trace of one repo from this miner's local stores, returning the same per-store report as the CLI. IRREVERSIBLE — the rows are gone, not archived. Requires confirm=true, elicits confirmation where the client supports it, and dispatches through the governor-gated chokepoint.",
  category: "ops",
  auth: "token",
  locality: "miner",
  availability: "selfhost",
  annotations: { readOnlyHint: false, destructiveHint: true },
  input: MinerPurgeRepoInput,
  output: MinerPurgeRepoOutput,
});

export const MINER_OPS_TOOLS = [
  minerDoctorTool,
  minerMetricsSnapshotTool,
  minerGovernorPauseTool,
  minerGovernorResumeTool,
  minerQueueReleaseTool,
  minerQueueRequeueTool,
  minerClaimReleaseTool,
  minerDenyHooksDecideTool,
  minerRunMigrationsTool,
  minerPurgeRepoTool,
] as const;
