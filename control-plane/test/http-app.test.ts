// Route tests for control-plane's real HTTP transport (#7654), driven via Hono's own `app.request()` --
// no real network, no real driver, matching tenant-client.ts's exact request/response contract. Covers every
// auth branch, every validation branch, the not-idempotent create-conflict rule, delete-of-unknown-tenant, the
// onError 500 path, and (explicitly) that a tenant's database connection details never appear on the wire.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, test } from "node:test";

import {
  createFakeTenantProvisioningDriver,
  createFakeTenantRegistry,
  createTenantHttpApp,
  type RouterNamespaceLike,
  type RouterStubLike,
  type TenantHttpAppDeps,
  type TenantRegistryRecord,
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

test("POST /v1/tenants accepts an optional orbInstallationId for an ORB tenant and surfaces it back (#7181)", async () => {
  const registry = createFakeTenantRegistry();
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb", orbInstallationId: 555 }) }),
  );

  assert.equal(res.status, 201);
  const payload = (await res.json()) as { orbInstallationId?: number };
  assert.equal(payload.orbInstallationId, 555);
  assert.equal((await registry.get("acme", "orb"))?.orbInstallationId, 555);
});

test("POST /v1/tenants without orbInstallationId creates an ORB tenant with no installation link at all", async () => {
  const registry = createFakeTenantRegistry();
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );

  assert.equal(res.status, 201);
  const payload = (await res.json()) as Record<string, unknown>;
  assert.equal("orbInstallationId" in payload, false);
  assert.equal((await registry.get("acme", "orb"))?.orbInstallationId, undefined);
});

test("POST /v1/tenants rejects orbInstallationId on a non-ORB product", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "ams", orbInstallationId: 555 }) }),
  );

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_request", message: 'orbInstallationId is only valid for product "orb"' });
});

test("POST /v1/tenants rejects a malformed orbInstallationId without creating the tenant", async () => {
  const registry = createFakeTenantRegistry();
  const app = createTenantHttpApp(baseDeps({ registry }));

  for (const orbInstallationId of ["555", 0, -1, 1.5, true, {}]) {
    const res = await app.request(
      "/v1/tenants",
      authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb", orbInstallationId }) }),
    );
    assert.equal(res.status, 400, JSON.stringify(orbInstallationId));
    assert.deepEqual(await res.json(), { error: "invalid_request", message: "orbInstallationId must be a positive integer" });
  }
  assert.equal(await registry.get("acme", "orb"), undefined);
});

test("POST /v1/tenants rejects an orbInstallationId already claimed by another active tenant (409)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "existing" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0", orbInstallationId: 555 });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "newcomer", product: "orb", orbInstallationId: 555 }) }),
  );

  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "installation_already_claimed", message: 'installation 555 is already claimed by tenant "existing"' });
  assert.equal(await registry.get("newcomer", "orb"), undefined);
});

test("POST /v1/tenants allows claiming an orbInstallationId that a torn-down tenant previously held", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "old" }, product: "orb", state: "torn down", createdAt: "t0", updatedAt: "t0", orbInstallationId: 555 });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "newcomer", product: "orb", orbInstallationId: 555 }) }),
  );

  assert.equal(res.status, 201);
  assert.equal((await registry.get("newcomer", "orb"))?.orbInstallationId, 555);
});

// #9143 (defect 2 manual recovery): PATCH /v1/tenants/:name/orb-installation re-links an existing tenant's
// orbInstallationId -- the manual recovery path for a tenant whose installation-index pointer was wiped by
// the pre-fix tenant-registry.ts bug (see that file's own header comment, and its own regression test).

test("PATCH /v1/tenants/:name/orb-installation re-links an existing ORB tenant to a new installation ID", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants/acme/orb-installation?product=orb",
    authed({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ orbInstallationId: 999 }) }),
  );

  assert.equal(res.status, 200);
  const payload = (await res.json()) as { orbInstallationId?: number };
  assert.equal(payload.orbInstallationId, 999);
  assert.equal((await registry.get("acme", "orb"))?.orbInstallationId, 999);
});

test("PATCH /v1/tenants/:name/orb-installation re-linking to the SAME id it already has never 409s against itself", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0", orbInstallationId: 555 });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants/acme/orb-installation?product=orb",
    authed({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ orbInstallationId: 555 }) }),
  );

  assert.equal(res.status, 200);
  assert.equal((await registry.get("acme", "orb"))?.orbInstallationId, 555);
});

test("PATCH /v1/tenants/:name/orb-installation rejects a missing product query parameter (400)", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request("/v1/tenants/acme/orb-installation", authed({ method: "PATCH", body: JSON.stringify({ orbInstallationId: 1 }) }));

  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "invalid_request");
});

test("PATCH /v1/tenants/:name/orb-installation rejects a non-orb product (400)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "ams", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants/acme/orb-installation?product=ams",
    authed({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ orbInstallationId: 1 }) }),
  );

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_request", message: 'orbInstallationId is only valid for product "orb"' });
});

test("PATCH /v1/tenants/:name/orb-installation on an unknown tenant is a 404", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request(
    "/v1/tenants/ghost/orb-installation?product=orb",
    authed({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ orbInstallationId: 1 }) }),
  );

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "tenant_not_found" });
});

test("PATCH /v1/tenants/:name/orb-installation rejects invalid JSON (400)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request("/v1/tenants/acme/orb-installation?product=orb", authed({ method: "PATCH", headers: { "content-type": "application/json" }, body: "not json" }));

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_json" });
});

test("PATCH /v1/tenants/:name/orb-installation requires orbInstallationId in the body (400)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request("/v1/tenants/acme/orb-installation?product=orb", authed({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }));

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_request", message: "orbInstallationId is required" });
});

test("PATCH /v1/tenants/:name/orb-installation rejects a malformed orbInstallationId (400)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants/acme/orb-installation?product=orb",
    authed({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ orbInstallationId: -1 }) }),
  );

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_request", message: "orbInstallationId must be a positive integer" });
});

test("PATCH /v1/tenants/:name/orb-installation refuses to steal an installation ID a DIFFERENT active tenant still holds (409)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  await registry.upsert({ tenant: { name: "other" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0", orbInstallationId: 555 });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants/acme/orb-installation?product=orb",
    authed({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ orbInstallationId: 555 }) }),
  );

  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "installation_already_claimed", message: 'installation 555 is already claimed by tenant "other"' });
  assert.equal((await registry.get("acme", "orb"))?.orbInstallationId, undefined);
});

test("PATCH /v1/tenants/:name/orb-installation allows reclaiming an ID from a torn-down tenant that used to hold it", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  await registry.upsert({ tenant: { name: "old" }, product: "orb", state: "torn down", createdAt: "t0", updatedAt: "t0", orbInstallationId: 555 });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants/acme/orb-installation?product=orb",
    authed({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ orbInstallationId: 555 }) }),
  );

  assert.equal(res.status, 200);
  assert.equal((await registry.get("acme", "orb"))?.orbInstallationId, 555);
});

test("PATCH /v1/tenants/:name/orb-installation sits behind the same Bearer wall as every other /v1/tenants route", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request("/v1/tenants/acme/orb-installation?product=orb", { method: "PATCH", body: JSON.stringify({ orbInstallationId: 1 }) });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

test("GET /v1/tenants surfaces an ORB tenant's orbInstallationId when set", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0", orbInstallationId: 555 });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request("/v1/tenants", authed());

  const payload = (await res.json()) as { tenants: Array<{ orbInstallationId?: number }> };
  assert.equal(payload.tenants[0]?.orbInstallationId, 555);
});

test("#8066: POST /v1/tenants persists and surfaces the secretRef a real secret driver returns from injectSecrets", async () => {
  const registry = createFakeTenantRegistry();
  const fake = createFakeTenantProvisioningDriver();
  const driver: TenantProvisioningDriver = { ...fake, injectSecrets: async () => ({ secretRef: "orbenr_abc" }) };
  const app = createTenantHttpApp(baseDeps({ registry, driver }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );

  assert.equal(res.status, 201);
  const payload = (await res.json()) as { secretRef?: string };
  assert.equal(payload.secretRef, "orbenr_abc");
  assert.equal((await registry.get("acme", "orb"))?.secretRef, "orbenr_abc");
});

test("#8066: POST /v1/tenants against the plain fake driver creates a tenant with no secretRef at all", async () => {
  const registry = createFakeTenantRegistry();
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );

  const payload = (await res.json()) as Record<string, unknown>;
  assert.equal("secretRef" in payload, false);
  assert.equal((await registry.get("acme", "orb"))?.secretRef, undefined);
});

test("#8066: GET /v1/tenants surfaces a tenant's secretRef when set", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0", secretRef: "orbenr_abc" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request("/v1/tenants", authed());

  const payload = (await res.json()) as { tenants: Array<{ secretRef?: string }> };
  assert.equal(payload.tenants[0]?.secretRef, "orbenr_abc");
});

test("#8066: DELETE /v1/tenants/:name threads the stored secretRef into deprovisionTenant's revokeSecrets call", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0", secretRef: "orbenr_abc" });
  const fake = createFakeTenantProvisioningDriver();
  let seenSecretRef: string | undefined;
  const driver: TenantProvisioningDriver = {
    ...fake,
    revokeSecrets: async (request) => {
      seenSecretRef = request.secretRef;
    },
  };
  const app = createTenantHttpApp(baseDeps({ registry, driver }));

  const res = await app.request("/v1/tenants/acme?product=orb", authed({ method: "DELETE" }));

  assert.equal(res.status, 200);
  assert.equal(seenSecretRef, "orbenr_abc");
});

test("#8066: DELETE /v1/tenants/:name on a tenant with no secretRef threads undefined through (no stale value leaks in)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const fake = createFakeTenantProvisioningDriver();
  let seenSecretRef: string | undefined | "unset" = "unset";
  const driver: TenantProvisioningDriver = {
    ...fake,
    revokeSecrets: async (request) => {
      seenSecretRef = request.secretRef;
    },
  };
  const app = createTenantHttpApp(baseDeps({ registry, driver }));

  await app.request("/v1/tenants/acme?product=orb", authed({ method: "DELETE" }));

  assert.equal(seenSecretRef, undefined);
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

// #9143 (defect 8 minimum): DELETE used to have no state check at all -- a tenant still mid-standup (no
// container/database/secrets settled) could be torn down while provisionTenant was still racing to write its
// own "active"/"failed" transition to the SAME record. Refusing the request while "provisioning" is the
// documented minimum fix (the full DO/D1 serialized-claim migration is deferred, see tenant-registry.ts).
test("DELETE /v1/tenants/:name refuses a tenant that is still provisioning (409, not idempotent)", async () => {
  const registry = createFakeTenantRegistry();
  const driver = createFakeTenantProvisioningDriver();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "provisioning", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry, driver }));

  const res = await app.request("/v1/tenants/acme?product=orb", authed({ method: "DELETE" }));

  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "tenant_provisioning", message: 'tenant "acme" is still provisioning; retry once it settles' });
  // Untouched -- still provisioning, no driver teardown call was ever made.
  assert.equal((await registry.get("acme", "orb"))?.state, "provisioning");
  assert.equal(driver.calls.length, 0);
});

test("DELETE /v1/tenants/:name still tears down a 'failed' tenant (only 'provisioning' is refused)", async () => {
  const registry = createFakeTenantRegistry();
  const driver = createFakeTenantProvisioningDriver();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "failed", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry, driver }));

  const res = await app.request("/v1/tenants/acme?product=orb", authed({ method: "DELETE" }));

  assert.equal(res.status, 200);
  assert.equal((await registry.get("acme", "orb"))?.state, "torn down");
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

// #7677 (ratified 2026-07-21): the provisioning-status surface. The record is written as "provisioning"
// BEFORE the standup starts and transitions to a terminal "failed" before a step failure rethrows — all
// observable via the same GET /v1/tenants read path a customer's dashboard polls.

function swallowConsoleError() {
  const originalError = console.error;
  console.error = () => {};
  consoleErrorRestore = () => {
    console.error = originalError;
  };
}

function failingCreateDriver(): TenantProvisioningDriver {
  return {
    ...createFakeTenantProvisioningDriver(),
    async createContainer() {
      throw new Error("container standup failed");
    },
  };
}

test("a provision failure transitions the record to 'failed', observable via the dashboard's own read path (#7677 acceptance)", async () => {
  swallowConsoleError();
  const registry = createFakeTenantRegistry();
  const app = createTenantHttpApp(baseDeps({ driver: failingCreateDriver(), registry }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );

  assert.equal(res.status, 500); // the failure itself still pages + rethrows exactly as before
  assert.equal((await registry.get("acme", "orb"))?.state, "failed");
  // The SAME read path a customer's dashboard polls (GET /v1/tenants) shows the terminal failed state —
  // not a record stuck at "provisioning" forever.
  const list = await app.request("/v1/tenants", authed());
  const { tenants } = (await list.json()) as { tenants: Array<{ tenant: { name: string }; state: string }> };
  assert.deepEqual(
    tenants.map((t) => ({ name: t.tenant.name, state: t.state })),
    [{ name: "acme", state: "failed" }],
  );
});

test("the record is observable as 'provisioning' while the standup is still in flight (#7677 polling premise)", async () => {
  const registry = createFakeTenantRegistry();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowDriver: TenantProvisioningDriver = {
    ...createFakeTenantProvisioningDriver(),
    async createContainer() {
      await gate;
    },
  };
  const app = createTenantHttpApp(baseDeps({ driver: slowDriver, registry }));

  const pending = app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );
  // Let the route reach the awaited (gated) driver step, then poll mid-standup like the dashboard would.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await registry.get("acme", "orb"))?.state, "provisioning");
  release();
  const res = await pending;
  assert.equal(res.status, 201);
  assert.equal((await registry.get("acme", "orb"))?.state, "active");
});

test("a 'failed' tenant may be re-created — 'Setup failed' invites a retry, it never squats on the name (#7677)", async () => {
  swallowConsoleError();
  const registry = createFakeTenantRegistry();
  const failOnce = failingCreateDriver();
  const app = createTenantHttpApp(baseDeps({ driver: failOnce, registry }));
  const body = { method: "POST" as const, headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb", orbInstallationId: 77 }) };

  assert.equal((await app.request("/v1/tenants", authed(body))).status, 500);
  assert.equal((await registry.get("acme", "orb"))?.state, "failed");

  // Retry with a healthy driver: neither the name+product conflict check nor the installation-ID claim check
  // treats the failed record as a blocker (before #7677 a failure left NO record, so a retry always worked).
  const healthy = createTenantHttpApp(baseDeps({ driver: createFakeTenantProvisioningDriver(), registry }));
  const retry = await healthy.request("/v1/tenants", authed(body));
  assert.equal(retry.status, 201);
  assert.equal((await registry.get("acme", "orb"))?.state, "active");
});

test("an ACTIVE tenant still 409s a re-create — #7677 loosens only the failed/torn-down states", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0", orbInstallationId: 77 });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const sameName = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );
  assert.equal(sameName.status, 409);
  const sameInstallation = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "other", product: "orb", orbInstallationId: 77 }) }),
  );
  assert.equal(sameInstallation.status, 409);
});

test("a rejection writing the 'failed' state never masks the provisioning error itself (#7677 best-effort seam)", async () => {
  swallowConsoleError();
  const registry = createFakeTenantRegistry();
  const fragileRegistry = {
    ...registry,
    async upsert(record: TenantRegistryRecord) {
      if (record.state === "failed") throw new Error("kv write outage");
      await registry.upsert(record);
    },
  };
  const app = createTenantHttpApp(baseDeps({ driver: failingCreateDriver(), registry: fragileRegistry }));

  const res = await app.request(
    "/v1/tenants",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acme", product: "orb" }) }),
  );

  // Still the ORIGINAL provisioning failure surfacing through onError — the failed-state write outage is
  // swallowed, and the record is simply left at its pre-written "provisioning" state.
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "internal_error" });
  assert.equal((await registry.get("acme", "orb"))?.state, "provisioning");
});

// #9143 (defect 3): POST /v1/tenants/rollout is now a deliberate 501 -- #4898's original implementation
// silently no-op'd on every one of its four promised effects (see http-app.ts's own header comment on the
// route). These tests prove the route is disabled explicitly (not a removed 404, and not a silent 200 that
// changes nothing) and still sits behind the same admin Bearer wall as every other /v1/tenants/* route.

test("POST /v1/tenants/rollout is disabled: an explicit 501, not a silent no-op (#9143 defect 3)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0" });
  const app = createTenantHttpApp(baseDeps({ registry }));

  const res = await app.request(
    "/v1/tenants/rollout",
    authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ names: ["acme"], product: "orb", pinnedVersion: "v1.4.2" }) }),
  );

  assert.equal(res.status, 501);
  assert.deepEqual(await res.json(), { error: "not_implemented", message: "tenant rollout is not implemented yet (#9143)" });
  // Nothing was touched -- no silent partial effect the old handler used to have.
  assert.deepEqual((await registry.get("acme", "orb"))?.tenant, { name: "acme" });
});

test("POST /v1/tenants/rollout still sits behind the same Bearer wall as every other /v1/tenants route", async () => {
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

// #7181: POST /v1/orb/webhook wiring. routeOrbWebhook's own branches (signature/JSON/lookup/forward/error
// shapes) are exhaustively covered by orb-webhook-router.test.ts -- these only prove http-app.ts plumbs its
// deps into that function correctly, and that the route sits OUTSIDE the /v1/tenants/* admin-bearer wall.

function fakeOrbStub(response: Response): RouterStubLike {
  return { async fetch() { return response; } };
}

function fakeOrbNamespace(stubs: Record<string, RouterStubLike>): RouterNamespaceLike {
  return { getByName: (name) => stubs[name] ?? { async fetch() { throw new Error(`no stub for "${name}"`); } } };
}

test("POST /v1/orb/webhook is unauthenticated by the admin Bearer wall, and 503s when orbWebhookBinding is unset", async () => {
  const app = createTenantHttpApp(baseDeps());

  const res = await app.request("/v1/orb/webhook", { method: "POST", body: JSON.stringify({ installation: { id: 1 } }) });

  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "service_not_configured" });
});

test("POST /v1/orb/webhook routes a verified delivery through to deps.orbWebhookBinding via deps.registry", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0", orbInstallationId: 42 });
  const containerResponse = Response.json({ ok: true }, { status: 202 });
  const orbWebhookBinding = fakeOrbNamespace({ "orb:acme": fakeOrbStub(containerResponse) });
  const app = createTenantHttpApp(baseDeps({ registry, orbWebhookBinding, orbWebhookSecret: "whsec" }));
  const rawBody = JSON.stringify({ installation: { id: 42 } });

  const res = await app.request("/v1/orb/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", "whsec").update(rawBody).digest("hex")}` },
    body: rawBody,
  });

  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true });
});
