// The hosted AMS tenant surface (#9523, #9199).
//
// CATALOG AMENDMENT, recorded here rather than improvised: #9523 listed
// `loopover_ams_tenant_create` / `_list` / `_destroy`, and they are NOT here. #9522 landed
// `loopover_tenant_create` / `_list` / `_destroy` taking a `product` of "ams" or "orb", because the control
// plane's own `/v1/tenants` routes are product-parameterized and key their registry by `${product}:${name}`.
// A second, AMS-only spelling of those three would be two names for one capability -- the same rot that kept
// `loopover_fleet_get_analytics` out of #9522 -- and would leave an agent guessing which to call. Use the
// product-parameterized tools with `product: "ams"`.
//
// What IS genuinely AMS-specific, and therefore here, is the pair that has no ORB counterpart: a tenant's
// wake schedule and cycle outcomes, and the ability to trigger a cycle now.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";

const TenantName = z.string().min(1).max(200);

export const AmsTenantHealthInput = z.object({
  name: TenantName.describe("The tenant's name, as reported by loopover_tenant_list with product=ams."),
});

export const AmsTenantHealthOutput = z.looseObject({
  configured: z.boolean().describe("False when this deployment administers no hosted tenants."),
  name: z.string().optional(),
  state: z.string().optional().describe("The control plane's own lifecycle vocabulary, passed through verbatim."),
  schedule: z.string().nullable().optional().describe("The cron-wake cadence, or null when the tenant wakes only on demand."),
  lastWakeAt: z.string().nullable().optional(),
  lastCycleOutcome: z.string().nullable().optional(),
  containerHealthy: z.boolean().nullable().optional(),
  error: z.string().optional(),
});

export const amsTenantHealthTool = defineTool({
  name: "loopover_ams_tenant_health",
  title: "Read a hosted AMS tenant's health",
  description:
    "Operator only. One hosted AMS tenant's health: lifecycle state, its cron-wake cadence, when it last woke, that cycle's outcome, and container health. Read-only, and scoped server-side to the authenticated tenant — a name outside that scope is refused rather than answered.",
  category: "tenant",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  input: AmsTenantHealthInput,
  output: AmsTenantHealthOutput,
});

export const AmsTenantWakeInput = z.object({
  name: TenantName,
});

export const AmsTenantWakeOutput = z.looseObject({
  configured: z.boolean(),
  name: z.string().optional(),
  woken: z.boolean().optional(),
  throttled: z.boolean().optional().describe("True when the tenant's own schedule guard refused a wake this soon after the last one."),
  error: z.string().optional(),
});

export const amsTenantWakeTool = defineTool({
  name: "loopover_ams_tenant_wake",
  title: "Wake a hosted AMS tenant now",
  description:
    "Operator only. Trigger an immediate cycle for one hosted AMS tenant, instead of waiting for its next scheduled wake. Bounded by the SAME per-tenant schedule guards the cron path obeys — a wake too soon after the last one is reported as throttled rather than forced through.",
  category: "tenant",
  auth: "internal",
  locality: "remote",
  availability: "cloud",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: AmsTenantWakeInput,
  output: AmsTenantWakeOutput,
});

export const AMS_TENANT_TOOLS = [amsTenantHealthTool, amsTenantWakeTool] as const;
