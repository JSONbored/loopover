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

function recordFor(name: string, state: TenantRegistryRecord["state"] = "active"): TenantRegistryRecord {
  return { tenant: { name }, product: "orb", state, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

test("createFakeTenantRegistry: upsert/get/list round-trip, sorted by tenant name", async () => {
  const registry = createFakeTenantRegistry();

  await registry.upsert(recordFor("zebra"));
  await registry.upsert(recordFor("acme"));

  assert.deepEqual(await registry.get("acme"), recordFor("acme"));
  assert.equal(await registry.get("ghost"), undefined);
  assert.deepEqual(
    (await registry.list()).map((record) => record.tenant.name),
    ["acme", "zebra"],
  );
});

test("createFakeTenantRegistry: upsert overwrites an existing record for the same tenant", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert(recordFor("acme", "active"));

  await registry.upsert(recordFor("acme", "torn down"));

  assert.equal((await registry.get("acme"))?.state, "torn down");
  assert.equal((await registry.list()).length, 1);
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

test("createKvTenantRegistry: upsert writes a JSON-encoded value under the tenant: prefix", async () => {
  const kv = fakeKv();
  const registry = createKvTenantRegistry(kv);

  await registry.upsert(recordFor("acme"));

  assert.equal(kv.store.get("tenant:acme"), JSON.stringify(recordFor("acme")));
});

test("createKvTenantRegistry: get returns undefined for a key that was never written", async () => {
  const registry = createKvTenantRegistry(fakeKv());

  assert.equal(await registry.get("ghost"), undefined);
});

test("createKvTenantRegistry: get parses a previously written record back", async () => {
  const kv = fakeKv({ "tenant:acme": JSON.stringify(recordFor("acme")) });
  const registry = createKvTenantRegistry(kv);

  assert.deepEqual(await registry.get("acme"), recordFor("acme"));
});

test("createKvTenantRegistry: list pages through multiple KV list() pages and returns every record, sorted", async () => {
  const kv = fakeKv({
    "tenant:charlie": JSON.stringify(recordFor("charlie")),
    "tenant:alpha": JSON.stringify(recordFor("alpha")),
    "tenant:bravo": JSON.stringify(recordFor("bravo")),
  });
  const registry = createKvTenantRegistry(kv);

  const records = await registry.list();

  assert.deepEqual(
    records.map((record) => record.tenant.name),
    ["alpha", "bravo", "charlie"],
  );
});

test("createKvTenantRegistry: list tolerates a key disappearing between the list() page and the get() read", async () => {
  const kv = fakeKv({ "tenant:acme": JSON.stringify(recordFor("acme")) });
  const originalGet = kv.get.bind(kv);
  kv.get = async (key: string) => {
    // Simulate a concurrent delete: the key was listed, but its value is gone by the time we read it.
    if (key === "tenant:acme") return null;
    return originalGet(key);
  };
  const registry = createKvTenantRegistry(kv);

  assert.deepEqual(await registry.list(), []);
});
