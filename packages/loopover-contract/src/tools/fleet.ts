// The cross-instance fleet surface (#9522).
//
// Every tool here wraps an existing `/v1/internal/*` route, which the `/v1/internal/*` middleware already
// bearer-gates with INTERNAL_JOB_TOKEN. auth "internal" is that same gate declared, so the registry is what
// the runtime enforces rather than a second, drifting description of it.
//
// availability "cloud": these read and write FLEET state -- the instance roster, installation registry,
// enrollment credentials, cross-instance analytics. A single self-hosted instance has no fleet to
// administer, and registering these there would advertise capabilities that cannot answer.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { INTERNAL_JOB_NAMES, INTERNAL_JOB_RUN_MODES } from "../enums.js";

// NO `loopover_fleet_get_analytics` here: `loopover_get_fleet_analytics` already exists and already wraps
// computeFleetAnalytics behind the same operator gate (#9522 catalog amendment). Adding a second name for
// one capability is how a catalog rots -- two tools, one implementation, and a model picking whichever it
// saw first. The incumbent keeps its name; only its category moved into "fleet" with this issue's families.

export const FleetListInstancesInput = z.object({});

export const FleetListInstancesOutput = z.looseObject({
  instances: z.array(
    z.looseObject({
      instanceId: z.string(),
      registered: z.boolean(),
      firstSeenAt: z.string().nullable(),
      lastSeenAt: z.string().nullable(),
      registeredAt: z.string().nullable(),
      signalCount: z.number(),
    }),
  ),
});

export const fleetListInstancesTool = defineTool({
  name: "loopover_fleet_list_instances",
  title: "List fleet instances",
  description:
    "Owner only. Every self-hosted ORB instance that has ingested signals, newest activity first: whether it is registered for calibration, when it was first and last seen, and how many signals it has contributed. Read-only.",
  category: "fleet",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  input: FleetListInstancesInput,
  output: FleetListInstancesOutput,
});

export const FleetRegisterInstanceInput = z.object({
  instanceId: z.string().min(1).max(200),
  registered: z.boolean().optional().describe("Defaults to true. Pass false to opt an instance OUT of fleet calibration."),
});

/**
 * `instanceSecret` is returned exactly ONCE, in plaintext, and only its hash is persisted (#9121) -- so the
 * output schema names it explicitly rather than hiding it in a loose bag. A repeat register call ROTATES it,
 * invalidating the previous value, which is why the description says so rather than leaving it to be
 * discovered by an operator whose instance stopped ingesting.
 */
export const FleetRegisterInstanceOutput = z.looseObject({
  instanceId: z.string().optional(),
  registered: z.boolean().optional(),
  instanceSecret: z.string().optional().describe("Plaintext credential, returned only on this call. Copy it into the instance's ORB_COLLECTOR_INSTANCE_SECRET now."),
});

export const fleetRegisterInstanceTool = defineTool({
  name: "loopover_fleet_register_instance",
  title: "Register a fleet instance",
  description:
    "Owner only. Opt a self-hosted ORB instance into (or, with registered=false, out of) fleet calibration. Registering MINTS A FRESH per-instance ingest credential and returns it once in plaintext — only its hash is stored, and calling this again rotates the credential, invalidating the previous one and breaking that instance's ingest until it is updated.",
  category: "fleet",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: FleetRegisterInstanceInput,
  output: FleetRegisterInstanceOutput,
});

export const FleetListInstallationsInput = z.object({});

export const FleetListInstallationsOutput = z.looseObject({});

export const fleetListInstallationsTool = defineTool({
  name: "loopover_fleet_list_installations",
  title: "List fleet installations",
  description: "Owner only. Every GitHub App installation the fleet knows about, with its recorded health. Read-only.",
  category: "fleet",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  input: FleetListInstallationsInput,
  output: FleetListInstallationsOutput,
});

export const FleetRegisterInstallationInput = z.object({
  installationId: z.number().int().positive(),
  // The route supports opting OUT, and the tool must too: without this the opt-out half of the onboarding
  // gate was unreachable over MCP, so an operator could register an install but never un-register it.
  registered: z.boolean().optional().describe("Defaults to true. Pass false to opt the installation OUT, which also blocks OAuth self-enrollment."),
});

export const FleetRegisterInstallationOutput = z.looseObject({});

export const fleetRegisterInstallationTool = defineTool({
  name: "loopover_fleet_register_installation",
  title: "Register a fleet installation",
  description:
    "Owner only. Opt a GitHub App installation into (or, with registered=false, out of) the fleet registry. Only REGISTERED installations count toward the public counter and are eligible for token brokering; opting out also blocks OAuth self-enrollment until an operator opts back in. Refuses an installation the webhook has never recorded — an install must arrive that way first.",
  category: "fleet",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: FleetRegisterInstallationInput,
  output: FleetRegisterInstallationOutput,
});

export const FleetBackfillInstallationsInput = z.object({});

export const FleetBackfillInstallationsOutput = z.looseObject({});

export const fleetBackfillInstallationsTool = defineTool({
  name: "loopover_fleet_backfill_installations",
  title: "Backfill fleet installations",
  description:
    "Owner only. Reconcile the installation registry against GitHub, adding installations the fleet has not recorded yet. Idempotent — re-running adds nothing new once reconciled.",
  category: "fleet",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: FleetBackfillInstallationsInput,
  output: FleetBackfillInstallationsOutput,
});

/**
 * Enrollments are keyed by INSTALLATION, not instance: an enrollment authorizes a self-hosted container to
 * broker tokens for a specific GitHub App installation, and the token-broker tables key on installation_id.
 * Revocation is the exception -- it takes the enrollment's own id, since one installation can have had
 * several over time and revoking "the installation" would be ambiguous.
 */
export const FleetIssueEnrollmentInput = z.object({
  installationId: z.number().int().positive(),
  rotate: z.boolean().optional().describe("Replace a live enrollment instead of refusing. Without it, an installation that already has one is a conflict."),
});

/** `secret` is shown exactly ONCE; only its hash is persisted. */
export const FleetEnrollmentOutput = z.looseObject({
  enrollId: z.string().optional(),
  secret: z.string().optional().describe("Plaintext enrollment secret, returned only on this call."),
  error: z.string().optional(),
});

export const fleetIssueEnrollmentTool = defineTool({
  name: "loopover_fleet_issue_enrollment",
  title: "Issue a fleet enrollment",
  description:
    "Owner only. Mint a token-broker enrollment secret for a REGISTERED installation, to hand to that maintainer's self-hosted container so it brokers GitHub tokens instead of holding an App key. The secret is returned exactly once and only its hash is stored. An installation that already has a live enrollment is a conflict unless rotate=true, which replaces it and invalidates the previous secret. Requires the broker to be enabled.",
  category: "fleet",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: FleetIssueEnrollmentInput,
  output: FleetEnrollmentOutput,
});

export const FleetRotateEnrollmentInput = z.object({ installationId: z.number().int().positive() });

export const fleetRotateEnrollmentTool = defineTool({
  name: "loopover_fleet_rotate_enrollment",
  title: "Rotate a fleet enrollment",
  description:
    "Owner only. Replace an installation's token-broker enrollment with a fresh secret, returned once in plaintext. The previous secret stops working immediately, so that container cannot broker tokens until it is updated. Equivalent to issuing with rotate=true.",
  category: "fleet",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: FleetRotateEnrollmentInput,
  output: FleetEnrollmentOutput,
});

export const FleetRevokeEnrollmentInput = z.object({
  // The enrollment's own id, not the installation's: one installation can have had several over time.
  enrollId: z.string().min(1).max(200),
  confirm: z.literal(true).describe("Must be exactly true. Revoking immediately stops that container brokering tokens."),
});

export const FleetRevokeEnrollmentOutput = z.looseObject({ enrollId: z.string().optional(), revoked: z.boolean().optional(), error: z.string().optional() });

export const fleetRevokeEnrollmentTool = defineTool({
  name: "loopover_fleet_revoke_enrollment",
  title: "Revoke a fleet enrollment",
  description:
    "Owner only. Revoke one token-broker enrollment by its id. Works for any secret type, and is idempotent — revoking an already-revoked enrollment still reports success. Irreversible: that container immediately loses its ability to broker GitHub tokens and must be re-enrolled. Requires confirm=true.",
  category: "fleet",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  annotations: { readOnlyHint: false, destructiveHint: true },
  input: FleetRevokeEnrollmentInput,
  output: FleetRevokeEnrollmentOutput,
});

/** Mirrors the route's own configPushSchema, which is `.strict()` -- an unknown field is a caller error. */
export const FleetConfigPushInput = z.object({
  installationIds: z.array(z.number().int().positive()).min(1).max(500).describe("Explicit targets. There is no implicit fan-out to the whole fleet."),
  pushId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/).describe("Caller-chosen id for this push, so a repeat is recognizable."),
  message: z.string().min(1).max(500),
  capability: z.string().min(1).max(120).optional(),
  deprecatesAt: z.string().max(64).optional().describe("ISO-8601 timestamp after which the pushed capability is deprecated."),
  confirm: z.literal(true).describe("Must be exactly true. A config push reaches every installation listed."),
});

export const FleetConfigPushOutput = z.looseObject({});

export const fleetConfigPushTool = defineTool({
  name: "loopover_fleet_config_push",
  title: "Push config to the fleet",
  description:
    "Operator only. Push the current configuration out to the fleet. Takes effect on every instance that picks it up, so it is not scoped to one repo or instance. Requires confirm=true.",
  category: "fleet",
  auth: "operator",
  locality: "remote",
  availability: "cloud",
  annotations: { readOnlyHint: false, destructiveHint: true },
  input: FleetConfigPushInput,
  output: FleetConfigPushOutput,
});

/**
 * ONE tool for every maintenance job, replacing the ~30 bespoke tools a per-route mapping would have
 * produced (#9522). `job` is the closed enum in enums.ts and `mode` picks enqueue-vs-run-inline; not every
 * job supports both, and INTERNAL_JOB_MODES records which, so an unsupported pairing is rejected with the
 * supported list rather than 404ing against a route that was never there.
 */
export const FleetRunJobInput = z.object({
  job: z.enum(INTERNAL_JOB_NAMES),
  mode: z.enum(INTERNAL_JOB_RUN_MODES).describe("enqueue queues the job for the worker; run executes it inline and returns its result."),
  payload: z.record(z.string(), z.unknown()).optional().describe("Job-specific body, forwarded verbatim to the route."),
});

export const FleetRunJobOutput = z.looseObject({
  job: z.string().optional(),
  mode: z.string().optional(),
  unsupportedMode: z.boolean().optional().describe("True when this job does not offer the requested mode; supportedModes lists what it does offer."),
  supportedModes: z.array(z.string()).optional(),
  result: z.unknown().optional(),
});

export const fleetRunJobTool = defineTool({
  name: "loopover_fleet_run_job",
  title: "Run a fleet maintenance job",
  description:
    "Owner only. Enqueue or inline-run one of the fleet's maintenance jobs — the interactive counterpart to the scheduled self-host-maintenance workflow, which remains the cron path. mode=enqueue queues it; mode=run executes it inline and returns its result. Not every job offers both modes; an unsupported pairing returns unsupportedMode with the list of modes that job does support.",
  category: "fleet",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: FleetRunJobInput,
  output: FleetRunJobOutput,
});

export const FLEET_TOOLS = [
  fleetListInstancesTool,
  fleetRegisterInstanceTool,
  fleetListInstallationsTool,
  fleetRegisterInstallationTool,
  fleetBackfillInstallationsTool,
  fleetIssueEnrollmentTool,
  fleetRotateEnrollmentTool,
  fleetRevokeEnrollmentTool,
  fleetConfigPushTool,
  fleetRunJobTool,
] as const;
