// Shared tenant / product types for the control-plane provisioning core (#7524 / #7180).
// Product-agnostic on purpose: the same call shape serves an ORB tenant and an AMS tenant.

/** Stable tenant identifier within a product plane (not a GitHub login, not a wallet). */
export type TenantId = string;

/**
 * Product key for the hosted plane. Open string so new products do not require orchestration
 * changes — callers today use `"orb"` / `"ams"`.
 */
export type TenantProduct = string;

/** Tenant identity passed through every provisioning step. */
export type TenantRef = {
  tenantId: TenantId;
  product: TenantProduct;
};

export type ContainerHandle = {
  containerId: string;
  /** Opaque reachability hint used by fakes/tests; real drivers may omit. */
  endpoint?: string | undefined;
};

export type DatabaseHandle = {
  databaseId: string;
  /** Opaque connection reference — never a live password in this package. */
  connectionRef?: string | undefined;
};

export type SecretsHandle = {
  enrollId: string;
  /** Broker secret type from the #7174 generalization (e.g. github_token / db_credential). */
  secretType: string;
};

export type ProvisionedTenant = {
  tenant: TenantRef;
  container: ContainerHandle;
  database: DatabaseHandle;
  secrets: SecretsHandle;
  state: "ready";
};

export type DeprovisionedTenant = {
  tenant: TenantRef;
  state: "gone";
  /** True when the driver reported the tenant was already absent (idempotent destroy). */
  alreadyAbsent: boolean;
};
