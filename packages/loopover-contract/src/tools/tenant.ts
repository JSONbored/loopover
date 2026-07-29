// The hosted control plane's tenant surface (#9522).
//
// These wrap control-plane/src/http-app.ts's `/v1/tenants*` routes. availability "cloud" is physics: the
// control plane is a separate Worker that only the hosted deployment runs, and a self-hosted instance has
// no tenants to administer.
//
// `loopover_tenant_rollout` is deliberately ABSENT. Its route is an explicit 501 (#9143): the previous
// rollout implementation silently no-opped on all four of its promised effects, and the comment there is
// blunt about why that matters -- "rollback is the control you least want to discover is fake". A rollout
// tool cannot be built on a route that changes nothing observable, and the image-side mechanism it needs
// (restart-and-repin through createContainer, or a pin baked at build time) is scoped on #9143 by this
// issue's own instruction. Adding the tool here before that mechanism exists would ship exactly the fake
// control #9143 removed.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { TENANT_PRODUCTS } from "../enums.js";

/** Every tenant route resolves by the same `${product}:${name}` registry key (#8024), so both are required. */
const TenantKey = {
  name: z.string().min(1).max(200),
  product: z.enum(TENANT_PRODUCTS),
};

export const TenantCreateInput = z.object({
  ...TenantKey,
  schedule: z.string().max(200).optional().describe('Cron-like schedule. Valid only for product "ams".'),
  orbInstallationId: z.number().int().positive().optional().describe('GitHub App installation id. Valid only for product "orb".'),
});

export const TenantCreateOutput = z.looseObject({});

export const tenantCreateTool = defineTool({
  name: "loopover_tenant_create",
  title: "Create a hosted tenant",
  description:
    "Control-plane admin only. Provision a hosted tenant: its container, database, and secrets. `schedule` is accepted only for product \"ams\" and `orbInstallationId` only for product \"orb\" — the route rejects the mismatched pairing rather than ignoring it.",
  category: "tenant",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: TenantCreateInput,
  output: TenantCreateOutput,
});

export const TenantListInput = z.object({});

export const TenantListOutput = z.looseObject({
  configured: z.boolean().optional().describe("False when this deployment administers no hosted tenants."),
  // Optional because the not-configured answer has no list to give -- a required `tenants` made that
  // perfectly valid response fail its own output schema with -32602.
  tenants: z.array(z.looseObject({ createdAt: z.string().optional(), updatedAt: z.string().optional() })).optional(),
});

export const tenantListTool = defineTool({
  name: "loopover_tenant_list",
  title: "List hosted tenants",
  description:
    "Control-plane admin only. Every hosted tenant with its status and timestamps. Read-only, and the payload is the registry's own redacted record — it carries no tenant secrets.",
  category: "tenant",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  input: TenantListInput,
  output: TenantListOutput,
});

export const TenantSetOrbInstallationInput = z.object({
  name: z.string().min(1).max(200),
  // Not the shared TenantKey enum: the route rejects any product but "orb" outright, so the schema says so.
  product: z.literal("orb"),
  orbInstallationId: z.number().int().positive(),
});

export const TenantSetOrbInstallationOutput = z.looseObject({});

export const tenantSetOrbInstallationTool = defineTool({
  name: "loopover_tenant_set_orb_installation",
  title: "Set a tenant's ORB installation",
  description:
    'Control-plane admin only. Point an existing ORB tenant at a GitHub App installation id. Valid only for product "orb".',
  category: "tenant",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: TenantSetOrbInstallationInput,
  output: TenantSetOrbInstallationOutput,
});

export const TenantDestroyInput = z.object({
  ...TenantKey,
  confirm: z.literal(true).describe("Must be exactly true. Destroying a tenant tears down its container, database, and secrets."),
});

export const TenantDestroyOutput = z.looseObject({});

export const tenantDestroyTool = defineTool({
  name: "loopover_tenant_destroy",
  title: "Destroy a hosted tenant",
  description:
    "Control-plane admin only. Tear down a hosted tenant: its container, database, and secrets. Irreversible — the tenant's data does not survive. Requires confirm=true. A tenant still provisioning is refused rather than torn down mid-flight, since there is nothing settled yet to remove.",
  category: "tenant",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  annotations: { readOnlyHint: false, destructiveHint: true },
  input: TenantDestroyInput,
  output: TenantDestroyOutput,
});

export const TENANT_TOOLS = [tenantCreateTool, tenantListTool, tenantSetOrbInstallationTool, tenantDestroyTool] as const;
