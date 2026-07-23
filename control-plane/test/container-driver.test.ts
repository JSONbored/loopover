// Tests for the real Cloudflare Containers driver (#7851). No live Cloudflare account or infrastructure
// anywhere here -- ContainerNamespaceLike/ContainerStubLike are hand-rolled fakes tracking their own calls,
// mirroring the fake-driver convention already used throughout this package.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createContainerDriver,
  createTenantContainer,
  destroyTenantContainer,
  PINNED_VERSION_ENV_VAR,
  TENANT_SECRET_ENV_VAR,
  tenantContainerExists,
  type ContainerDriverConfig,
  type ContainerNamespaceLike,
  type ContainerStubLike,
  type TenantProvisioningRequest,
} from "../dist/index.js";

type FakeContainerStub = ContainerStubLike & { calls: string[] };

function fakeContainerStub(initial: { provisioned?: boolean } = {}): FakeContainerStub {
  let provisioned = initial.provisioned ?? false;
  const calls: string[] = [];
  return {
    calls,
    async start() {
      calls.push("start");
    },
    async stop() {
      calls.push("stop");
    },
    async isProvisioned() {
      return provisioned;
    },
    async markProvisioned() {
      calls.push("markProvisioned");
      provisioned = true;
    },
    async markDeprovisioned() {
      calls.push("markDeprovisioned");
      provisioned = false;
    },
  };
}

function fakeNamespace(stub: FakeContainerStub): ContainerNamespaceLike & { requestedNames: string[] } {
  const requestedNames: string[] = [];
  return {
    requestedNames,
    getByName(name: string) {
      requestedNames.push(name);
      return stub;
    },
  };
}

const REQUEST: TenantProvisioningRequest = { tenant: { name: "acme" }, product: "orb" };

test("createTenantContainer starts a fresh (never-provisioned) container and marks it provisioned", async () => {
  const stub = fakeContainerStub();
  const namespace = fakeNamespace(stub);
  const config: ContainerDriverConfig = { bindings: { orb: namespace } };

  await createTenantContainer(config, REQUEST);

  assert.deepEqual(stub.calls, ["start", "markProvisioned"]);
  assert.equal(await stub.isProvisioned(), true);
});

test("createTenantContainer is idempotent: an already-provisioned tenant is never restarted", async () => {
  const stub = fakeContainerStub({ provisioned: true });
  const config: ContainerDriverConfig = { bindings: { orb: fakeNamespace(stub) } };

  await createTenantContainer(config, REQUEST);

  assert.deepEqual(stub.calls, []);
});

test("destroyTenantContainer stops a provisioned container and marks it deprovisioned", async () => {
  const stub = fakeContainerStub({ provisioned: true });
  const config: ContainerDriverConfig = { bindings: { orb: fakeNamespace(stub) } };

  await destroyTenantContainer(config, REQUEST);

  assert.deepEqual(stub.calls, ["stop", "markDeprovisioned"]);
  assert.equal(await stub.isProvisioned(), false);
});

test("destroyTenantContainer is idempotent: a never-provisioned tenant is never stopped", async () => {
  const stub = fakeContainerStub();
  const config: ContainerDriverConfig = { bindings: { orb: fakeNamespace(stub) } };

  await destroyTenantContainer(config, REQUEST);

  assert.deepEqual(stub.calls, []);
});

test("tenantContainerExists reflects the provisioned flag, not any run-state concept", async () => {
  const provisioned = fakeContainerStub({ provisioned: true });
  const notProvisioned = fakeContainerStub({ provisioned: false });

  assert.equal(await tenantContainerExists({ bindings: { orb: fakeNamespace(provisioned) } }, REQUEST), true);
  assert.equal(await tenantContainerExists({ bindings: { orb: fakeNamespace(notProvisioned) } }, REQUEST), false);
});

test("the instance key is product-scoped (${product}:${tenant.name}), not just the tenant name", async () => {
  const stub = fakeContainerStub();
  const namespace = fakeNamespace(stub);
  const config: ContainerDriverConfig = { bindings: { ams: namespace } };

  await createTenantContainer(config, { tenant: { name: "acme" }, product: "ams" });

  assert.deepEqual(namespace.requestedNames, ["ams:acme"]);
});

test("an unconfigured product throws a clear error rather than silently no-oping", async () => {
  const config: ContainerDriverConfig = { bindings: { orb: fakeNamespace(fakeContainerStub()) } };

  await assert.rejects(createTenantContainer(config, { tenant: { name: "acme" }, product: "ams" }), /no container binding configured for product "ams"/);
  await assert.rejects(destroyTenantContainer(config, { tenant: { name: "acme" }, product: "ams" }), /no container binding configured/);
  await assert.rejects(tenantContainerExists(config, { tenant: { name: "acme" }, product: "ams" }), /no container binding configured/);
});

test("createContainerDriver bundles all three functions closed over one config", async () => {
  const stub = fakeContainerStub();
  const driver = createContainerDriver({ bindings: { orb: fakeNamespace(stub) } });

  assert.equal(await driver.containerExists(REQUEST), false);
  await driver.createContainer(REQUEST);
  assert.equal(await driver.containerExists(REQUEST), true);
  await driver.destroyContainer(REQUEST);
  assert.equal(await driver.containerExists(REQUEST), false);
});

// #4898: a tenant's pinnedVersion rides into its container at (re)start as PINNED_VERSION_ENV_VAR — the only
// per-tenant versioning seam available when the image reference itself is fixed at the wrangler.jsonc binding
// level. The stub here captures start()'s options, which the package's shared fake deliberately doesn't.
type StartOptions = Parameters<ContainerStubLike["start"]>[0];

function optionCapturingStub(): ContainerStubLike & { startOptions: StartOptions[] } {
  let provisioned = false;
  const startOptions: StartOptions[] = [];
  return {
    startOptions,
    async start(options?: StartOptions) {
      startOptions.push(options);
    },
    async stop() {},
    async isProvisioned() {
      return provisioned;
    },
    async markProvisioned() {
      provisioned = true;
    },
    async markDeprovisioned() {
      provisioned = false;
    },
  };
}

function configFor(stub: ContainerStubLike): ContainerDriverConfig {
  return { bindings: { orb: { getByName: () => stub } } };
}

test("a pinned tenant's container starts with PINNED_VERSION_ENV_VAR carrying its own version (#4898)", async () => {
  const stub = optionCapturingStub();

  await createTenantContainer(configFor(stub), { tenant: { name: "acme", pinnedVersion: "v1.4.2" }, product: "orb" });

  assert.deepEqual(stub.startOptions, [{ envVars: { [PINNED_VERSION_ENV_VAR]: "v1.4.2" } }]);
});

test("an unpinned tenant's container start is byte-identical to the pre-#4898 call (no options at all)", async () => {
  for (const tenant of [{ name: "acme" }, { name: "acme", pinnedVersion: null }]) {
    const stub = optionCapturingStub();

    await createTenantContainer(configFor(stub), { tenant, product: "orb" });

    assert.deepEqual(stub.startOptions, [undefined]);
  }
});

test("a repeat create of an already-provisioned pinned tenant never restarts it (#4898 keeps the idempotence contract)", async () => {
  const stub = optionCapturingStub();
  await stub.markProvisioned();

  await createTenantContainer(configFor(stub), { tenant: { name: "acme", pinnedVersion: "v2.0.0" }, product: "orb" });

  assert.deepEqual(stub.startOptions, []);
});

// #8202: a tenant's one-time secret-bootstrap credential rides into its container at cold boot the same way
// pinnedVersion does above -- the only point in a container's lifecycle envVars are actually applied.
test("a tenant with a bootstrap secret starts with TENANT_SECRET_ENV_VAR carrying it", async () => {
  const stub = optionCapturingStub();

  await createTenantContainer(configFor(stub), { tenant: { name: "acme" }, product: "orb", bootstrapSecret: "orbsec_xyz" });

  assert.deepEqual(stub.startOptions, [{ envVars: { [TENANT_SECRET_ENV_VAR]: "orbsec_xyz" } }]);
});

test("a tenant with both a pinned version and a bootstrap secret starts with both env vars merged into one call", async () => {
  const stub = optionCapturingStub();

  await createTenantContainer(configFor(stub), { tenant: { name: "acme", pinnedVersion: "v1.4.2" }, product: "orb", bootstrapSecret: "orbsec_xyz" });

  assert.deepEqual(stub.startOptions, [{ envVars: { [PINNED_VERSION_ENV_VAR]: "v1.4.2", [TENANT_SECRET_ENV_VAR]: "orbsec_xyz" } }]);
});

test("a tenant with neither a pinned version nor a bootstrap secret still gets the exact pre-#4898 call (no options at all)", async () => {
  const stub = optionCapturingStub();

  await createTenantContainer(configFor(stub), { tenant: { name: "acme" }, product: "orb", bootstrapSecret: undefined });

  assert.deepEqual(stub.startOptions, [undefined]);
});

test("a repeat create of an already-provisioned tenant with a bootstrap secret never restarts it (idempotence contract holds here too)", async () => {
  const stub = optionCapturingStub();
  await stub.markProvisioned();

  await createTenantContainer(configFor(stub), { tenant: { name: "acme" }, product: "orb", bootstrapSecret: "orbsec_xyz" });

  assert.deepEqual(stub.startOptions, []);
});
