// Selects a fake vs. partially-real `TenantProvisioningDriver` (#7653) -- the "driver factory" mechanism
// #7653's own issue text assumes but, per a full repo read at the time this was written, did not yet exist
// anywhere in `control-plane/`. Composition, not a second full driver implementation: `withRealDatabaseDriver`
// takes any base driver (today, always the fake -- #7851/#7852 haven't landed their own real
// createContainer/injectSecrets yet) and swaps in real Neon-backed provisionDatabase/dropDatabase, leaving
// every other step exactly as the base driver already implements it. This is what lets #7653 ship
// independently of #7851/#7852, and lets each of those compose their own real methods in on top later without
// this file changing.
import { createNeonDatabaseDriver, type DatabaseDriver, type NeonDatabaseDriverConfig } from "./neon-database-driver.js";
import { createFakeTenantProvisioningDriver, type TenantProvisioningDriver } from "./tenant-provisioning-driver.js";

function nonBlank(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** Compose a real database driver onto an existing `TenantProvisioningDriver`, overriding only
 *  `provisionDatabase`/`dropDatabase` -- every other step (createContainer, injectSecrets, containerExists,
 *  destroyContainer, revokeSecrets) is forwarded to `base` unchanged. */
export function withRealDatabaseDriver(base: TenantProvisioningDriver, databaseDriver: DatabaseDriver): TenantProvisioningDriver {
  return {
    ...base,
    provisionDatabase: (request) => databaseDriver.provisionDatabase(request),
    dropDatabase: (request) => databaseDriver.dropDatabase(request),
  };
}

/** Selects a real Neon-backed database driver (composed onto an otherwise-fake `TenantProvisioningDriver`) when
 *  `NEON_API_KEY`/`NEON_PROJECT_ID` are both configured, or the plain fake driver otherwise -- e.g. in tests, or
 *  before a maintainer has provisioned a real Neon project (#7875-style account setup). Takes `env` as a plain
 *  parameter (defaulting to `process.env`) rather than reading it internally, matching this package's existing
 *  `ProvisioningPagerDutyOptions.env` seam so callers can inject a fake env in tests without any real
 *  environment-variable mutation. */
export function createTenantProvisioningDriver(env: Record<string, string | undefined> = process.env): TenantProvisioningDriver {
  const fake = createFakeTenantProvisioningDriver();
  const apiKey = nonBlank(env.NEON_API_KEY);
  const projectId = nonBlank(env.NEON_PROJECT_ID);
  if (!apiKey || !projectId) return fake;

  const config: NeonDatabaseDriverConfig = { apiKey, projectId };
  return withRealDatabaseDriver(fake, createNeonDatabaseDriver(config));
}
