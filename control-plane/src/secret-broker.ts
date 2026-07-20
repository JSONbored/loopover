// #7174 broker-shaped secret injection seam for tenant provisioning (#7524 / #7180).
//
// The Orb token broker already generalized enrollments with a `secret_type` column so a future
// AI-provider-key / DB-credential mint strategy can record what a row is FOR without a second table
// (`src/orb/broker.ts`). This control-plane seam calls into that model — it does not invent a
// parallel secrets store. Real wiring to `issueOrbEnrollment` / revoke paths lives in a follow-up
// driver; this package only defines the injectable contract + an in-memory fake for tests.

/** The only type the live Orb broker mints today (#7174). */
export const TENANT_SECRET_TYPE_GITHUB_TOKEN = "github_token";

/**
 * Placeholder type for a future DB-credential mint strategy called out in #7174 / #7180.
 * The fake broker accepts it so orchestration can prove the inject-secrets step records the type.
 */
export const TENANT_SECRET_TYPE_DB_CREDENTIAL = "db_credential";

export type TenantSecretBrokerIssueInput = {
  tenantId: string;
  product: string;
  secretType: string;
};

export type TenantSecretBrokerIssueResult = {
  enrollId: string;
  /** Plaintext is shown once in the real broker; fakes only acknowledge the contract. */
  secretShownOnce: true;
};

export type TenantSecretBrokerRevokeResult = "revoked" | "not_found";

/**
 * Injectable broker used by `TenantProvisioningDriver.injectSecrets` / revoke paths.
 * Mirrors the #7174 enrollment issue/revoke shape without depending on Worker `Env`.
 */
export interface TenantSecretBroker {
  issueEnrollment(input: TenantSecretBrokerIssueInput): Promise<TenantSecretBrokerIssueResult>;
  revokeEnrollment(enrollId: string): Promise<TenantSecretBrokerRevokeResult>;
}
