// The real HTTP transport for control-plane's tenant-provisioning API (#7654), matching
// packages/loopover-miner/lib/tenant-client.ts's already-merged contract for create/list shapes:
// `POST /v1/tenants` (`{name, product}`), `GET /v1/tenants` (`{tenants: [...]}`), and
// `DELETE /v1/tenants/:name?product=` (#8024: product is required so registry lookups stay product-scoped).
// Factored out as a plain Hono app (not the real Worker entry point, see worker.ts) so it's testable via
// Hono's own `app.request()` against injected fakes under plain `node:test` -- mirrors
// packages/discovery-index/src/app.ts's identical split for the identical reason.
//
// Deliberately never echoes a tenant's database connection details (host/user/password/connectionString) in
// any response: `provisionTenant`'s result carries them (#7653) so a caller doesn't lose them, but this admin
// HTTP surface only returns the safe `{tenant, product, state}` triple. Properly storing/distributing those
// credentials is #7852's job (the generalized secret broker) -- until it lands, this transport intentionally
// does not create a new place for them to leak.
import { Hono } from "hono";
import { normalizeSharedSecret, verifyBearer } from "./auth.js";
import {
  deprovisionTenant,
  provisionTenant,
  type ProvisioningPagerDutyOptions,
} from "./provisioning.js";
import type { Product, TenantProvisioningDriver } from "./tenant-provisioning-driver.js";
import type { TenantRegistry, TenantRegistryRecord } from "./tenant-registry.js";

export type TenantHttpAppDeps = {
  driver: TenantProvisioningDriver;
  registry: TenantRegistry;
  /** The single admin Bearer token every `/v1/tenants/*` route requires. Blank/unset ⇒ every request under
   *  that prefix fails closed with 503 (matching discovery-index's own "service_not_configured" convention)
   *  rather than silently accepting an unauthenticated caller. */
  adminToken: string | undefined;
  pagerDuty?: ProvisioningPagerDutyOptions;
};

function safeRecord(record: Pick<TenantRegistryRecord, "tenant" | "product" | "state">): Record<string, unknown> {
  return { tenant: record.tenant, product: record.product, state: record.state };
}

/** Validated body of `POST /v1/tenants/rollout` (#4898): an explicit tenant-name list (no percentage/canary
 *  selector — no such primitive exists elsewhere in this codebase to build on) plus the version to pin.
 *  `pinnedVersion: null` is an explicit unpin (revert to the release channel's default). Scoped to a single
 *  `product` for the whole batch (#8024: a name is no longer globally unique across products, and a version
 *  rollout is naturally a per-product-fleet operation anyway -- ORB and AMS ship independently versioned
 *  images, so mixing them in one rollout call was never a meaningful use case even before #8024). */
type RolloutRequest = { names: string[]; product: Product; pinnedVersion: string | null };

function parseRolloutRequest(body: unknown): RolloutRequest | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  const { names, product, pinnedVersion } = body as Record<string, unknown>;
  if (!Array.isArray(names) || names.length === 0) return "names must be a non-empty array of tenant names";
  if (!names.every((name): name is string => typeof name === "string" && name.trim() !== "")) {
    return "names must be a non-empty array of tenant names";
  }
  if (new Set(names).size !== names.length) return "names must not repeat a tenant";
  if (typeof product !== "string" || !product.trim()) return "product is required";
  if (pinnedVersion !== null && (typeof pinnedVersion !== "string" || !pinnedVersion.trim())) {
    return "pinnedVersion must be a non-blank string, or null to unpin";
  }
  return { names, product: product.trim(), pinnedVersion: pinnedVersion === null ? null : pinnedVersion.trim() };
}

export function createTenantHttpApp(deps: TenantHttpAppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", service: "control-plane" }));

  app.use("/v1/tenants/*", async (c, next) => {
    const secret = normalizeSharedSecret(deps.adminToken);
    if (!secret) return c.json({ error: "service_not_configured" }, 503);
    if (!verifyBearer(c.req.header("authorization"), secret)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.onError((error, c) => {
    // Hono's ErrorHandler type guarantees `error: Error | HTTPResponseError` -- both carry `.message`.
    // provisionTenant/deprovisionTenant already page PagerDuty (#7667) and rethrow internally before this ever
    // runs, so this handler only logs and answers -- it must not page a second time for the same failure.
    console.error(JSON.stringify({ event: "control_plane_http_error", route: c.req.path, message: error.message }));
    return c.json({ error: "internal_error" }, 500);
  });

  app.post("/v1/tenants", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object") return c.json({ error: "invalid_json" }, 400);
    const { name, product } = body as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) return c.json({ error: "invalid_request", message: "name is required" }, 400);
    if (typeof product !== "string" || !product.trim()) return c.json({ error: "invalid_request", message: "product is required" }, 400);

    // Not idempotent by design (tenant-client.ts's own doc comment: "a create is not idempotent, so it must
    // not be silently re-sent") -- a currently-active tenant of the same name *and product* is a real conflict,
    // not a no-op (#8024: ORB "acme" must not block AMS "acme"). A previously torn-down tenant may be recreated
    // (its createdAt is NOT preserved -- this is a fresh provision, not a resurrection of the old one).
    const existing = await deps.registry.get(name, product);
    if (existing && existing.state !== "torn down") return c.json({ error: "tenant_already_exists" }, 409);

    const result = await provisionTenant({ name }, product, deps.driver, deps.pagerDuty ?? {});
    const now = new Date().toISOString();
    await deps.registry.upsert({ tenant: result.tenant, product: result.product, state: result.state, createdAt: now, updatedAt: now });
    return c.json(safeRecord(result), 201);
  });

  app.get("/v1/tenants", async (c) => {
    const records = await deps.registry.list();
    return c.json({ tenants: records.map((record) => ({ ...safeRecord(record), createdAt: record.createdAt, updatedAt: record.updatedAt })) });
  });

  // #4898: rollout/rollback = updating one or more tenants' pinnedVersion via an explicit list. Validates the
  // WHOLE list before touching any record (all-or-nothing) so a typo'd name can never leave a fleet half
  // rolled out; each updated tenant's container picks its new version up at its next (re)start
  // (container-driver.ts's PINNED_VERSION_ENV_VAR). Every unlisted tenant is untouched by construction —
  // the per-tenant-independence guarantee this endpoint exists to keep.
  app.post("/v1/tenants/rollout", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (body === null) return c.json({ error: "invalid_json" }, 400);
    const parsed = parseRolloutRequest(body);
    if (typeof parsed === "string") return c.json({ error: "invalid_request", message: parsed }, 400);

    const existing = new Map<string, TenantRegistryRecord>();
    for (const name of parsed.names) {
      const record = await deps.registry.get(name, parsed.product);
      if (!record) return c.json({ error: "tenant_not_found", message: `unknown tenant "${name}"` }, 404);
      // A torn-down tenant has no container to ever read the pin — surfacing the mistake beats silently
      // stamping a version onto a terminated record (same conflict posture as the create route's 409).
      if (record.state === "torn down") return c.json({ error: "tenant_torn_down", message: `tenant "${name}" is torn down` }, 409);
      existing.set(name, record);
    }

    const now = new Date().toISOString();
    const updated: TenantRegistryRecord[] = [];
    for (const name of parsed.names) {
      const record = existing.get(name)!;
      const next: TenantRegistryRecord = {
        ...record,
        tenant: { ...record.tenant, pinnedVersion: parsed.pinnedVersion },
        updatedAt: now,
      };
      await deps.registry.upsert(next);
      updated.push(next);
    }
    return c.json({ tenants: updated.map((record) => ({ ...safeRecord(record), createdAt: record.createdAt, updatedAt: record.updatedAt })) });
  });

  app.delete("/v1/tenants/:name", async (c) => {
    const name = c.req.param("name");
    // Product is required so the registry can resolve the same `${product}:${name}` key used at create (#8024).
    const product = c.req.query("product");
    if (typeof product !== "string" || !product.trim()) {
      return c.json({ error: "invalid_request", message: "product query parameter is required" }, 400);
    }

    const existing = await deps.registry.get(name, product);
    if (!existing) return c.json({ error: "tenant_not_found" }, 404);

    const result = await deprovisionTenant(existing.tenant, existing.product, deps.driver, deps.pagerDuty ?? {});
    await deps.registry.upsert({ tenant: result.tenant, product: result.product, state: result.state, createdAt: existing.createdAt, updatedAt: new Date().toISOString() });
    return c.json(safeRecord(result));
  });

  return app;
}
