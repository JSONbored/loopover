// In-memory `TenantProvisioningDriver` (#7524). Mirrors `createFakeCodingAgentDriver`: maps stand in for
// "a container exists" / "a DB exists," toggled by the same create/destroy calls. injectSecrets always
// goes through the injected `TenantSecretBroker` (#7174 seam) — never a parallel secrets store.

import { createFakeTenantSecretBroker } from "./fake-secret-broker.js";
import { TENANT_SECRET_TYPE_DB_CREDENTIAL } from "./secret-broker.js";
import type { TenantProvisioningDriver, TenantProvisioningDriverDeps } from "./tenant-provisioning-driver.js";
import type {
  ContainerHandle,
  DatabaseHandle,
  SecretsHandle,
  TenantRef,
} from "./types.js";

function tenantKey(tenant: TenantRef): string {
  return `${tenant.product}::${tenant.tenantId}`;
}

export type FakeTenantProvisioningDriver = TenantProvisioningDriver & {
  readonly containers: ReadonlyMap<string, ContainerHandle>;
  readonly databases: ReadonlyMap<string, DatabaseHandle>;
  readonly secretsByTenant: ReadonlyMap<string, SecretsHandle>;
  containerExists(tenant: TenantRef): boolean;
  databaseExists(tenant: TenantRef): boolean;
  reset(): void;
};

export function createFakeTenantProvisioningDriver(
  deps: Partial<TenantProvisioningDriverDeps> & { broker?: TenantProvisioningDriverDeps["broker"] } = {},
): FakeTenantProvisioningDriver {
  const broker = deps.broker ?? createFakeTenantSecretBroker();
  const secretType = deps.secretType ?? TENANT_SECRET_TYPE_DB_CREDENTIAL;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const containers = new Map<string, ContainerHandle>();
  const databases = new Map<string, DatabaseHandle>();
  const secretsByTenant = new Map<string, SecretsHandle>();
  let seq = 0;

  return {
    get containers() {
      return containers;
    },
    get databases() {
      return databases;
    },
    get secretsByTenant() {
      return secretsByTenant;
    },
    containerExists(tenant) {
      return containers.has(tenantKey(tenant));
    },
    databaseExists(tenant) {
      return databases.has(tenantKey(tenant));
    },
    reset() {
      containers.clear();
      databases.clear();
      secretsByTenant.clear();
      seq = 0;
    },
    async createContainer(tenant) {
      const key = tenantKey(tenant);
      const existing = containers.get(key);
      if (existing) return existing;
      seq += 1;
      const handle: ContainerHandle = {
        containerId: `ctr_${tenant.product}_${tenant.tenantId}_${seq}_${nowMs()}`,
        endpoint: `fake://${tenant.product}/${tenant.tenantId}`,
      };
      containers.set(key, handle);
      return handle;
    },
    async provisionDatabase(tenant, container) {
      const key = tenantKey(tenant);
      const existing = databases.get(key);
      if (existing) return existing;
      seq += 1;
      const handle: DatabaseHandle = {
        databaseId: `db_${tenant.product}_${tenant.tenantId}_${seq}`,
        connectionRef: `fake-db://${container.containerId}`,
      };
      databases.set(key, handle);
      return handle;
    },
    async injectSecrets(tenant, _container, _database): Promise<SecretsHandle> {
      const key = tenantKey(tenant);
      const existing = secretsByTenant.get(key);
      if (existing) return existing;
      const issued = await broker.issueEnrollment({
        tenantId: tenant.tenantId,
        product: tenant.product,
        secretType,
      });
      const handle: SecretsHandle = { enrollId: issued.enrollId, secretType };
      secretsByTenant.set(key, handle);
      return handle;
    },
    async destroyContainer(tenant, containerId) {
      const key = tenantKey(tenant);
      const current = containers.get(key);
      if (!current || current.containerId !== containerId) return "absent";
      containers.delete(key);
      return "destroyed";
    },
    async destroyDatabase(tenant, databaseId) {
      const key = tenantKey(tenant);
      const current = databases.get(key);
      if (!current || current.databaseId !== databaseId) return "absent";
      databases.delete(key);
      return "destroyed";
    },
    async revokeSecrets(tenant, enrollId) {
      const key = tenantKey(tenant);
      const current = secretsByTenant.get(key);
      if (!current || current.enrollId !== enrollId) {
        const brokerResult = await broker.revokeEnrollment(enrollId);
        return brokerResult === "revoked" ? "revoked" : "absent";
      }
      const brokerResult = await broker.revokeEnrollment(enrollId);
      secretsByTenant.delete(key);
      return brokerResult === "revoked" ? "revoked" : "absent";
    },
  };
}
