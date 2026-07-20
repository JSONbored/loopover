// Orchestration tests for provisionTenant / deprovisionTenant against the fake driver. Covers the acceptance
// shape (create → container exists/reachable → destroy → container gone) and BOTH driver-lifecycle branches:
// the success path AND deprovisioning a never-provisioned tenant.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFakeTenantProvisioningDriver,
  deprovisionTenant,
  provisionTenant,
  type Tenant,
} from "../dist/index.js";

test("provisionTenant runs the three #7180 steps in order and reports the tenant active", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const tenant: Tenant = { name: "acme" };

  const result = await provisionTenant(tenant, "orb", driver);

  assert.deepEqual(result, { tenant, product: "orb", state: "active" });
  // create-container → provision-DB → inject-secrets, in that order.
  assert.deepEqual(
    driver.calls.map((call) => call.step),
    ["createContainer", "provisionDatabase", "injectSecrets"],
  );
  // Container "exists"/reachable via the fake after provision.
  assert.equal(await driver.containerExists({ tenant, product: "orb" }), true);
  assert.ok(driver.databases.has("acme"));
  assert.ok(driver.injectedSecrets.has("acme"));
});

test("full lifecycle: provision → container exists → deprovision → container gone", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const tenant: Tenant = { name: "acme" };

  await provisionTenant(tenant, "ams", driver);
  assert.equal(await driver.containerExists({ tenant, product: "ams" }), true);

  const result = await deprovisionTenant(tenant, "ams", driver);

  assert.deepEqual(result, { tenant, product: "ams", state: "torn down" });
  assert.equal(await driver.containerExists({ tenant, product: "ams" }), false);
  assert.equal(driver.databases.has("acme"), false);
  assert.equal(driver.injectedSecrets.has("acme"), false);
});

test("deprovisionTenant tears the steps down in reverse order", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const tenant: Tenant = { name: "acme" };

  await provisionTenant(tenant, "orb", driver);
  const teardownStart = driver.calls.length;
  await deprovisionTenant(tenant, "orb", driver);

  const teardownSteps = driver.calls
    .slice(teardownStart)
    .map((call) => call.step);
  assert.deepEqual(teardownSteps, [
    "revokeSecrets",
    "dropDatabase",
    "destroyContainer",
  ]);
});

test("deprovisionTenant on a never-provisioned tenant is a safe no-op that still reports torn down", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const tenant: Tenant = { name: "ghost" };

  // The destroy-of-a-nonexistent-tenant branch: resolves, never throws, container stays gone.
  const result = await deprovisionTenant(tenant, "ams", driver);

  assert.deepEqual(result, { tenant, product: "ams", state: "torn down" });
  assert.equal(await driver.containerExists({ tenant, product: "ams" }), false);
  assert.equal(driver.containers.has("ghost"), false);
});

test("the call shape is identical for an ORB tenant and an AMS tenant (product-agnostic)", async () => {
  const orb = createFakeTenantProvisioningDriver();
  const ams = createFakeTenantProvisioningDriver();
  const tenant: Tenant = { name: "acme" };

  const orbResult = await provisionTenant(tenant, "orb", orb);
  const amsResult = await provisionTenant(tenant, "ams", ams);

  // Same steps, same order — only the forwarded product differs.
  assert.deepEqual(
    orb.calls.map((call) => call.step),
    ams.calls.map((call) => call.step),
  );
  assert.equal(orbResult.product, "orb");
  assert.equal(amsResult.product, "ams");
  for (const call of orb.calls) assert.equal(call.product, "orb");
  for (const call of ams.calls) assert.equal(call.product, "ams");
});
