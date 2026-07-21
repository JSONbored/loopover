// Cloudflare Worker entry point for control-plane's real HTTP transport (#7654). Pure infra glue: wires the
// real KV-backed tenant registry, the admin Bearer secret, and whichever `TenantProvisioningDriver` env
// selects (real Neon database driver if NEON_API_KEY/NEON_PROJECT_ID are set, the fake otherwise -- see
// driver-factory.ts) into the plain, already-tested Hono app (http-app.ts). Adds NO route logic of its own.
//
// Not unit-tested: exercised only by real Cloudflare Workers/KV infrastructure, matching
// packages/discovery-index/src/worker.ts's own identical exclusion (see scripts/control-plane-coverage.mjs).
import { createTenantProvisioningDriver } from "./driver-factory.js";
import { createTenantHttpApp } from "./http-app.js";
import { createKvTenantRegistry } from "./tenant-registry.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const driver = createTenantProvisioningDriver({ NEON_API_KEY: env.NEON_API_KEY, NEON_PROJECT_ID: env.NEON_PROJECT_ID });
    const app = createTenantHttpApp({
      driver,
      registry: createKvTenantRegistry(env.TENANT_REGISTRY),
      adminToken: env.ADMIN_TOKEN,
      // provisionTenant/deprovisionTenant's own PagerDuty paging (#7667) defaults to reading `process.env`,
      // a real-Node-only assumption -- explicitly forwarding the Worker's own bindings here is what makes
      // paging actually configurable in this deployment, rather than silently reading an empty process.env.
      pagerDuty: { env: { LOOPOVER_ENABLE_PAGERDUTY: env.LOOPOVER_ENABLE_PAGERDUTY, PAGERDUTY_ROUTING_KEY: env.PAGERDUTY_ROUTING_KEY } },
    });
    return app.fetch(request, env);
  },
};
