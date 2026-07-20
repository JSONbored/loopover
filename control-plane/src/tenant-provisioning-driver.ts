// `TenantProvisioningDriver` injectable seam (#7524). Mirrors `CodingAgentDriver`
// (`packages/loopover-engine/src/miner/coding-agent-driver.ts`): a small interface, provider-agnostic
// handles, and concrete fakes that hold in-memory state so orchestration can be tested without IO.
//
// The three #7180 steps are explicit methods — create-container, provision-DB, inject-secrets — plus
// matching destroy/revoke for deprovision. Real Cloudflare Containers / Postgres SDKs must NOT appear
// in implementations shipped with this issue.

import type { TenantSecretBroker } from "./secret-broker.js";
import type {
  ContainerHandle,
  DatabaseHandle,
  SecretsHandle,
  TenantRef,
} from "./types.js";

export type TenantProvisioningDriver = {
  createContainer(tenant: TenantRef): Promise<ContainerHandle>;
  provisionDatabase(tenant: TenantRef, container: ContainerHandle): Promise<DatabaseHandle>;
  /**
   * Inject tenant credentials via the #7174 broker seam (`TenantSecretBroker`), not a hand-rolled
   * secrets path. Drivers receive the broker at construction time.
   */
  injectSecrets(
    tenant: TenantRef,
    container: ContainerHandle,
    database: DatabaseHandle,
  ): Promise<SecretsHandle>;
  destroyContainer(tenant: TenantRef, containerId: string): Promise<"destroyed" | "absent">;
  destroyDatabase(tenant: TenantRef, databaseId: string): Promise<"destroyed" | "absent">;
  revokeSecrets(tenant: TenantRef, enrollId: string): Promise<"revoked" | "absent">;
};

export type TenantProvisioningDriverDeps = {
  /** Required — inject-secrets must call the broker (#7174 / #7524). */
  broker: TenantSecretBroker;
  /** Secret type recorded on enrollment; defaults to the DB-credential placeholder type. */
  secretType?: string | undefined;
  /** Optional clock for deterministic fake IDs in tests. */
  nowMs?: (() => number) | undefined;
};
