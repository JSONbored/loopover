// Tests for the real Cloudflare Containers driver (#7851). No live Cloudflare account or infrastructure
// anywhere here -- ContainerNamespaceLike/ContainerStubLike are hand-rolled fakes tracking their own calls,
// mirroring the fake-driver convention already used throughout this package.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createContainerDriver,
  createTenantContainer,
  destroyTenantContainer,
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
