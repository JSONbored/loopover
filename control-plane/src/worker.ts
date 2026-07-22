// Cloudflare Worker entry point for control-plane's real HTTP transport (#7654) and, as of #7851, real
// tenant container lifecycle. Pure infra glue: wires the real KV-backed tenant registry, the admin Bearer
// secret, and whichever `TenantProvisioningDriver` pieces are configured (real Neon database driver if
// NEON_API_KEY/NEON_PROJECT_ID are set, real Cloudflare Containers driver for the two bindings below -- see
// driver-factory.ts) into the plain, already-tested Hono app (http-app.ts). Adds NO route logic of its own.
//
// Not unit-tested: exercised only by real Cloudflare Workers/KV/Containers infrastructure, matching
// packages/discovery-index/src/worker.ts's own identical exclusion (see scripts/control-plane-coverage.mjs).
import { Container } from "@cloudflare/containers";
import { createTenantProvisioningDriver } from "./driver-factory.js";
import { createTenantHttpApp } from "./http-app.js";
import { createKvTenantRegistry } from "./tenant-registry.js";

const PROVISIONED_STORAGE_KEY = "provisioned";

/** Shared base for both product-specific Container classes below: tracks whether THIS tenant's container has
 *  been explicitly provisioned, in the DO's own durable storage -- independent of Cloudflare's own transient
 *  container run-state (`getState()`'s running/stopped/stopped_with_code/etc). That distinction is
 *  load-bearing, concretely for AMS: its one-shot CLI image (see AmsTenantContainer below) is EXPECTED to sit
 *  in a "stopped"-shaped run state almost all the time by design (#7182), indistinguishable from "never
 *  provisioned" using run-state alone -- container-driver.ts's header comment covers this in full. */
class ProvisionedContainer extends Container {
  async isProvisioned(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>(PROVISIONED_STORAGE_KEY)) === true;
  }
  async markProvisioned(): Promise<void> {
    await this.ctx.storage.put(PROVISIONED_STORAGE_KEY, true);
  }
  async markDeprovisioned(): Promise<void> {
    await this.ctx.storage.delete(PROVISIONED_STORAGE_KEY);
  }
}

/** ORB's tenant container (#7173's ratified one-container-per-tenant-per-product model): runs the SAME root
 *  Dockerfile self-host image unmodified, on the port that image's own PORT env var / HEALTHCHECK already
 *  use. Webhook routing into this container (#7181) is a separate, not-yet-built piece -- this class only
 *  stands the container up and tears it down; #7181 is what will actually proxy requests through it. */
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
      { NEON_API_KEY: env.NEON_API_KEY, NEON_PROJECT_ID: env.NEON_PROJECT_ID },
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
    });
    return app.fetch(request, env);
  },
};
