// Selects a fake vs. partially-real `TenantProvisioningDriver` (#7653, #7851) -- the "driver factory"
// mechanism #7653's own issue text assumed but, per a full repo read at the time it was written, did not yet
// exist anywhere in `control-plane/`. Composition, not a second full driver implementation: each
// `withReal*Driver` helper takes any base driver and swaps in real methods for its own slice of the
// interface (`withRealDatabaseDriver` -> provisionDatabase/dropDatabase, `withRealContainerDriver` ->
// createContainer/destroyContainer/containerExists), leaving every other step exactly as the base driver
// already implements it. This is what let #7653 and #7851 ship independently of each other and of #7852
// (secret injection, still not landed) -- that piece will compose its own real methods in on top later
// without this file changing.
import { createContainerDriver, type ContainerDriver, type ContainerDriverConfig } from "./container-driver.js";
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

/** Compose a real container driver onto an existing `TenantProvisioningDriver`, overriding only
 *  `createContainer`/`destroyContainer`/`containerExists` -- every other step is forwarded to `base`
 *  unchanged. Same composition shape as `withRealDatabaseDriver` -- independently stackable, so #7653's
 *  database driver and #7851's container driver can each be composed onto the same base driver without
 *  knowing about each other. */
export function withRealContainerDriver(base: TenantProvisioningDriver, containerDriver: ContainerDriver): TenantProvisioningDriver {
  return {
    ...base,
    createContainer: (request) => containerDriver.createContainer(request),
    destroyContainer: (request) => containerDriver.destroyContainer(request),
    containerExists: (request) => containerDriver.containerExists(request),
  };
}

/** Selects real drivers piece by piece as their config becomes available, composed onto the fake for
 *  whatever isn't configured yet: the real Neon database driver when `NEON_API_KEY`/`NEON_PROJECT_ID` are
 *  set (#7653), and the real Cloudflare Containers driver when `containerBindings` is given (#7851). Takes
 *  `env` as a plain parameter (defaulting to `process.env`) rather than reading it internally, matching this
 *  package's existing `ProvisioningPagerDutyOptions.env` seam so callers can inject a fake env in tests
 *  without any real environment-variable mutation. `containerBindings` is a SEPARATE parameter rather than
 *  folded into `env`: real Durable Object namespace bindings are live objects only available inside a
 *  Workers runtime, not string env vars -- worker.ts passes them explicitly. */
export function createTenantProvisioningDriver(
  env: Record<string, string | undefined> = process.env,
  containerBindings?: ContainerDriverConfig["bindings"],
): TenantProvisioningDriver {
  let driver: TenantProvisioningDriver = createFakeTenantProvisioningDriver();

  const apiKey = nonBlank(env.NEON_API_KEY);
  const projectId = nonBlank(env.NEON_PROJECT_ID);
  if (apiKey && projectId) {
    const config: NeonDatabaseDriverConfig = { apiKey, projectId };
    driver = withRealDatabaseDriver(driver, createNeonDatabaseDriver(config));
  }

  if (containerBindings && Object.keys(containerBindings).length > 0) {
    driver = withRealContainerDriver(driver, createContainerDriver({ bindings: containerBindings }));
  }

  return driver;
}
