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
  type TenantProvisioningDriver,
  type TenantProvisioningRequest,
} from "../dist/index.js";

test("provisionTenant runs the three #7180 steps in order and reports the tenant active", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const tenant: Tenant = { name: "acme" };

  const result = await provisionTenant(tenant, "orb", driver);

  assert.deepEqual(result, {
    tenant,
    product: "orb",
    state: "active",
    database: {
      host: "fake-acme.control-plane.invalid",
      port: 5432,
      database: "acme",
      user: "acme",
      password: "fake-password-acme",
      connectionString: "postgres://acme:fake-password-acme@fake-acme.control-plane.invalid:5432/acme",
    },
  });
  // provision-DB → inject-secrets → create-container, in that order (#8202: reordered from the original
  // create-container-first sequence so a tenant's bootstrap secret exists before its one real start() call).
  assert.deepEqual(
    driver.calls.map((call) => call.step),
    ["provisionDatabase", "injectSecrets", "createContainer"],
  );
  // Container "exists"/reachable via the fake after provision.
  assert.equal(await driver.containerExists({ tenant, product: "orb" }), true);
  assert.ok(driver.databases.has("orb:acme"));
  assert.ok(driver.injectedSecrets.has("orb:acme"));
});

test("full lifecycle: provision → container exists → deprovision → container gone", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const tenant: Tenant = { name: "acme" };

  await provisionTenant(tenant, "ams", driver);
  assert.equal(await driver.containerExists({ tenant, product: "ams" }), true);

  const result = await deprovisionTenant(tenant, "ams", driver);

  assert.deepEqual(result, { tenant, product: "ams", state: "torn down" });
  assert.equal(await driver.containerExists({ tenant, product: "ams" }), false);
  assert.equal(driver.databases.has("ams:acme"), false);
  assert.equal(driver.injectedSecrets.has("ams:acme"), false);
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
  assert.equal(driver.containers.has("ams:ghost"), false);
});

test("#8066: provisionTenant attaches the freshly provisioned database to the injectSecrets request", async () => {
  const fake = createFakeTenantProvisioningDriver();
  let seenRequest: TenantProvisioningRequest | undefined;
  const driver: TenantProvisioningDriver = {
    ...fake,
    injectSecrets: async (request) => {
      seenRequest = request;
      return { secretRef: "orbenr_abc" };
    },
  };
  const tenant: Tenant = { name: "acme" };

  const result = await provisionTenant(tenant, "orb", driver);

  assert.deepEqual(seenRequest?.database, result.database);
  assert.equal(result.secretRef, "orbenr_abc");
});

test("#8202: provisionTenant threads injectSecrets' bootstrapSecret into the createContainer request", async () => {
  const fake = createFakeTenantProvisioningDriver();
  let seenRequest: TenantProvisioningRequest | undefined;
  const driver: TenantProvisioningDriver = {
    ...fake,
    injectSecrets: async () => ({ secretRef: "orbenr_abc", bootstrapSecret: "orbsec_xyz" }),
    createContainer: async (request) => {
      seenRequest = request;
    },
  };
  const tenant: Tenant = { name: "acme" };

  await provisionTenant(tenant, "orb", driver);

  assert.equal(seenRequest?.bootstrapSecret, "orbsec_xyz");
  assert.deepEqual(seenRequest?.database, {
    host: "fake-acme.control-plane.invalid",
    port: 5432,
    database: "acme",
    user: "acme",
    password: "fake-password-acme",
    connectionString: "postgres://acme:fake-password-acme@fake-acme.control-plane.invalid:5432/acme",
  });
});

test("#8202: provisionTenant's createContainer request omits bootstrapSecret entirely when injectSecrets returns none (the fake's own behavior)", async () => {
  const fake = createFakeTenantProvisioningDriver();
  let seenRequest: TenantProvisioningRequest | undefined;
  const driver: TenantProvisioningDriver = {
    ...fake,
    createContainer: async (request) => {
      seenRequest = request;
    },
  };
  const tenant: Tenant = { name: "acme" };

  await provisionTenant(tenant, "orb", driver);

  assert.equal("bootstrapSecret" in (seenRequest ?? {}), false);
});

test("#8066: provisionTenant's result omits secretRef entirely when the driver returns none (the fake's own behavior)", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const tenant: Tenant = { name: "acme" };

  const result = await provisionTenant(tenant, "orb", driver);

  assert.equal("secretRef" in result, false);
});

test("#8066: deprovisionTenant threads secretRef into the revokeSecrets request", async () => {
  const fake = createFakeTenantProvisioningDriver();
  let seenRequest: TenantProvisioningRequest | undefined;
  const driver: TenantProvisioningDriver = {
    ...fake,
    revokeSecrets: async (request) => {
      seenRequest = request;
    },
  };
  const tenant: Tenant = { name: "acme" };

  await deprovisionTenant(tenant, "orb", driver, {}, "orbenr_abc");

  assert.equal(seenRequest?.secretRef, "orbenr_abc");
});

test("#8066: deprovisionTenant omits secretRef from the request entirely when none is passed", async () => {
  const fake = createFakeTenantProvisioningDriver();
  let seenRequest: TenantProvisioningRequest | undefined;
  const driver: TenantProvisioningDriver = {
    ...fake,
    revokeSecrets: async (request) => {
      seenRequest = request;
    },
  };
  const tenant: Tenant = { name: "acme" };

  await deprovisionTenant(tenant, "orb", driver);

  assert.equal("secretRef" in (seenRequest ?? {}), false);
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
