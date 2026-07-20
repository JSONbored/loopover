// Public entry for @loopover/control-plane: the injectable tenant-provisioning driver contract + fake, and the
// product-agnostic provisionTenant/deprovisionTenant orchestration built on it (#7524).

export {
  createFakeTenantProvisioningDriver,
  type FakeDriverCall,
  type FakeDriverStep,
  type FakeTenantProvisioningDriver,
  type Product,
  type Tenant,
  type TenantLifecycleState,
  type TenantProvisioningDriver,
  type TenantProvisioningRequest,
} from "./tenant-provisioning-driver.js";
export {
  deprovisionTenant,
  provisionTenant,
  type TenantDeprovisioningResult,
  type TenantProvisioningResult,
} from "./provisioning.js";
