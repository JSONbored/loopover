// Tests for the tenant registry (#7654): the in-memory fake, and the real KV-backed implementation against a
// small hand-rolled fake KvNamespaceLike (no real Cloudflare KV anywhere in this test suite).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFakeTenantRegistry,
  createKvTenantRegistry,
  type KvNamespaceLike,
  type TenantRegistryRecord,
} from "../dist/index.js";

function recordFor(
  name: string,
  product: TenantRegistryRecord["product"] = "orb",
  state: TenantRegistryRecord["state"] = "active",
): TenantRegistryRecord {
  return { tenant: { name }, product, state, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

test("createFakeTenantRegistry: upsert/get/list round-trip, sorted by tenant name then product", async () => {
  const registry = createFakeTenantRegistry();

  await registry.upsert(recordFor("zebra"));
  await registry.upsert(recordFor("acme"));

  assert.deepEqual(await registry.get("acme", "orb"), recordFor("acme"));
  assert.equal(await registry.get("ghost", "orb"), undefined);
  assert.deepEqual(
    (await registry.list()).map((record) => record.tenant.name),
    ["acme", "zebra"],
  );
});

test("createFakeTenantRegistry: upsert overwrites an existing record for the same product+tenant", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert(recordFor("acme", "orb", "active"));

  await registry.upsert(recordFor("acme", "orb", "torn down"));

  assert.equal((await registry.get("acme", "orb"))?.state, "torn down");
  assert.equal((await registry.list()).length, 1);
});

// Mirrors container-driver.test.ts's product-scoped instance key — same name across products must not share
// one registry row on a single shared registry (production's HTTP composition shape; #8024).
test("createFakeTenantRegistry: state is product-scoped (${product}:${name}), not just the tenant name", async () => {
  const registry = createFakeTenantRegistry();

  await registry.upsert(recordFor("acme", "orb", "active"));
  await registry.upsert(recordFor("acme", "ams", "active"));

  assert.equal((await registry.get("acme", "orb"))?.product, "orb");
  assert.equal((await registry.get("acme", "ams"))?.product, "ams");
  assert.equal((await registry.list()).length, 2);

  await registry.upsert(recordFor("acme", "orb", "torn down"));

  assert.equal((await registry.get("acme", "orb"))?.state, "torn down");
  assert.equal((await registry.get("acme", "ams"))?.state, "active");
});

test("createFakeTenantRegistry: getByOrbInstallationId finds a tenant by installation ID, undefined for an unclaimed one", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ ...recordFor("acme"), orbInstallationId: 555 });
  await registry.upsert(recordFor("beta"));

  assert.equal((await registry.getByOrbInstallationId(555))?.tenant.name, "acme");
  assert.equal(await registry.getByOrbInstallationId(999), undefined);
});

function fakeKv(initial: Record<string, string> = {}): KvNamespaceLike & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "", cursor } = {}) {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
      const pageSize = 2;
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + pageSize);
      const nextStart = start + pageSize;
      const listComplete = nextStart >= keys.length;
      return { keys: page.map((name) => ({ name })), list_complete: listComplete, ...(listComplete ? {} : { cursor: String(nextStart) }) };
    },
  };
}

test("createKvTenantRegistry: upsert writes a JSON-encoded value under tenant:${product}:${name}", async () => {
  const kv = fakeKv();
  const registry = createKvTenantRegistry(kv);

  await registry.upsert(recordFor("acme"));

  assert.equal(kv.store.get("tenant:orb:acme"), JSON.stringify(recordFor("acme")));
});

test("createKvTenantRegistry: get returns undefined for a key that was never written", async () => {
  const registry = createKvTenantRegistry(fakeKv());

  assert.equal(await registry.get("ghost", "orb"), undefined);
});

test("createKvTenantRegistry: get parses a previously written record back", async () => {
  const kv = fakeKv({ "tenant:orb:acme": JSON.stringify(recordFor("acme")) });
  const registry = createKvTenantRegistry(kv);

  assert.deepEqual(await registry.get("acme", "orb"), recordFor("acme"));
});

test("createKvTenantRegistry: list pages through multiple KV list() pages and returns every record, sorted", async () => {
  const kv = fakeKv({
    "tenant:orb:charlie": JSON.stringify(recordFor("charlie")),
    "tenant:orb:alpha": JSON.stringify(recordFor("alpha")),
    "tenant:orb:bravo": JSON.stringify(recordFor("bravo")),
  });
  const registry = createKvTenantRegistry(kv);

  const records = await registry.list();

  assert.deepEqual(
    records.map((record) => record.tenant.name),
    ["alpha", "bravo", "charlie"],
  );
});

test("createKvTenantRegistry: list returns both products when the same tenant name is registered twice", async () => {
  const kv = fakeKv({
    "tenant:orb:acme": JSON.stringify(recordFor("acme", "orb")),
    "tenant:ams:acme": JSON.stringify(recordFor("acme", "ams")),
  });
  const registry = createKvTenantRegistry(kv);

  const records = await registry.list();

  assert.deepEqual(
    records.map((record) => [record.tenant.name, record.product]),
    [
      ["acme", "ams"],
      ["acme", "orb"],
    ],
  );
});

test("createKvTenantRegistry: list tolerates a key disappearing between the list() page and the get() read", async () => {
  const kv = fakeKv({ "tenant:orb:acme": JSON.stringify(recordFor("acme")) });
  const originalGet = kv.get.bind(kv);
  kv.get = async (key: string) => {
    // Simulate a concurrent delete: the key was listed, but its value is gone by the time we read it.
    if (key === "tenant:orb:acme") return null;
    return originalGet(key);
  };
  const registry = createKvTenantRegistry(kv);

  assert.deepEqual(await registry.list(), []);
});

test("a tenant's pinnedVersion (#4898) survives the KV JSON round-trip, and its absence stays absent", async () => {
  const kv = fakeKv();
  const registry = createKvTenantRegistry(kv);

  await registry.upsert({ ...recordFor("acme"), tenant: { name: "acme", pinnedVersion: "v1.4.2" } });
  await registry.upsert(recordFor("beta"));

  assert.deepEqual((await registry.get("acme", "orb"))?.tenant, { name: "acme", pinnedVersion: "v1.4.2" });
  // A pre-#4898 record (no pinnedVersion key at all) reads back exactly as stored — unpinned.
  assert.deepEqual((await registry.get("beta", "orb"))?.tenant, { name: "beta" });
});

test("createKvTenantRegistry: getByOrbInstallationId resolves through the installation:${id} secondary index (#7181)", async () => {
  const kv = fakeKv();
  const registry = createKvTenantRegistry(kv);

  await registry.upsert({ ...recordFor("acme"), orbInstallationId: 555 });

  assert.equal(kv.store.get("installation:555"), "tenant:orb:acme");
  assert.equal((await registry.getByOrbInstallationId(555))?.tenant.name, "acme");
});

test("createKvTenantRegistry: getByOrbInstallationId returns undefined for an installation ID nothing claims", async () => {
  const registry = createKvTenantRegistry(fakeKv());

  assert.equal(await registry.getByOrbInstallationId(999), undefined);
});

test("createKvTenantRegistry: re-linking a tenant to a different installation ID clears the stale index entry", async () => {
  const kv = fakeKv();
  const registry = createKvTenantRegistry(kv);
  await registry.upsert({ ...recordFor("acme"), orbInstallationId: 555 });

  await registry.upsert({ ...recordFor("acme"), orbInstallationId: 777 });

  assert.equal(kv.store.get("installation:555"), undefined);
  assert.equal(await registry.getByOrbInstallationId(555), undefined);
  assert.equal((await registry.getByOrbInstallationId(777))?.tenant.name, "acme");
});

test("createKvTenantRegistry: getByOrbInstallationId tolerates an index entry whose primary key has since disappeared", async () => {
  const kv = fakeKv({ "installation:555": "tenant:orb:acme" });

  const registry = createKvTenantRegistry(kv);

  assert.equal(await registry.getByOrbInstallationId(555), undefined);
});

test("createKvTenantRegistry: unlinking a tenant's installation ID (upsert without it) clears the stale index entry", async () => {
  const kv = fakeKv();
  const registry = createKvTenantRegistry(kv);
  await registry.upsert({ ...recordFor("acme"), orbInstallationId: 555 });

  await registry.upsert(recordFor("acme"));

  assert.equal(kv.store.get("installation:555"), undefined);
  assert.equal(await registry.getByOrbInstallationId(555), undefined);
});
