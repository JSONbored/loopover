import type { Redis } from "ioredis";
import { describe, expect, it, afterEach } from "vitest";
import {
  assertSelfhostTransientCacheOwnershipRelease,
  createRedisCache,
  isWebhookDeliveryDuplicate,
  rememberWebhookDelivery,
  webhookDeliveryCacheKey,
} from "../../src/selfhost/redis-cache";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";

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
    // Emulates the Lua eval releaseIfValue runs: delete k only when its stored value equals the expected arg.
    async eval(_script: string, _numkeys: number, k: string, expected: string) {
      if (_store.get(k) !== expected) return 0;
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

  it("releaseIfValue deletes the key only when the stored value matches the caller's own token (#2129)", async () => {
    const r = fakeRedis();
    const cache = createRedisCache(r);
    await cache.set("lock", "holder-a", 60);
    // A stale/different holder's token does not match — the live key is left untouched.
    expect(await cache.releaseIfValue("lock", "holder-b")).toBe(false);
    expect(await cache.get("lock")).toBe("holder-a");
    // The genuine owner's token matches — the key is removed.
    expect(await cache.releaseIfValue("lock", "holder-a")).toBe(true);
    expect(await cache.get("lock")).toBeNull();
  });

  it("releaseIfValue propagates a Redis error to the caller (releaseTransientLockIfOwner treats this as best-effort)", async () => {
    const brokenRedis = { async eval() { throw new Error("connection refused"); } } as unknown as Redis;
    const cache = createRedisCache(brokenRedis);
    await expect(cache.releaseIfValue("lock", "1")).rejects.toThrow("connection refused");
  });

  it("assertSelfhostTransientCacheOwnershipRelease rejects claim() without releaseIfValue at boot (#3153)", () => {
    expect(() =>
      assertSelfhostTransientCacheOwnershipRelease({
        claim: async () => true,
      }),
    ).toThrow(/releaseIfValue/);
    expect(() => assertSelfhostTransientCacheOwnershipRelease(createRedisCache(fakeRedis()))).not.toThrow();
  });
});

describe("isWebhookDeliveryDuplicate (#2075)", () => {
  afterEach(() => resetMetrics());

  it("returns false and does not increment on a first-time delivery", async () => {
    const cache = createRedisCache(fakeRedis());
    await expect(isWebhookDeliveryDuplicate(cache, "delivery-1")).resolves.toBe(false);
    expect(await renderMetrics()).not.toContain('gittensory_webhook_dedup_total{backend="redis"}');
  });

  it("returns true and increments gittensory_webhook_dedup_total{backend=\"redis\"} when already seen", async () => {
    const cache = createRedisCache(fakeRedis());
    await cache.set(webhookDeliveryCacheKey("delivery-2"), "1", 300);
    await expect(isWebhookDeliveryDuplicate(cache, "delivery-2")).resolves.toBe(true);
    expect(await renderMetrics()).toContain('gittensory_webhook_dedup_total{backend="redis"} 1');
  });

  it("returns false without incrementing when Redis get throws", async () => {
    const brokenRedis = { async get() { throw new Error("connection refused"); } } as unknown as Redis;
    const cache = createRedisCache(brokenRedis);
    await expect(isWebhookDeliveryDuplicate(cache, "delivery-3")).resolves.toBe(false);
    expect(await renderMetrics()).not.toContain('gittensory_webhook_dedup_total{backend="redis"}');
  });

  it("rememberWebhookDelivery stores the delivery key for later dedup", async () => {
    const cache = createRedisCache(fakeRedis());
    await rememberWebhookDelivery(cache, "delivery-4");
    expect(await cache.get(webhookDeliveryCacheKey("delivery-4"))).toBe("1");
  });
});
