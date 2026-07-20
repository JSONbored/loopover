// Contract tests for the in-memory fake driver — the maps toggle with create/destroy, and both the
// destroy-of-an-existing and destroy-of-a-nonexistent (idempotent no-op) branches are exercised.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFakeTenantProvisioningDriver,
  type TenantProvisioningRequest,
} from "../dist/index.js";

const requestFor = (
  name: string,
  product: string,
): TenantProvisioningRequest => ({
  tenant: { name },
  product,
});

test("createContainer makes the tenant's container exist; destroyContainer removes it", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const request = requestFor("acme", "orb");

  assert.equal(await driver.containerExists(request), false);
  await driver.createContainer(request);
  assert.equal(await driver.containerExists(request), true);
  assert.ok(driver.containers.has("acme"));

  await driver.destroyContainer(request);
  assert.equal(await driver.containerExists(request), false);
  assert.equal(driver.containers.has("acme"), false);
});

test("destroyContainer on a never-created container is an idempotent no-op", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const request = requestFor("ghost", "ams");

  // else-branch: nothing to remove — must not throw.
  await driver.destroyContainer(request);
  assert.equal(await driver.containerExists(request), false);
  assert.equal(driver.containers.has("ghost"), false);
});

test("provision/teardown steps toggle the database and secret maps too", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const request = requestFor("acme", "ams");

  await driver.provisionDatabase(request);
  await driver.injectSecrets(request);
  assert.ok(driver.databases.has("acme"));
  assert.ok(driver.injectedSecrets.has("acme"));

  await driver.dropDatabase(request);
  await driver.revokeSecrets(request);
  assert.equal(driver.databases.has("acme"), false);
  assert.equal(driver.injectedSecrets.has("acme"), false);
});

test("dropDatabase / revokeSecrets on a never-provisioned tenant are idempotent no-ops", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const request = requestFor("ghost", "orb");

  await driver.dropDatabase(request);
  await driver.revokeSecrets(request);
  assert.equal(driver.databases.has("ghost"), false);
  assert.equal(driver.injectedSecrets.has("ghost"), false);
});

test("the fake records every step it runs, in call order, with its tenant and product", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const request = requestFor("acme", "orb");

  await driver.createContainer(request);
  await driver.injectSecrets(request);

  assert.deepEqual(
    driver.calls.map((call) => call.step),
    ["createContainer", "injectSecrets"],
  );
  assert.deepEqual(driver.calls[0]?.tenant, { name: "acme" });
  assert.equal(driver.calls[0]?.product, "orb");
});
