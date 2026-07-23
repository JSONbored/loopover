// Public entry for @loopover/control-plane: the injectable tenant-provisioning driver contract + fake, the
// product-agnostic provisionTenant/deprovisionTenant orchestration built on it (#7524), and the PagerDuty
// paging that orchestration fires on a provisioning-lifecycle failure (#7667).

export {
  createFakeTenantProvisioningDriver,
  type DatabaseConnectionDetails,
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
  type ProvisioningPagerDutyOptions,
  type TenantDeprovisioningResult,
  type TenantProvisioningResult,
} from "./provisioning.js";
export {
  buildProvisioningPagerDutyAlert,
  notifyProvisioningFailure,
  pagerDutyFailMessage,
  type NotifyProvisioningFailure,
  type PagerDutySeverity,
  type ProvisioningPagerDutyAlert,
} from "./pagerduty-notify.js";
export {
  createFakeSettlementBackendDriver,
  type FakeSettlementBackendDriver,
  type FakeSettlementCall,
  type FakeSettlementStep,
  type PayoutEligibleEvent,
  type PoolId,
  type SettlementBackendDriver,
  type SettlementReversalReason,
} from "./settlement-backend-driver.js";
export {
  createNeonDatabaseDriver,
  dropNeonDatabase,
  provisionNeonDatabase,
  type DatabaseDriver,
  type NeonDatabaseDriverConfig,
} from "./neon-database-driver.js";
export {
  createTenantProvisioningDriver,
  withRealContainerDriver,
  withRealDatabaseDriver,
  withRealSecretDriver,
} from "./driver-factory.js";
export {
  createSecretDriver,
  injectTenantSecrets,
  revokeTenantSecrets,
  type SecretDriver,
  type SecretDriverConfig,
} from "./secret-driver.js";
export {
  createContainerDriver,
  createTenantContainer,
  destroyTenantContainer,
  instanceNameFor,
  PINNED_VERSION_ENV_VAR,
  TENANT_SECRET_ENV_VAR,
  tenantContainerExists,
  type ContainerDriver,
  type ContainerDriverConfig,
  type ContainerNamespaceLike,
  type ContainerStubLike,
} from "./container-driver.js";
export {
  createFakeTenantRegistry,
  createKvTenantRegistry,
  type AmsCycleSchedule,
  type KvNamespaceLike,
  type TenantRegistry,
  type TenantRegistryRecord,
} from "./tenant-registry.js";
export { createTenantHttpApp, type TenantHttpAppDeps } from "./http-app.js";
export { normalizeSharedSecret, verifyBearer } from "./auth.js";
export {
  wakeDueAmsTenants,
  type AmsWakeConfig,
  type AmsWakeResult,
  type WakeNamespaceLike,
  type WakeStubLike,
} from "./ams-wake.js";
export {
  routeOrbWebhook,
  type OrbWebhookRouterConfig,
  type RouterNamespaceLike,
  type RouterStubLike,
} from "./orb-webhook-router.js";
