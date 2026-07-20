// `deprovisionTenant` orchestration (#7524 / #7180). Reverse of provision: revoke secrets → destroy DB →
// destroy container. Destroy of a nonexistent tenant is idempotent (`alreadyAbsent: true`).

import { ControlPlaneError, isControlPlaneError } from "./errors.js";
import type { TenantProvisioningDriver } from "./tenant-provisioning-driver.js";
import type { DeprovisionedTenant, SecretsHandle, TenantRef } from "./types.js";
import { assertValidTenantRef } from "./validate-tenant.js";

export type DeprovisionTenantOptions = {
  driver: TenantProvisioningDriver;
  /**
   * Optional handles from a prior `provisionTenant` result. When omitted, the driver is asked to
   * destroy using best-effort absent-tolerant calls (fake driver returns `"absent"`).
   */
  provisioned?:
    | {
        containerId: string;
        databaseId: string;
        secrets: SecretsHandle;
      }
    | undefined;
};

/**
 * Tear down a hosted tenant through the driver seam. Idempotent when the tenant is already gone.
 */
export async function deprovisionTenant(
  tenantInput: TenantRef,
  options: DeprovisionTenantOptions,
): Promise<DeprovisionedTenant> {
  const tenant = assertValidTenantRef(tenantInput);
  const { driver, provisioned } = options;

  let secretsResult: "revoked" | "absent" = "absent";
  let databaseResult: "destroyed" | "absent" = "absent";
  let containerResult: "destroyed" | "absent" = "absent";

  if (provisioned) {
    try {
      secretsResult = await driver.revokeSecrets(tenant, provisioned.secrets.enrollId);
    } catch (error) {
      if (isControlPlaneError(error)) throw error;
      throw new ControlPlaneError(
        "secrets_revoke_failed",
        `Secrets revoke failed for ${tenant.product}/${tenant.tenantId}`,
        error,
      );
    }
    try {
      databaseResult = await driver.destroyDatabase(tenant, provisioned.databaseId);
    } catch (error) {
      if (isControlPlaneError(error)) throw error;
      throw new ControlPlaneError(
        "database_destroy_failed",
        `Database destroy failed for ${tenant.product}/${tenant.tenantId}`,
        error,
      );
    }
    try {
      containerResult = await driver.destroyContainer(tenant, provisioned.containerId);
    } catch (error) {
      if (isControlPlaneError(error)) throw error;
      throw new ControlPlaneError(
        "container_destroy_failed",
        `Container destroy failed for ${tenant.product}/${tenant.tenantId}`,
        error,
      );
    }
  }

  const alreadyAbsent =
    secretsResult === "absent" && databaseResult === "absent" && containerResult === "absent";

  return { tenant, state: "gone", alreadyAbsent };
}
