// Tests for the driver-factory composition/selection (#7653). No live Neon credentials -- `globalThis.fetch`
// is stubbed for the one test that exercises the real path end to end.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  createFakeTenantProvisioningDriver,
  createTenantProvisioningDriver,
  withRealContainerDriver,
  withRealDatabaseDriver,
  withRealSecretDriver,
  type ContainerDriver,
  type ContainerNamespaceLike,
  type ContainerStubLike,
  type DatabaseDriver,
  type SecretDriver,
  type TenantProvisioningRequest,
} from "../dist/index.js";

function fakeContainerNamespace(provisioned = false): ContainerNamespaceLike {
  let flag = provisioned;
  const stub: ContainerStubLike = {
    async start() {
      flag = true;
    },
    async stop() {
      flag = false;
    },
    async isProvisioned() {
      return flag;
    },
    async markProvisioned() {
      flag = true;
    },
    async markDeprovisioned() {
      flag = false;
    },
  };
  return { getByName: () => stub };
}

const REQUEST: TenantProvisioningRequest = { tenant: { name: "acme" }, product: "orb" };

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("withRealDatabaseDriver: overrides provisionDatabase/dropDatabase, forwards every other step to base", async () => {
  const base = createFakeTenantProvisioningDriver();
  const calls: string[] = [];
  const databaseDriver: DatabaseDriver = {
    provisionDatabase: async () => {
      calls.push("real-provision");
      return { host: "h", port: 5432, database: "d", user: "u", password: "p", connectionString: "postgres://u:p@h:5432/d" };
    },
    dropDatabase: async () => {
      calls.push("real-drop");
    },
  };

  const composed = withRealDatabaseDriver(base, databaseDriver);

  const details = await composed.provisionDatabase(REQUEST);
  assert.equal(details.host, "h");
  assert.deepEqual(calls, ["real-provision"]);
  // The fake's own provisionDatabase never ran -- its `databases` set stays empty even though the composed
  // driver's provisionDatabase resolved successfully.
  assert.equal(base.databases.has("orb:acme"), false);

  await composed.dropDatabase(REQUEST);
  assert.deepEqual(calls, ["real-provision", "real-drop"]);

  // Every non-database step still runs against `base` exactly as before composition.
  await composed.createContainer(REQUEST);
  assert.ok(base.containers.has("orb:acme"));
  assert.equal(await composed.containerExists(REQUEST), true);
  await composed.injectSecrets(REQUEST);
  assert.ok(base.injectedSecrets.has("orb:acme"));
  await composed.destroyContainer(REQUEST);
  assert.equal(base.containers.has("orb:acme"), false);
  await composed.revokeSecrets(REQUEST);
  assert.equal(base.injectedSecrets.has("orb:acme"), false);
});

test("withRealContainerDriver: overrides createContainer/destroyContainer/containerExists, forwards every other step to base", async () => {
  const base = createFakeTenantProvisioningDriver();
  const calls: string[] = [];
  const containerDriver: ContainerDriver = {
    createContainer: async () => {
      calls.push("real-create");
    },
    destroyContainer: async () => {
      calls.push("real-destroy");
    },
    containerExists: async () => {
      calls.push("real-exists");
      return true;
    },
  };

  const composed = withRealContainerDriver(base, containerDriver);

  await composed.createContainer(REQUEST);
  assert.equal(await composed.containerExists(REQUEST), true);
  await composed.destroyContainer(REQUEST);
  assert.deepEqual(calls, ["real-create", "real-exists", "real-destroy"]);
  // The fake's own createContainer never ran -- its `containers` set stays empty even though the composed
  // driver's own lifecycle calls all resolved successfully.
  assert.equal(base.containers.has("orb:acme"), false);

  // Every non-container step still runs against `base` exactly as before composition.
  const details = await composed.provisionDatabase(REQUEST);
  assert.equal(details.host, "fake-acme.control-plane.invalid");
  await composed.injectSecrets(REQUEST);
  assert.ok(base.injectedSecrets.has("orb:acme"));
});

test("withRealSecretDriver: overrides injectSecrets/revokeSecrets, forwards every other step to base", async () => {
  const base = createFakeTenantProvisioningDriver();
  const calls: string[] = [];
  const secretDriver: SecretDriver = {
    injectSecrets: async () => {
      calls.push("real-inject");
      return { secretRef: "real-secret-ref" };
    },
    revokeSecrets: async () => {
      calls.push("real-revoke");
    },
  };

  const composed = withRealSecretDriver(base, secretDriver);

  const injected = await composed.injectSecrets(REQUEST);
  assert.deepEqual(injected, { secretRef: "real-secret-ref" });
  await composed.revokeSecrets({ ...REQUEST, secretRef: injected.secretRef });
  assert.deepEqual(calls, ["real-inject", "real-revoke"]);
  // The fake's own injectSecrets never ran -- its `injectedSecrets` set stays empty even though the composed
  // driver's own calls all resolved successfully.
  assert.equal(base.injectedSecrets.has("orb:acme"), false);

  // Every non-secret step still runs against `base` exactly as before composition.
  await composed.createContainer(REQUEST);
  assert.ok(base.containers.has("orb:acme"));
  const details = await composed.provisionDatabase(REQUEST);
  assert.equal(details.host, "fake-acme.control-plane.invalid");
});

test("createTenantProvisioningDriver: falls back to the fake container behavior when containerBindings is omitted or empty", async () => {
  const noBindings = createTenantProvisioningDriver({}, undefined);
  const emptyBindings = createTenantProvisioningDriver({}, {});

  await noBindings.createContainer(REQUEST);
  await emptyBindings.createContainer(REQUEST);

  // No real container driver was selected in either case -- calling into an unconfigured product on the
  // fake never throws (unlike the real container-driver.ts, which throws for an unconfigured product).
  assert.equal(await noBindings.containerExists(REQUEST), true);
  assert.equal(await emptyBindings.containerExists(REQUEST), true);
});

test("createTenantProvisioningDriver: selects the real container driver when containerBindings is given", async () => {
  const driver = createTenantProvisioningDriver({}, { orb: fakeContainerNamespace() });

  assert.equal(await driver.containerExists(REQUEST), false);
  await driver.createContainer(REQUEST);
  assert.equal(await driver.containerExists(REQUEST), true);
});

test("createTenantProvisioningDriver: composes both the real database driver AND the real container driver together", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ branches: [] }), { status: 200 })) as unknown as typeof fetch;

  const driver = createTenantProvisioningDriver({ NEON_API_KEY: "real-key", NEON_PROJECT_ID: "real-project" }, { orb: fakeContainerNamespace() });

  // Real container path selected...
  await driver.createContainer(REQUEST);
  assert.equal(await driver.containerExists(REQUEST), true);
  // ...and the real database path too (rejects against the mocked, wrong-shaped Neon response, proving it's
  // not the fake's own always-succeeds provisionDatabase).
  await assert.rejects(driver.provisionDatabase(REQUEST));
});

test("createTenantProvisioningDriver: falls back to the plain fake when NEON_API_KEY is unset", async () => {
  const driver = createTenantProvisioningDriver({});

  const details = await driver.provisionDatabase(REQUEST);

  // The fake's own deterministic shape (tenant-provisioning-driver.test.ts asserts this same value) --
  // proves no real Neon path was selected.
  assert.equal(details.host, "fake-acme.control-plane.invalid");
});

test("createTenantProvisioningDriver: falls back to the fake when NEON_API_KEY is set but NEON_PROJECT_ID is missing", async () => {
  const driver = createTenantProvisioningDriver({ NEON_API_KEY: "key-only" });

  const details = await driver.provisionDatabase(REQUEST);

  assert.equal(details.host, "fake-acme.control-plane.invalid");
});

test("createTenantProvisioningDriver: falls back to the fake when NEON_PROJECT_ID is set but NEON_API_KEY is missing", async () => {
  const driver = createTenantProvisioningDriver({ NEON_PROJECT_ID: "proj-only" });

  const details = await driver.provisionDatabase(REQUEST);

  assert.equal(details.host, "fake-acme.control-plane.invalid");
});

test("createTenantProvisioningDriver: selects the real Neon-backed driver when both env vars are configured", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ branches: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const driver = createTenantProvisioningDriver({ NEON_API_KEY: "real-key", NEON_PROJECT_ID: "real-project" });

  // Only asserting that the REAL path was selected (it reaches out via fetch to Neon's API, unlike the fake) --
  // full provision/drop behavior against a real config is neon-database-driver.test.ts's job. The mocked
  // response's shape doesn't match a real branch-list response, so this necessarily rejects once the driver
  // gets past the "not found" check into a create call it can't complete against this stub.
  await assert.rejects(driver.provisionDatabase(REQUEST));
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((url) => url.includes("real-project")));
});

test("createTenantProvisioningDriver: falls back to the fake secret behavior when MAIN_APP_BASE_URL/INTERNAL_JOB_TOKEN are unset", async () => {
  const neither = createTenantProvisioningDriver({});
  const urlOnly = createTenantProvisioningDriver({ MAIN_APP_BASE_URL: "https://api.loopover.test" });
  const tokenOnly = createTenantProvisioningDriver({ INTERNAL_JOB_TOKEN: "internal-test-token" });

  // The fake's own injectSecrets never calls fetch -- if the real secret driver were selected in any of these,
  // this would attempt a real network call and reject instead of resolving.
  await neither.injectSecrets(REQUEST);
  await urlOnly.injectSecrets(REQUEST);
  await tokenOnly.injectSecrets(REQUEST);
});

test("createTenantProvisioningDriver: selects the real secret driver when both MAIN_APP_BASE_URL and INTERNAL_JOB_TOKEN are configured", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ enrollId: "orbenr_abc", secret: "orbsec_xyz" }), { status: 200 });
  }) as unknown as typeof fetch;

  const driver = createTenantProvisioningDriver({ MAIN_APP_BASE_URL: "https://api.loopover.test", INTERNAL_JOB_TOKEN: "internal-test-token" });

  const result = await driver.injectSecrets({ ...REQUEST, database: { host: "h", port: 5432, database: "d", user: "u", password: "p", connectionString: "postgres://u:p@h:5432/d" } });
  assert.deepEqual(result, { secretRef: "orbenr_abc", bootstrapSecret: "orbsec_xyz" });
  assert.ok(calls.some((url) => url.includes("api.loopover.test")));
});

test("createTenantProvisioningDriver: composes the real database, container, AND secret drivers all together", async () => {
  globalThis.fetch = (async (url: string) => {
    if (url.includes("api.loopover.test")) return new Response(JSON.stringify({ enrollId: "orbenr_abc", secret: "orbsec_xyz" }), { status: 200 });
    return new Response(JSON.stringify({ branches: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const driver = createTenantProvisioningDriver(
    { NEON_API_KEY: "real-key", NEON_PROJECT_ID: "real-project", MAIN_APP_BASE_URL: "https://api.loopover.test", INTERNAL_JOB_TOKEN: "internal-test-token" },
    { orb: fakeContainerNamespace() },
  );

  await driver.createContainer(REQUEST);
  assert.equal(await driver.containerExists(REQUEST), true);
  await assert.rejects(driver.provisionDatabase(REQUEST));
  const injected = await driver.injectSecrets({ ...REQUEST, database: { host: "h", port: 5432, database: "d", user: "u", password: "p", connectionString: "postgres://u:p@h:5432/d" } });
  assert.deepEqual(injected, { secretRef: "orbenr_abc", bootstrapSecret: "orbsec_xyz" });
});

test("createTenantProvisioningDriver: defaults env to process.env when no override is passed", async () => {
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, "NEON_API_KEY");
  const previousKey = process.env.NEON_API_KEY;
  delete process.env.NEON_API_KEY;

  try {
    const driver = createTenantProvisioningDriver();
    const details = await driver.provisionDatabase(REQUEST);
    assert.equal(details.host, "fake-acme.control-plane.invalid");
  } finally {
    if (hadKey) process.env.NEON_API_KEY = previousKey;
  }
});
