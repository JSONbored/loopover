// provisionTenant / deprovisionTenant orchestration (#7524) over the injectable `TenantProvisioningDriver`.
// Product-agnostic: an ORB tenant and an AMS tenant take the identical call shape — `product` is forwarded to
// every driver step but never branched on. Provision runs #7180's three steps in order (create-container,
// provision-DB, inject-secrets); deprovision tears them down in REVERSE (revoke-secrets, drop-DB,
// destroy-container) so a secret is never left addressable after the DB/container it belonged to is gone.

import type {
  Product,
  Tenant,
  TenantLifecycleState,
  TenantProvisioningDriver,
  TenantProvisioningRequest,
} from "./tenant-provisioning-driver.js";

/** Result of a successful provision — terminal lifecycle state `"active"` (the vocabulary tenant-client.ts
 *  passes through from this API). */
export type TenantProvisioningResult = {
  tenant: Tenant;
  product: Product;
  state: Extract<TenantLifecycleState, "active">;
};

/** Result of a successful deprovision — terminal lifecycle state `"torn down"`. */
export type TenantDeprovisioningResult = {
  tenant: Tenant;
  product: Product;
  state: Extract<TenantLifecycleState, "torn down">;
};

/** Provision a tenant by running #7180's three steps in order against the injected driver. Product-agnostic:
 *  `product` is forwarded to every step, never branched on, so ORB and AMS share one call shape. */
export async function provisionTenant(
  tenant: Tenant,
  product: Product,
  driver: TenantProvisioningDriver,
): Promise<TenantProvisioningResult> {
  const request: TenantProvisioningRequest = { tenant, product };
  await driver.createContainer(request);
  await driver.provisionDatabase(request);
  await driver.injectSecrets(request);
  return { tenant, product, state: "active" };
}

/** Deprovision a tenant by tearing #7180's three steps down in REVERSE order. Same product-agnostic call shape
 *  as provisionTenant. Idempotent by driver contract: deprovisioning a tenant that was never provisioned is a
 *  safe no-op, never a throw. */
export async function deprovisionTenant(
  tenant: Tenant,
  product: Product,
  driver: TenantProvisioningDriver,
): Promise<TenantDeprovisioningResult> {
  const request: TenantProvisioningRequest = { tenant, product };
  await driver.revokeSecrets(request);
  await driver.dropDatabase(request);
  await driver.destroyContainer(request);
  return { tenant, product, state: "torn down" };
}
