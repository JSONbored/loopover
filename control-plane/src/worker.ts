// Cloudflare Worker entry point for control-plane's real HTTP transport (#7654) and, as of #7851, real
// tenant container lifecycle. Pure infra glue: wires the real KV-backed tenant registry, the admin Bearer
// secret, and whichever `TenantProvisioningDriver` pieces are configured (real Neon database driver if
// NEON_API_KEY/NEON_PROJECT_ID are set, real Cloudflare Containers driver for the two bindings below -- see
// driver-factory.ts) into the plain, already-tested Hono app (http-app.ts). Adds NO route logic of its own.
//
// Not unit-tested: exercised only by real Cloudflare Workers/KV/Containers infrastructure, matching
// packages/discovery-index/src/worker.ts's own identical exclusion (see scripts/control-plane-coverage.ts).
import { Container } from "@cloudflare/containers";
import { wakeDueAmsTenants } from "./ams-wake.js";
import { createTenantProvisioningDriver } from "./driver-factory.js";
import { createTenantHttpApp } from "./http-app.js";
import { createKvTenantRegistry } from "./tenant-registry.js";

const PROVISIONED_STORAGE_KEY = "provisioned";

// #9143 (defect 4): the env map createTenantContainer (container-driver.ts) hands to a tenant's ONE-TIME
// cold-boot `start({envVars})` call is otherwise only ever held in the vendored `@cloudflare/containers`
// SDK's own `this.envVars` instance property (a plain class field, default `{}`) -- confirmed against that
// package's source (node_modules/@cloudflare/containers/dist/lib/container.js): `doStartContainer` resolves
// `options?.envVars ?? this.envVars`, and NOTHING in the SDK ever assigns `this.envVars` from a bare
// `start(options)` call -- only this class's OWN constructor `options` (never supplied here) does. A tenant
// container's auto-wake-on-request path after it sleeps (`containerFetch`'s implicit restart, which calls
// `start()` with NO options at all) therefore falls through to `this.envVars`, which resets to `{}` on every
// FRESH instance of this class -- a Durable Object's in-memory fields do not survive eviction, only
// `ctx.storage` does. A tenant's pinned version / bootstrap secret / central PostHog key would silently
// vanish from its container's environment on its very next restart. Fixed the same way
// PROVISIONED_STORAGE_KEY already is: persisted in this DO's own durable storage and reloaded into
// `this.envVars` in the constructor, via `ctx.blockConcurrencyWhile` -- the exact pattern the base `Container`
// class's own constructor already uses for its own async setup -- so no request or implicit restart can ever
// reach `doStartContainer` before the persisted value is back in place.
const ENV_VARS_STORAGE_KEY = "envVars";

/** Shared base for both product-specific Container classes below: tracks whether THIS tenant's container has
 *  been explicitly provisioned, in the DO's own durable storage -- independent of Cloudflare's own transient
 *  container run-state (`getState()`'s running/stopped/stopped_with_code/etc). That distinction is
 *  load-bearing, concretely for AMS: its one-shot CLI image (see AmsTenantContainer below) is EXPECTED to sit
 *  in a "stopped"-shaped run state almost all the time by design (#7182), indistinguishable from "never
 *  provisioned" using run-state alone -- container-driver.ts's header comment covers this in full. */
class ProvisionedContainer extends Container<Env> {
  // `DurableObjectState<Record<string, never>>` matches the vendored SDK's own `Container<Env>`'s inherited
  // `ctx` type exactly (it extends `cloudflare:workers`' `DurableObject<Env, Props = {}>`, whose `Props`
  // defaults to an empty-object shape) -- `DurableObjectState` alone defaults its own generic to `unknown`,
  // which `super(ctx, env)` below then rejects as too loose.
  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env);
    // Not awaited (constructors can't be async) -- `ctx.blockConcurrencyWhile` itself is what defers every
    // future request/alarm on this DO until the callback resolves, same fire-and-forget shape the base
    // `Container` constructor already uses internally for its own setup.
    ctx.blockConcurrencyWhile(async () => {
      const persisted = await ctx.storage.get<Record<string, string>>(ENV_VARS_STORAGE_KEY);
      if (persisted) this.envVars = persisted;
    });
  }
  async isProvisioned(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>(PROVISIONED_STORAGE_KEY)) === true;
  }
  async markProvisioned(envVars?: Record<string, string>): Promise<void> {
    await this.ctx.storage.put(PROVISIONED_STORAGE_KEY, true);
    if (envVars && Object.keys(envVars).length > 0) {
      await this.ctx.storage.put(ENV_VARS_STORAGE_KEY, envVars);
    }
  }
  async markDeprovisioned(): Promise<void> {
    await this.ctx.storage.delete(PROVISIONED_STORAGE_KEY);
    await this.ctx.storage.delete(ENV_VARS_STORAGE_KEY);
  }
}

/** ORB's tenant container (#7173's ratified one-container-per-tenant-per-product model): runs the SAME root
 *  Dockerfile self-host image unmodified, on the port that image's own PORT env var / HEALTHCHECK already
 *  use. `defaultPort` is what `Container.fetch()` proxies to -- orb-webhook-router.ts (#7181) is the thing
 *  that actually calls it, waking this container on demand when a webhook for this tenant arrives. */
export class OrbTenantContainer extends ProvisionedContainer {
  defaultPort = 8787;
  sleepAfter = "10m";
}

/** AMS's tenant container: packages/loopover-miner/Dockerfile's own image, unmodified -- a one-shot CLI tool
 *  (`ENTRYPOINT ["loopover-miner"]`, no long-running HTTP server, per that Dockerfile's own header comment
 *  "batch/CLI workload... not a long-running HTTP service"). Deliberately no `defaultPort`: nothing here
 *  needs `Container.fetch()`'s HTTP-proxying, since #7182 (cron wake) runs one-shot subcommands via a
 *  per-invocation entrypoint override, not HTTP. Sleeps quickly -- #7182's own "sleeping, zero-cost
 *  container" model expects this dormant almost all the time, briefly woken on a per-tenant cron schedule. */
export class AmsTenantContainer extends ProvisionedContainer {
  sleepAfter = "1m";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const driver = createTenantProvisioningDriver(
      // #8066: MAIN_APP_BASE_URL/INTERNAL_JOB_TOKEN select the real secret driver (against the main app's
      // token broker) once both are configured, same opt-in-per-piece shape as NEON_API_KEY/NEON_PROJECT_ID.
      // #7876: CENTRAL_POSTHOG_KEY threads into every tenant container so the hosted fleet reports to the
      // loopover-owned PostHog project (#7875); unset ⇒ omitted, tenants byte-identical to before.
      { NEON_API_KEY: env.NEON_API_KEY, NEON_PROJECT_ID: env.NEON_PROJECT_ID, MAIN_APP_BASE_URL: env.MAIN_APP_BASE_URL, INTERNAL_JOB_TOKEN: env.INTERNAL_JOB_TOKEN, CENTRAL_POSTHOG_KEY: env.CENTRAL_POSTHOG_KEY },
      { orb: env.ORB_TENANT_CONTAINER, ams: env.AMS_TENANT_CONTAINER },
    );
    const app = createTenantHttpApp({
      driver,
      registry: createKvTenantRegistry(env.TENANT_REGISTRY),
      adminToken: env.ADMIN_TOKEN,
      // provisionTenant/deprovisionTenant's own PagerDuty paging (#7667) defaults to reading `process.env`,
      // a real-Node-only assumption -- explicitly forwarding the Worker's own bindings here is what makes
      // paging actually configurable in this deployment, rather than silently reading an empty process.env.
      pagerDuty: { env: { LOOPOVER_ENABLE_PAGERDUTY: env.LOOPOVER_ENABLE_PAGERDUTY, PAGERDUTY_ROUTING_KEY: env.PAGERDUTY_ROUTING_KEY } },
      // #7181: routes incoming GitHub webhooks to the right hosted ORB tenant's container. A SEPARATE secret
      // from the main app's own `ORB_GITHUB_WEBHOOK_SECRET` (a different physical service) -- see
      // orb-webhook-router.ts's header comment.
      orbWebhookBinding: env.ORB_TENANT_CONTAINER,
      orbWebhookSecret: env.ORB_WEBHOOK_SECRET,
    });
    return app.fetch(request, env);
  },

  // Cron Trigger handler (#7182, wrangler.jsonc's `triggers.crons`): one global tick, on the schedule
  // wrangler.jsonc declares, checks every AMS tenant's own `amsSchedule.nextDueAt` (there is no per-resource
  // Cron Trigger primitive to register one per tenant) and wakes whichever ones are due. `ctx.waitUntil`
  // keeps the tick alive until every due tenant's cycle finishes, since `wakeDueAmsTenants` itself awaits
  // each one before the Worker would otherwise be allowed to shut the invocation down.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      wakeDueAmsTenants({
        binding: env.AMS_TENANT_CONTAINER,
        registry: createKvTenantRegistry(env.TENANT_REGISTRY),
      }),
    );
  },
};
