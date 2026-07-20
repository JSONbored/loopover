// Public exports for `@loopover/control-plane` (#7524).

export { ControlPlaneError, isControlPlaneError, type ControlPlaneErrorCode } from "./errors.js";
export {
  createFakeTenantSecretBroker,
  type FakeSecretBrokerEnrollment,
  type FakeTenantSecretBroker,
} from "./fake-secret-broker.js";
export {
  createFakeTenantProvisioningDriver,
  type FakeTenantProvisioningDriver,
} from "./fake-tenant-provisioning-driver.js";
export { deprovisionTenant, type DeprovisionTenantOptions } from "./deprovision-tenant.js";
export { provisionTenant, type ProvisionTenantOptions } from "./provision-tenant.js";
export {
  TENANT_SECRET_TYPE_DB_CREDENTIAL,
  TENANT_SECRET_TYPE_GITHUB_TOKEN,
  type TenantSecretBroker,
  type TenantSecretBrokerIssueInput,
  type TenantSecretBrokerIssueResult,
  type TenantSecretBrokerRevokeResult,
} from "./secret-broker.js";
export type {
  TenantProvisioningDriver,
  TenantProvisioningDriverDeps,
} from "./tenant-provisioning-driver.js";
export type {
  ContainerHandle,
  DatabaseHandle,
  DeprovisionedTenant,
  ProvisionedTenant,
  SecretsHandle,
  TenantId,
  TenantProduct,
  TenantRef,
} from "./types.js";
export { assertValidTenantRef } from "./validate-tenant.js";
