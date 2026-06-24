import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { checkAndMarkDelivery, createRedisCache } from "../../src/selfhost/redis-cache";

/** Minimal in-memory stand-in for the ioredis methods the cache uses. */
function fakeRedis(): Redis & { _store: Map<string, string> } {
  const _store = new Map<string, string>();
  return {
    _store,
    async get(k: string) {
      return _store.get(k) ?? null;
    },
    async set(k: string, v: string, _ex: "EX", _ttl: number) {
      _store.set(k, v);
      return "OK";
    },
    async del(k: string) {
      _store.delete(k);
      return 1;
    },
  } as unknown as Redis & { _store: Map<string, string> };
}

describe("createRedisCache (#1216 webhook dedup cache)", () => {
  it("get returns null for a missing key", async () => {
    const cache = createRedisCache(fakeRedis());
    expect(await cache.get("missing")).toBeNull();
  });

  it("set then get returns the stored value", async () => {
    const cache = createRedisCache(fakeRedis());
    await cache.set("k", "hello", 60);
    expect(await cache.get("k")).toBe("hello");
  });

  it("del removes the key", async () => {
    const r = fakeRedis();
    const cache = createRedisCache(r);
    await cache.set("k", "v", 60);
    await cache.del("k");
    expect(await cache.get("k")).toBeNull();
  });
});

describe("checkAndMarkDelivery (#1216 webhook idempotency)", () => {
  it("returns false (first-time) for a new delivery ID and marks it as seen", async () => {
    const cache = createRedisCache(fakeRedis());
    const result = await checkAndMarkDelivery(cache, "delivery-abc", 300);
    expect(result).toBe(false);
    // second call with the same ID should be a duplicate
    const duplicate = await checkAndMarkDelivery(cache, "delivery-abc", 300);
    expect(duplicate).toBe(true);
  });

  it("returns true (duplicate) for an already-seen delivery ID", async () => {
    const r = fakeRedis();
    r._store.set("delivery:existing-id", "1");
    const cache = createRedisCache(r);
    expect(await checkAndMarkDelivery(cache, "existing-id")).toBe(true);
  });

  it("different delivery IDs are tracked independently", async () => {
    const cache = createRedisCache(fakeRedis());
    expect(await checkAndMarkDelivery(cache, "id-A")).toBe(false);
    expect(await checkAndMarkDelivery(cache, "id-B")).toBe(false); // different ID → first-time
    expect(await checkAndMarkDelivery(cache, "id-A")).toBe(true);  // id-A seen before
  });

  it("swallows Redis errors and returns false (never blocks processing)", async () => {
    const brokenRedis = {
      async get() { throw new Error("connection refused"); },
      async set() { throw new Error("connection refused"); },
    } as unknown as Redis;
    const cache = createRedisCache(brokenRedis);
    // Must not throw — error is swallowed, returns false (first-time / let it through)
    expect(await checkAndMarkDelivery(cache, "any-id")).toBe(false);
  });
});
