// Route tests for control-plane's real HTTP transport (#7654), driven via Hono's own `app.request()` --
// no real network, no real driver, matching tenant-client.ts's exact request/response contract. Covers every
// auth branch, every validation branch, the not-idempotent create-conflict rule, delete-of-unknown-tenant, the
// onError 500 path, and (explicitly) that a tenant's database connection details never appear on the wire.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  createFakeTenantProvisioningDriver,
  createFakeTenantRegistry,
  createTenantHttpApp,
  type TenantHttpAppDeps,
  type TenantProvisioningDriver,
} from "../dist/index.js";

const ADMIN_TOKEN = "admin-token-value";

function baseDeps(overrides: Partial<TenantHttpAppDeps> = {}): TenantHttpAppDeps {
  return {
    driver: createFakeTenantProvisioningDriver(),
    registry: createFakeTenantRegistry(),
    adminToken: ADMIN_TOKEN,
    pagerDuty: { env: {} },
    ...overrides,
  };
}

function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...init.headers, authorization: `Bearer ${ADMIN_TOKEN}` } };
}

let consoleErrorRestore: (() => void) | undefined;

afterEach(() => {
  consoleErrorRestore?.();
  consoleErrorRestore = undefined;
});

test("GET /health is unauthenticated and always ok", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request("/health");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", service: "control-plane" });
});

test("v1/tenants routes fail closed (503) when adminToken is unset", async () => {
  const app = createTenantHttpApp(baseDeps({ adminToken: undefined }));

  const res = await app.request("/v1/tenants", authed());

  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "service_not_configured" });
});

test("v1/tenants routes reject a missing or wrong Bearer token (401)", async () => {
  const app = createTenantHttpApp(baseDeps());

  const noAuth = await app.request("/v1/tenants");
  assert.equal(noAuth.status, 401);

  const wrongAuth = await app.request("/v1/tenants", { headers: { authorization: "Bearer nope" } });
  assert.equal(wrongAuth.status, 401);
});

test("POST /v1/tenants creates a tenant, returns only the safe {tenant,product,state} triple", async () => {
  const registry = createFakeTenantRegistry();
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );

  assert.equal(res.status, 201);
  const payload = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(payload, { tenant: { name: "acme" }, product: "orb", state: "active" });
  assert.equal("database" in payload, false);
  // The registry was actually updated, not just the HTTP response shaped correctly.
  assert.equal((await registry.get("acme"))?.state, "active");
});

test("POST /v1/tenants never echoes a tenant's database connection details on the wire", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );
  const text = await res.text();

  assert.ok(!text.includes("password"));
  assert.ok(!text.includes("connectionString"));
});

test("POST /v1/tenants rejects invalid JSON (400)", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request("/v1/tenants", authed({ method: "POST", headers: { "content-type": "application/json" }, body: "not json" }));

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_json" });
});

test("POST /v1/tenants rejects a missing name (400)", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: "orb" }) }),
  );

  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "invalid_request");
});

test("POST /v1/tenants rejects a missing product (400)", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme" }) }),
  );

  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "invalid_request");
});

test("POST /v1/tenants rejects re-creating an already-active tenant (409, not idempotent)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );

  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "tenant_already_exists" });
});

test("POST /v1/tenants allows recreating a torn-down tenant", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "torn down", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );

  assert.equal(res.status, 201);
  assert.equal((await registry.get("acme"))?.state, "active");
});

test("GET /v1/tenants lists every registered tenant, sorted, with timestamps", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "zebra" }, product: "ams", state: "active", createdAt: "t1", updatedAt: "t1" });
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t2", updatedAt: "t2" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request("/v1/tenants", authed());

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    tenants: [
      { tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t2", updatedAt: "t2" },
      { tenant: { name: "zebra" }, product: "ams", state: "active", createdAt: "t1", updatedAt: "t1" },
    ],
  });
});

test("GET /v1/tenants returns an empty list when nothing has been created", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request("/v1/tenants", authed());

  assert.deepEqual(await res.json(), { tenants: [] });
});

test("DELETE /v1/tenants/:name tears down a known tenant and reports it torn down", async () => {
  const registry = createFakeTenantRegistry();
  const driver = createFakeTenantProvisioningDriver();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  await driver.createContainer({ tenant: { name: "acme" }, product: "orb" });
  const app = createTenantHttpApp(baseDeps({ registry, driver }));

  const res = await app.request("/v1/tenants/acme", authed({ method: "DELETE" }));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { tenant: { name: "acme" }, product: "orb", state: "torn down" });
  assert.equal((await registry.get("acme"))?.state, "torn down");
  assert.equal(await driver.containerExists({ tenant: { name: "acme" }, product: "orb" }), false);
});

test("DELETE /v1/tenants/:name on an unknown tenant is a 404, not a silent no-op", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request("/v1/tenants/ghost", authed({ method: "DELETE" }));

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "tenant_not_found" });
});

test("DELETE /v1/tenants/:name URL-decodes the name path segment", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme corp" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(`/v1/tenants/${encodeURIComponent("acme corp")}`, authed({ method: "DELETE" }));

  assert.equal(res.status, 200);
});

test("create and delete both work when pagerDuty options are omitted entirely (defaults to {})", async () => {
  const app = createTenantHttpApp({ driver: createFakeTenantProvisioningDriver(), registry: createFakeTenantRegistry(), adminToken: ADMIN_TOKEN });

  const created = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );
  assert.equal(created.status, 201);

  const deleted = await app.request("/v1/tenants/acme", authed({ method: "DELETE" }));
  assert.equal(deleted.status, 200);
});

test("a driver failure surfaces as a logged 500 via onError, not an unhandled rejection", async () => {
  const failingDriver: TenantProvisioningDriver = {
    ...createFakeTenantProvisioningDriver(),
    async createContainer() {
      throw new Error("cloudflare containers api unavailable");
    },
  };
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message: string) => {
    errors.push(message);
  };
  consoleErrorRestore = () => {
    console.error = originalError;
  };
  const app = createTenantHttpApp(baseDeps({ driver: failingDriver }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );

  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "internal_error" });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /control_plane_http_error/);
  assert.match(errors[0]!, /cloudflare containers api unavailable/);
});
