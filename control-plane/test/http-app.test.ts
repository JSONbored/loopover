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
  assert.equal((await registry.get("acme", "orb"))?.state, "active");
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

test("POST /v1/tenants accepts an optional schedule for an AMS tenant and surfaces it back (#7182)", async () => {
  const registry = createFakeTenantRegistry();
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants",
    authed({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "acme", product: "ams", schedule: { command: "discover", args: ["--search", "label:good-first-issue"], intervalMs: 3_600_000 } }),
    }),
  );

  assert.equal(res.status, 201);
  const payload = (await res.json()) as { amsSchedule?: { command: string; args: string[]; intervalMs: number; nextDueAt: string } };
  assert.equal(payload.amsSchedule?.command, "discover");
  assert.deepEqual(payload.amsSchedule?.args, ["--search", "label:good-first-issue"]);
  assert.equal(payload.amsSchedule?.intervalMs, 3_600_000);
  assert.ok(payload.amsSchedule?.nextDueAt);
  assert.deepEqual((await registry.get("acme", "ams"))?.amsSchedule, payload.amsSchedule);
});

test("POST /v1/tenants defaults schedule.args to [] when omitted", async () => {
  const registry = createFakeTenantRegistry();
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "ams", schedule: { command: "attempt", intervalMs: 1000 } }) }),
  );

  assert.equal(res.status, 201);
  assert.deepEqual((await registry.get("acme", "ams"))?.amsSchedule?.args, []);
});

test("POST /v1/tenants rejects a schedule on a non-AMS product", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request(
    "/v1/tenants",
    authed({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "acme", product: "orb", schedule: { command: "discover", intervalMs: 1000 } }),
    }),
  );

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_request", message: 'schedule is only valid for product "ams"' });
});

test("POST /v1/tenants rejects a malformed schedule without creating the tenant", async () => {
  const registry = createFakeTenantRegistry();
  const app = createTenantHttpApp(baseDeps({ registry }));

  for (const [schedule, message] of [
    ["not an object", "schedule must be a JSON object"],
    [["array", "not", "object"], "schedule must be a JSON object"],
    [{ intervalMs: 1000 }, "schedule.command must be one of: discover, manage-poll, attempt"],
    [{ command: "loop", intervalMs: 1000 }, "schedule.command must be one of: discover, manage-poll, attempt"],
    [{ command: "discover", args: "not-an-array", intervalMs: 1000 }, "schedule.args must be an array of strings"],
    [{ command: "discover", args: [1, 2], intervalMs: 1000 }, "schedule.args must be an array of strings"],
    [{ command: "discover", intervalMs: 0 }, "schedule.intervalMs must be a positive number of milliseconds"],
    [{ command: "discover", intervalMs: -1 }, "schedule.intervalMs must be a positive number of milliseconds"],
    [{ command: "discover", intervalMs: "1000" }, "schedule.intervalMs must be a positive number of milliseconds"],
    [{ command: "discover" }, "schedule.intervalMs must be a positive number of milliseconds"],
  ] as const) {
    const res = await app.request(
      "/v1/tenants",
      authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "ams", schedule }) }),
    );
    assert.equal(res.status, 400, JSON.stringify(schedule));
    assert.deepEqual(await res.json(), { error: "invalid_request", message });
  }
  assert.equal(await registry.get("acme", "ams"), undefined);
});

test("POST /v1/tenants without a schedule creates an AMS tenant with no amsSchedule at all", async () => {
  const registry = createFakeTenantRegistry();
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "ams" }) }),
  );

  assert.equal(res.status, 201);
  const payload = (await res.json()) as Record<string, unknown>;
  assert.equal("amsSchedule" in payload, false);
  assert.equal((await registry.get("acme", "ams"))?.amsSchedule, undefined);
});

test("GET /v1/tenants surfaces an AMS tenant's amsSchedule when set", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 3_600_000, nextDueAt: "2026-01-01T00:00:00.000Z" },
  });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request("/v1/tenants", authed());

  const payload = (await res.json()) as { tenants: Array<{ amsSchedule?: unknown }> };
  assert.deepEqual(payload.tenants[0]?.amsSchedule, { command: "discover", args: [], intervalMs: 3_600_000, nextDueAt: "2026-01-01T00:00:00.000Z" });
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
  assert.equal((await registry.get("acme", "orb"))?.state, "active");
});

test("POST /v1/tenants allows the same name under a different product (#8024)", async () => {
  const registry = createFakeTenantRegistry();
  const driver = createFakeTenantProvisioningDriver();
  const app = createTenantHttpApp(baseDeps({ registry, driver }));

  const orb = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );
  const ams = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "ams" }) }),
  );

  assert.equal(orb.status, 201);
  assert.equal(ams.status, 201);
  assert.equal((await registry.get("acme", "orb"))?.state, "active");
  assert.equal((await registry.get("acme", "ams"))?.state, "active");

  const deleted = await app.request("/v1/tenants/acme?product=orb", authed({ method: "DELETE" }));
  assert.equal(deleted.status, 200);
  assert.equal((await registry.get("acme", "orb"))?.state, "torn down");
  assert.equal((await registry.get("acme", "ams"))?.state, "active");
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

  const res = await app.request("/v1/tenants/acme?product=orb", authed({ method: "DELETE" }));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { tenant: { name: "acme" }, product: "orb", state: "torn down" });
  assert.equal((await registry.get("acme", "orb"))?.state, "torn down");
  assert.equal(await driver.containerExists({ tenant: { name: "acme" }, product: "orb" }), false);
});

test("DELETE /v1/tenants/:name rejects a missing product query parameter (400)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request("/v1/tenants/acme", authed({ method: "DELETE" }));

  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "invalid_request");
});

test("DELETE /v1/tenants/:name on an unknown tenant is a 404, not a silent no-op", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request("/v1/tenants/ghost?product=orb", authed({ method: "DELETE" }));

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "tenant_not_found" });
});

test("DELETE /v1/tenants/:name URL-decodes the name path segment", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme corp" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(`/v1/tenants/${encodeURIComponent("acme corp")}?product=orb`, authed({ method: "DELETE" }));

  assert.equal(res.status, 200);
});

test("create and delete both work when pagerDuty options are omitted entirely (defaults to {})", async () => {
  const app = createTenantHttpApp({ driver: createFakeTenantProvisioningDriver(), registry: createFakeTenantRegistry(), adminToken: ADMIN_TOKEN });

  const created = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );
  assert.equal(created.status, 201);

  const deleted = await app.request("/v1/tenants/acme?product=orb", authed({ method: "DELETE" }));
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

// #4898: POST /v1/tenants/rollout — pin/unpin an explicit list of tenants' pinnedVersion, all-or-nothing.
// The registry-seeding style mirrors the GET /v1/tenants tests above (records seeded directly, no driver run).

function rollout(app: ReturnType<typeof createTenantHttpApp>, body: unknown) {
  return app.request(
    "/v1/tenants/rollout",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
  );
}

test("POST /v1/tenants/rollout pins exactly the listed tenants and leaves every other tenant untouched (#4898 acceptance)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  await registry.upsert({ tenant: { name: "beta" }, product: "ams", state: "active", createdAt: "t0", updatedAt: "t0" });
  await registry.upsert({ tenant: { name: "gamma" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await rollout(app, { names: ["acme", "gamma"], product: "orb", pinnedVersion: "v1.4.2" });

  assert.equal(res.status, 200);
  const payload = (await res.json()) as { tenants: Array<{ tenant: { name: string; pinnedVersion?: string | null } }> };
  assert.deepEqual(payload.tenants.map((t) => t.tenant), [
    { name: "acme", pinnedVersion: "v1.4.2" },
    { name: "gamma", pinnedVersion: "v1.4.2" },
  ]);
  // The unlisted tenant (a different product, #8024) is completely unaffected — no pin, no updatedAt churn.
  const beta = await registry.get("beta", "ams");
  assert.deepEqual(beta?.tenant, { name: "beta" });
  assert.equal(beta?.updatedAt, "t0");
  // The pinned tenants' records persisted the pin and kept their createdAt.
  const acme = await registry.get("acme", "orb");
  assert.deepEqual(acme?.tenant, { name: "acme", pinnedVersion: "v1.4.2" });
  assert.equal(acme?.createdAt, "t0");
  assert.notEqual(acme?.updatedAt, "t0");
});

test("POST /v1/tenants/rollout rolls back independently: re-pinning one tenant leaves another tenant's pin alone", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme", pinnedVersion: "v2.0.0" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  await registry.upsert({ tenant: { name: "beta", pinnedVersion: "v2.0.0" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const back = await rollout(app, { names: ["acme"], product: "orb", pinnedVersion: "v1.9.0" });
  assert.equal(back.status, 200);
  assert.deepEqual((await registry.get("acme", "orb"))?.tenant, { name: "acme", pinnedVersion: "v1.9.0" });
  assert.deepEqual((await registry.get("beta", "orb"))?.tenant, { name: "beta", pinnedVersion: "v2.0.0" });

  // Explicit unpin (null) reverts the tenant to its release channel's default.
  const unpin = await rollout(app, { names: ["acme"], product: "orb", pinnedVersion: null });
  assert.equal(unpin.status, 200);
  assert.deepEqual((await registry.get("acme", "orb"))?.tenant, { name: "acme", pinnedVersion: null });
  assert.deepEqual((await registry.get("beta", "orb"))?.tenant, { name: "beta", pinnedVersion: "v2.0.0" });
});

test("POST /v1/tenants/rollout trims the pinned version before storing it", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await rollout(app, { names: ["acme"], product: "orb", pinnedVersion: "  v1.4.2  " });

  assert.equal(res.status, 200);
  assert.deepEqual((await registry.get("acme", "orb"))?.tenant, { name: "acme", pinnedVersion: "v1.4.2" });
});

test("POST /v1/tenants/rollout 400s malformed bodies without touching any record", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const notJson = await rollout(app, "not json at all");
  assert.equal(notJson.status, 400);
  assert.deepEqual(await notJson.json(), { error: "invalid_json" });

  for (const [body, message] of [
    [[], "body must be a JSON object"],
    [{ names: [], product: "orb", pinnedVersion: "v1" }, "names must be a non-empty array of tenant names"],
    [{ names: "acme", product: "orb", pinnedVersion: "v1" }, "names must be a non-empty array of tenant names"],
    [{ names: ["acme", "  "], product: "orb", pinnedVersion: "v1" }, "names must be a non-empty array of tenant names"],
    [{ names: ["acme", 7], product: "orb", pinnedVersion: "v1" }, "names must be a non-empty array of tenant names"],
    [{ names: ["acme", "acme"], product: "orb", pinnedVersion: "v1" }, "names must not repeat a tenant"],
    [{ names: ["acme"], pinnedVersion: "v1" }, "product is required"],
    [{ names: ["acme"], product: "  ", pinnedVersion: "v1" }, "product is required"],
    [{ names: ["acme"], product: "orb", pinnedVersion: "   " }, "pinnedVersion must be a non-blank string, or null to unpin"],
    [{ names: ["acme"], product: "orb", pinnedVersion: 7 }, "pinnedVersion must be a non-blank string, or null to unpin"],
    [{ names: ["acme"], product: "orb" }, "pinnedVersion must be a non-blank string, or null to unpin"],
  ] as const) {
    const res = await rollout(app, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: "invalid_request", message });
  }
  assert.deepEqual((await registry.get("acme", "orb"))?.tenant, { name: "acme" });
});

test("POST /v1/tenants/rollout is all-or-nothing: one unknown name 404s and applies nothing", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await rollout(app, { names: ["acme", "ghost"], product: "orb", pinnedVersion: "v1.4.2" });

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "tenant_not_found", message: 'unknown tenant "ghost"' });
  assert.deepEqual((await registry.get("acme", "orb"))?.tenant, { name: "acme" });
});

test("POST /v1/tenants/rollout 409s a torn-down tenant and applies nothing", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  await registry.upsert({ tenant: { name: "gone" }, product: "orb", state: "torn down", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await rollout(app, { names: ["acme", "gone"], product: "orb", pinnedVersion: "v1.4.2" });

  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "tenant_torn_down", message: 'tenant "gone" is torn down' });
  assert.deepEqual((await registry.get("acme", "orb"))?.tenant, { name: "acme" });
});

test("POST /v1/tenants/rollout sits behind the same Bearer wall as every other /v1/tenants route", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request("/v1/tenants/rollout", { method: "POST", body: JSON.stringify({ names: ["acme"], pinnedVersion: "v1" }) });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

test("GET /v1/tenants surfaces each tenant's pinnedVersion once one is set (#4898 admin visibility)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme", pinnedVersion: "v1.4.2" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request("/v1/tenants", authed());

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    tenants: [{ tenant: { name: "acme", pinnedVersion: "v1.4.2" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" }],
  });
});
