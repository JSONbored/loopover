// `provisionTenant` orchestration (#7524 / #7180). Product-agnostic: same steps for ORB and AMS.
// Runs create-container → provision-DB → inject-secrets against the injectable driver only.
// On mid-flight failure, rolls back earlier steps best-effort (destroy DB / container).

import { ControlPlaneError, isControlPlaneError } from "./errors.js";
import type { TenantProvisioningDriver } from "./tenant-provisioning-driver.js";
import type { ProvisionedTenant, TenantRef } from "./types.js";
import { assertValidTenantRef } from "./validate-tenant.js";

export type ProvisionTenantOptions = {
  driver: TenantProvisioningDriver;
};

async function rollbackAfterSecretsFailure(
  driver: TenantProvisioningDriver,
  tenant: TenantRef,
  containerId: string,
  databaseId: string,
  primary: unknown,
): Promise<never> {
  const destroyDb = await driver.destroyDatabase(tenant, databaseId).catch((error: unknown) => error);
  const destroyCtr = await driver.destroyContainer(tenant, containerId).catch((error: unknown) => error);
  if (destroyDb instanceof Error || destroyCtr instanceof Error) {
    throw new ControlPlaneError(
      "rollback_failed",
      `Secrets inject failed and rollback also failed for ${tenant.product}/${tenant.tenantId}`,
      { primary, destroyDb, destroyCtr },
    );
  }
  if (isControlPlaneError(primary)) throw primary;
  throw new ControlPlaneError(
    "secrets_inject_failed",
    `Secrets inject failed for ${tenant.product}/${tenant.tenantId}`,
    primary,
  );
}

async function rollbackAfterDatabaseFailure(
  driver: TenantProvisioningDriver,
  tenant: TenantRef,
  containerId: string,
  primary: unknown,
): Promise<never> {
  const destroyCtr = await driver.destroyContainer(tenant, containerId).catch((error: unknown) => error);
  if (destroyCtr instanceof Error) {
    throw new ControlPlaneError(
      "rollback_failed",
      `Database provision failed and container rollback also failed for ${tenant.product}/${tenant.tenantId}`,
      { primary, destroyCtr },
    );
  }
  if (isControlPlaneError(primary)) throw primary;
  throw new ControlPlaneError(
    "database_provision_failed",
    `Database provision failed for ${tenant.product}/${tenant.tenantId}`,
    primary,
  );
}

/**
 * Provision a hosted tenant through the driver seam. Does not call Cloudflare or Postgres directly.
 */
export async function provisionTenant(
  tenantInput: TenantRef,
  options: ProvisionTenantOptions,
): Promise<ProvisionedTenant> {
  const tenant = assertValidTenantRef(tenantInput);
  const { driver } = options;

  let container;
  try {
    container = await driver.createContainer(tenant);
  } catch (error) {
    if (isControlPlaneError(error)) throw error;
    throw new ControlPlaneError(
      "container_create_failed",
      `Container create failed for ${tenant.product}/${tenant.tenantId}`,
      error,
    );
  }

  let database;
  try {
    database = await driver.provisionDatabase(tenant, container);
  } catch (error) {
    return rollbackAfterDatabaseFailure(driver, tenant, container.containerId, error);
  }

  let secrets;
  try {
    secrets = await driver.injectSecrets(tenant, container, database);
  } catch (error) {
    return rollbackAfterSecretsFailure(driver, tenant, container.containerId, database.databaseId, error);
  }

  return { tenant, container, database, secrets, state: "ready" };
}
