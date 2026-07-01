import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { checkAndMarkDelivery, createRedisCache } from "../../src/selfhost/redis-cache";

/** Minimal in-memory stand-in for the ioredis methods the cache uses. Emulates real Redis SET NX
 *  semantics (refuse + return null when NX is requested and the key already exists) so a test
 *  using this fake actually exercises the atomicity claim() depends on, not just a plain overwrite. */
function fakeRedis(): Redis & { _store: Map<string, string> } {
  const _store = new Map<string, string>();
  return {
    _store,
    async get(k: string) {
      return _store.get(k) ?? null;
    },
    async set(k: string, v: string, _ex: "EX", _ttl: number, nx?: "NX") {
      if (nx === "NX" && _store.has(k)) return null;
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

  it("claim atomically sets an absent key and returns true (#2129)", async () => {
    const cache = createRedisCache(fakeRedis());
    expect(await cache.claim("lock", "1", 60)).toBe(true);
    expect(await cache.get("lock")).toBe("1");
  });

  it("claim refuses and returns false when the key is already held, without overwriting it (#2129)", async () => {
    const r = fakeRedis();
    const cache = createRedisCache(r);
    await cache.set("lock", "holder-A", 60);
    expect(await cache.claim("lock", "holder-B", 60)).toBe(false);
    expect(await cache.get("lock")).toBe("holder-A"); // the second claimant never overwrote the first
  });

  it("claim propagates a Redis error to the caller (claimAgentMaintenanceLock is responsible for failing open)", async () => {
    const brokenRedis = { async set() { throw new Error("connection refused"); } } as unknown as Redis;
    const cache = createRedisCache(brokenRedis);
    await expect(cache.claim("lock", "1", 60)).rejects.toThrow("connection refused");
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
