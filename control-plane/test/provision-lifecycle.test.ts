import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ControlPlaneError,
  createFakeTenantProvisioningDriver,
  createFakeTenantSecretBroker,
  deprovisionTenant,
  isControlPlaneError,
  provisionTenant,
  TENANT_SECRET_TYPE_DB_CREDENTIAL,
  TENANT_SECRET_TYPE_GITHUB_TOKEN,
} from "../dist/index.js";

test("#7524: provisionTenant create → container exists → deprovision → container gone (fake driver)", async () => {
  const broker = createFakeTenantSecretBroker();
  const driver = createFakeTenantProvisioningDriver({ broker, nowMs: () => 1_700_000_000_000 });
  const tenant = { tenantId: "acme-1", product: "orb" };

  const provisioned = await provisionTenant(tenant, { driver });
  assert.equal(provisioned.state, "ready");
  assert.equal(provisioned.tenant.product, "orb");
  assert.equal(driver.containerExists(tenant), true);
  assert.equal(driver.databaseExists(tenant), true);
  assert.equal(provisioned.secrets.secretType, TENANT_SECRET_TYPE_DB_CREDENTIAL);
  assert.ok(broker.enrollments.has(provisioned.secrets.enrollId));

  const gone = await deprovisionTenant(tenant, {
    driver,
    provisioned: {
      containerId: provisioned.container.containerId,
      databaseId: provisioned.database.databaseId,
      secrets: provisioned.secrets,
    },
  });
  assert.equal(gone.state, "gone");
  assert.equal(gone.alreadyAbsent, false);
  assert.equal(driver.containerExists(tenant), false);
  assert.equal(driver.databaseExists(tenant), false);
  assert.equal(broker.enrollments.get(provisioned.secrets.enrollId)?.revoked, true);
});

test("#7524: product-agnostic — AMS uses the same provision/deprovision call shape", async () => {
  const driver = createFakeTenantProvisioningDriver({ nowMs: () => 42 });
  const tenant = { tenantId: "ams-tenant", product: "AMS" };
  const provisioned = await provisionTenant(tenant, { driver });
  assert.equal(provisioned.tenant.product, "ams");
  assert.equal(driver.containerExists({ tenantId: "ams-tenant", product: "ams" }), true);

  await deprovisionTenant(
    { tenantId: "ams-tenant", product: "ams" },
    {
      driver,
      provisioned: {
        containerId: provisioned.container.containerId,
        databaseId: provisioned.database.databaseId,
        secrets: provisioned.secrets,
      },
    },
  );
  assert.equal(driver.containerExists({ tenantId: "ams-tenant", product: "ams" }), false);
});

test("#7524: deprovision of a nonexistent tenant is idempotent (alreadyAbsent)", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const tenant = { tenantId: "missing", product: "orb" };
  const gone = await deprovisionTenant(tenant, {
    driver,
    provisioned: {
      containerId: "ctr_missing",
      databaseId: "db_missing",
      secrets: { enrollId: "enr_missing", secretType: TENANT_SECRET_TYPE_DB_CREDENTIAL },
    },
  });
  assert.equal(gone.state, "gone");
  assert.equal(gone.alreadyAbsent, true);
});

test("#7524: deprovision without provisioned handles reports alreadyAbsent", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const gone = await deprovisionTenant({ tenantId: "x", product: "orb" }, { driver });
  assert.equal(gone.alreadyAbsent, true);
});

test("#7524: inject-secrets records #7174 secret_type via the broker seam", async () => {
  const broker = createFakeTenantSecretBroker();
  const driver = createFakeTenantProvisioningDriver({
    broker,
    secretType: TENANT_SECRET_TYPE_GITHUB_TOKEN,
    nowMs: () => 1,
  });
  const provisioned = await provisionTenant({ tenantId: "sec", product: "orb" }, { driver });
  const row = broker.enrollments.get(provisioned.secrets.enrollId);
  assert.equal(row?.secretType, TENANT_SECRET_TYPE_GITHUB_TOKEN);
  assert.equal(provisioned.secrets.secretType, TENANT_SECRET_TYPE_GITHUB_TOKEN);
});

test("#7524: rejects invalid tenantId / product before any driver call", async () => {
  const driver = createFakeTenantProvisioningDriver();
  await assert.rejects(
    () => provisionTenant({ tenantId: "", product: "orb" }, { driver }),
    (error: unknown) => isControlPlaneError(error) && error.code === "invalid_tenant",
  );
  await assert.rejects(
    () => provisionTenant({ tenantId: "ok", product: "!!" }, { driver }),
    (error: unknown) => isControlPlaneError(error) && error.code === "invalid_product",
  );
  assert.equal(driver.containers.size, 0);
});

test("#7524: rolls back container when database provision throws", async () => {
  const driver = createFakeTenantProvisioningDriver({ nowMs: () => 9 });
  driver.provisionDatabase = async () => {
    throw new Error("db boom");
  };
  await assert.rejects(
    () => provisionTenant({ tenantId: "roll-db", product: "orb" }, { driver }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "database_provision_failed",
  );
  assert.equal(driver.containerExists({ tenantId: "roll-db", product: "orb" }), false);
  assert.equal(driver.databaseExists({ tenantId: "roll-db", product: "orb" }), false);
});

test("#7524: rolls back database + container when secrets inject throws", async () => {
  const driver = createFakeTenantProvisioningDriver({ nowMs: () => 8 });
  driver.injectSecrets = async () => {
    throw new Error("broker boom");
  };
  await assert.rejects(
    () => provisionTenant({ tenantId: "roll-sec", product: "orb" }, { driver }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "secrets_inject_failed",
  );
  assert.equal(driver.containerExists({ tenantId: "roll-sec", product: "orb" }), false);
  assert.equal(driver.databaseExists({ tenantId: "roll-sec", product: "orb" }), false);
});

test("#7524: fake driver create is idempotent for the same tenant key", async () => {
  const driver = createFakeTenantProvisioningDriver({ nowMs: () => 3 });
  const tenant = { tenantId: "same", product: "orb" };
  const a = await driver.createContainer(tenant);
  const b = await driver.createContainer(tenant);
  assert.equal(a.containerId, b.containerId);
  assert.equal(driver.containers.size, 1);
});

test("isControlPlaneError narrows only ControlPlaneError instances", () => {
  assert.equal(isControlPlaneError(new ControlPlaneError("invalid_tenant", "x")), true);
  assert.equal(isControlPlaneError(new Error("x")), false);
  assert.equal(isControlPlaneError(null), false);
});
