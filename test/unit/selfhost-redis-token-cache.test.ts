import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { createRedisTokenCache } from "../../src/selfhost/redis-token-cache";

/** Minimal ioredis stand-in that records the TTL passed to set(). */
function fakeRedis(): {
  redis: Redis;
  store: Map<string, string>;
  ttl: () => number;
} {
  const store = new Map<string, string>();
  let lastTtl = -1;
  const redis = {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(k: string, v: string, _ex: "EX", ttl: number) {
      store.set(k, v);
      lastTtl = ttl;
      return "OK";
    },
  } as unknown as Redis;
  return { redis, store, ttl: () => lastTtl };
}

describe("createRedisTokenCache (#perf installation-token persistence)", () => {
  it("get returns null for a missing installation", async () => {
    const { redis } = fakeRedis();
    expect(await createRedisTokenCache(redis).get(42)).toBeNull();
  });

  it("set then get round-trips the token + expiry, with TTL ~ the token lifetime", async () => {
    const f = fakeRedis();
    const cache = createRedisTokenCache(f.redis);
    const expiresAtMs = Date.now() + 3_600_000;
    await cache.set(7, { token: "tok", expiresAtMs });
    expect(f.ttl()).toBeGreaterThan(3500); // ~3600s
    expect(f.ttl()).toBeLessThanOrEqual(3600);
    expect(await cache.get(7)).toEqual({ token: "tok", expiresAtMs });
  });

  it("floors the TTL at 1s for an already-near-expiry token", async () => {
    const f = fakeRedis();
    await createRedisTokenCache(f.redis).set(1, {
      token: "t",
      expiresAtMs: Date.now() - 5000,
    });
    expect(f.ttl()).toBe(1);
  });

  it("get returns null on malformed JSON", async () => {
    const f = fakeRedis();
    f.store.set("gh:insttoken:9", "{not json");
    expect(await createRedisTokenCache(f.redis).get(9)).toBeNull();
  });

  it("get returns null when the stored shape is wrong", async () => {
    const f = fakeRedis();
    f.store.set(
      "gh:insttoken:9",
      JSON.stringify({ token: 123, expiresAtMs: "soon" }),
    );
    expect(await createRedisTokenCache(f.redis).get(9)).toBeNull();
  });
});
