// The hosted control plane's tenant-provisioning API, as schemas (#9750).
//
// Three consumers, one contract. The control-plane Worker validates requests against these; the generator
// emits `control-plane/openapi.json` from them under a `--check` drift guard; and the miner's admin client
// (`packages/loopover-miner/lib/tenant-client.ts`) parses responses with them instead of casting.
//
// Before this the surface had NO machine-readable contract at all -- no zod, no spec -- and its only
// description was prose plus the hardcoded fetches in that client, whose `TenantRecord` was literally
// `Record<string, unknown>`. A caller could not learn from any artifact what a tenant even has on it.
//
// The control-plane package cannot be imported by loopover-miner (separate workspaces, no dependency edge)
// and vice versa, which is exactly why this lives in the zod-only leaf both already depend on.
import { z } from "zod";

/** Where a tenant is in its life. The control plane owns this vocabulary; nothing invents its own. */
export const TENANT_LIFECYCLE_STATES = ["provisioning", "active", "suspended", "failed", "torn down"] as const;
export type TenantLifecycleState = (typeof TENANT_LIFECYCLE_STATES)[number];

/**
 * The commands a hosted AMS tenant's scheduler may wake and run.
 *
 * Mirrors `HOSTED_CYCLE_COMMANDS` in packages/loopover-miner/lib/hosted-entry.ts. That list and this one
 * used to be two literals in two packages with comments pointing at each other and nothing checking; now
 * the miner's own list is asserted against this one, so the pointing is enforced rather than hoped for.
 */
export const HOSTED_CYCLE_COMMANDS = ["discover", "manage-poll", "attempt"] as const;
export type HostedCycleCommand = (typeof HOSTED_CYCLE_COMMANDS)[number];

/**
 * An AMS tenant's cron-wake cadence.
 *
 * `intervalMs` has no configured maximum on purpose: an operator choosing an absurdly long interval is
 * their call to make, not something this validation second-guesses.
 */
export const AmsCycleScheduleSchema = z.object({
  command: z.enum(HOSTED_CYCLE_COMMANDS),
  args: z.array(z.string()),
  intervalMs: z.number().positive(),
  nextDueAt: z.string(),
  lastRunAt: z.string().optional(),
  /** The hosted entry point's exit code from the most recent run; absent until the first one, or on timeout. */
  lastExitCode: z.number().int().optional(),
});
export type AmsCycleSchedule = z.infer<typeof AmsCycleScheduleSchema>;

/** The schedule as a CREATE request supplies it: `nextDueAt` is minted server-side, not accepted. */
export const AmsCycleScheduleRequestSchema = z.object({
  command: z.enum(HOSTED_CYCLE_COMMANDS),
  args: z.array(z.string()).optional(),
  intervalMs: z.number().positive(),
});
export type AmsCycleScheduleRequest = z.infer<typeof AmsCycleScheduleRequestSchema>;

/** A GitHub App installation ID: always a positive integer, since that is GitHub's own ID space. */
export const OrbInstallationIdSchema = z.number().int().positive();

export const TenantIdentitySchema = z.object({
  name: z.string(),
  /** Absent or null = unpinned; the tenant follows its release channel's default. */
  pinnedVersion: z.string().nullable().optional(),
});

/**
 * A tenant record as the API RETURNS it.
 *
 * Deliberately the safe projection the routes already emit: identity, product, state, and the two
 * product-specific fields, plus an OPAQUE `secretRef`. No database connection details, no injected secret,
 * no credential of any kind has ever been in this shape and none may be added to it.
 *
 * `looseObject`, not strict: an MCP output schema is a floor rather than a fence, and a client validating
 * against today's shape must not break when the control plane starts returning one more field.
 */
export const TenantRecordSchema = z.looseObject({
  tenant: TenantIdentitySchema,
  product: z.string(),
  state: z.enum(TENANT_LIFECYCLE_STATES),
  amsSchedule: AmsCycleScheduleSchema.optional(),
  orbInstallationId: OrbInstallationIdSchema.optional(),
  secretRef: z.string().optional(),
});
export type TenantRecord = z.infer<typeof TenantRecordSchema>;

/** The list route additionally carries the timestamps, which the single-record projection omits. */
export const TenantListEntrySchema = TenantRecordSchema.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TenantListEntry = z.infer<typeof TenantListEntrySchema>;

export const TenantListResponseSchema = z.object({ tenants: z.array(TenantListEntrySchema) });
export type TenantListResponse = z.infer<typeof TenantListResponseSchema>;

export const CreateTenantRequestSchema = z.object({
  name: z.string().trim().min(1),
  product: z.string().trim().min(1),
  schedule: AmsCycleScheduleRequestSchema.optional(),
  orbInstallationId: OrbInstallationIdSchema.optional(),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;

export const RelinkOrbInstallationRequestSchema = z.object({ orbInstallationId: OrbInstallationIdSchema });
export type RelinkOrbInstallationRequest = z.infer<typeof RelinkOrbInstallationRequestSchema>;

/** `product` is required on the by-name routes so the registry resolves the same `${product}:${name}` key. */
export const TenantProductQuerySchema = z.object({ product: z.string().trim().min(1) });

/**
 * The error envelope every failing route answers with.
 *
 * `message` is present on the ones that can say something useful and absent on the ones that cannot, which
 * is why it is optional rather than required-and-sometimes-empty.
 */
export const ControlPlaneErrorSchema = z.object({ error: z.string(), message: z.string().optional() });
export type ControlPlaneError = z.infer<typeof ControlPlaneErrorSchema>;

export const HealthResponseSchema = z.object({ status: z.literal("ok"), service: z.literal("control-plane") });

/** Auth posture per route. The tenant admin surface takes an admin bearer; the webhook has its own HMAC. */
export type ControlPlaneAuth = "admin-bearer" | "webhook-signature" | "public";

export type ControlPlaneRoute = {
  method: "get" | "post" | "patch" | "delete";
  /** Hono-style, so the app and the document are generated from the same string. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  auth: ControlPlaneAuth;
  request?: { body?: z.ZodTypeAny; query?: z.ZodObject };
  responses: Record<number, { description: string; schema?: z.ZodTypeAny }>;
};

const ADMIN_ERRORS = {
  401: { description: "Missing or wrong admin bearer", schema: ControlPlaneErrorSchema },
  503: { description: "No admin token is configured on this deployment, so the surface fails closed", schema: ControlPlaneErrorSchema },
};

/**
 * Every route the control plane serves.
 *
 * One table, read by the Worker's own registration and by the spec generator, so the document cannot
 * describe a route the app does not serve or miss one it does.
 */
export const CONTROL_PLANE_ROUTES: readonly ControlPlaneRoute[] = [
  {
    method: "get",
    path: "/health",
    operationId: "getControlPlaneHealth",
    summary: "Liveness probe",
    auth: "public",
    responses: { 200: { description: "The service is up", schema: HealthResponseSchema } },
  },
  {
    method: "post",
    path: "/v1/tenants",
    operationId: "createTenant",
    summary: "Provision a tenant",
    description:
      "NOT idempotent, by design: an existing tenant of the same name AND product in a non-recreatable state is a 409, not a no-op. A previously torn-down or failed tenant may be recreated — a failed provision must not become a permanent block on retrying setup — and the recreated record does not inherit the old one's createdAt.",
    auth: "admin-bearer",
    request: { body: CreateTenantRequestSchema },
    responses: {
      201: { description: "Tenant provisioned. Returns the record in its settled state.", schema: TenantRecordSchema },
      400: { description: "Unparseable body, or a field that failed validation", schema: ControlPlaneErrorSchema },
      409: { description: "A tenant of this name and product already exists, or the installation ID is already claimed", schema: ControlPlaneErrorSchema },
      ...ADMIN_ERRORS,
    },
  },
  {
    method: "get",
    path: "/v1/tenants",
    operationId: "listTenants",
    summary: "List every tenant with its lifecycle state",
    auth: "admin-bearer",
    responses: { 200: { description: "Every tenant, with timestamps", schema: TenantListResponseSchema }, ...ADMIN_ERRORS },
  },
  {
    method: "post",
    path: "/v1/tenants/rollout",
    operationId: "rolloutTenants",
    summary: "Roll a pinned image version out across tenants",
    description:
      "DISABLED, not unimplemented: the previous version silently no-opped on all four of its promised effects, so it answers 501 rather than accepting a request that changes nothing a caller can observe.",
    auth: "admin-bearer",
    responses: { 501: { description: "Tenant rollout is not implemented", schema: ControlPlaneErrorSchema }, ...ADMIN_ERRORS },
  },
  {
    method: "patch",
    path: "/v1/tenants/:name/orb-installation",
    operationId: "relinkOrbInstallation",
    summary: "Re-link an existing ORB tenant's GitHub App installation",
    description:
      "The manual recovery path for a tenant whose routing pointer was wiped by a since-fixed registry bug. Refuses to take an installation another currently-claiming tenant still holds, but never 409s a tenant against itself.",
    auth: "admin-bearer",
    request: { body: RelinkOrbInstallationRequestSchema, query: TenantProductQuerySchema },
    responses: {
      200: { description: "The installation is now linked to this tenant", schema: TenantRecordSchema },
      400: { description: "Missing product query parameter, a non-orb product, or an invalid installation ID", schema: ControlPlaneErrorSchema },
      404: { description: "No such tenant for that name and product", schema: ControlPlaneErrorSchema },
      409: { description: "Another live tenant already claims that installation", schema: ControlPlaneErrorSchema },
      ...ADMIN_ERRORS,
    },
  },
  {
    method: "delete",
    path: "/v1/tenants/:name",
    operationId: "destroyTenant",
    summary: "Tear a tenant down",
    description:
      "Refuses while the record is observably `provisioning`: there is nothing durable yet to revoke, and tearing down mid-provision races the in-flight create. Retry once it settles.",
    auth: "admin-bearer",
    request: { query: TenantProductQuerySchema },
    responses: {
      200: { description: "Tenant torn down", schema: TenantRecordSchema },
      400: { description: "Missing product query parameter", schema: ControlPlaneErrorSchema },
      404: { description: "No such tenant for that name and product", schema: ControlPlaneErrorSchema },
      409: { description: "The tenant is still provisioning", schema: ControlPlaneErrorSchema },
      ...ADMIN_ERRORS,
    },
  },
  {
    method: "post",
    path: "/v1/orb/webhook",
    operationId: "routeOrbWebhook",
    summary: "Route a GitHub webhook to the hosted ORB tenant it belongs to",
    description:
      "Deliberately outside the admin-bearer middleware: GitHub authenticates a webhook with its own HMAC signature over the raw body, not this service's admin token.",
    auth: "webhook-signature",
    responses: {
      200: { description: "Delivered to the tenant's container" },
      401: { description: "The signature did not verify", schema: ControlPlaneErrorSchema },
      502: { description: "The tenant's container could not be reached", schema: ControlPlaneErrorSchema },
      503: { description: "No webhook binding is configured on this deployment", schema: ControlPlaneErrorSchema },
    },
  },
];
