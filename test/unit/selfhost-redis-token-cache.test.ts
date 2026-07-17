import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { createRedisTokenCache } from "../../src/selfhost/redis-token-cache";

/** Minimal ioredis stand-in that records the TTL passed to set(). */
function fakeRedis(options: { getThrows?: boolean; setThrows?: boolean } = {}): {
  redis: Redis;
  store: Map<string, string>;
  ttl: () => number;
} {
  const store = new Map<string, string>();
  let lastTtl = -1;
  const redis = {
    async get(k: string) {
      if (options.getThrows) throw new Error("connection refused");
      return store.get(k) ?? null;
    },
    async set(k: string, v: string, _ex: "EX", ttl: number) {
      if (options.setThrows) throw new Error("connection refused");
      store.set(k, v);
      lastTtl = ttl;
      return "OK";
    },
  } as unknown as Redis;
  return { redis, store, ttl: () => lastTtl };
}

afterEach(() => resetMetrics());

describe("createRedisTokenCache (#perf installation-token persistence)", () => {
  it("get returns null for a missing installation", async () => {
    const { redis } = fakeRedis();
    expect(await createRedisTokenCache(redis).get(42)).toBeNull();

    expect(await renderMetrics()).toContain(
      'loopover_redis_token_cache_total{result="miss"} 1',
    );
  });

  it("set then get round-trips the token + expiry, with TTL ~ the token lifetime", async () => {
    const f = fakeRedis();
    const cache = createRedisTokenCache(f.redis);
    const expiresAtMs = Date.now() + 3_600_000;
    await cache.set(7, { token: "sensitive-value", expiresAtMs });
    expect(f.ttl()).toBeGreaterThan(3500); // ~3600s
    expect(f.ttl()).toBeLessThanOrEqual(3600);
    expect(await cache.get(7)).toEqual({ token: "sensitive-value", expiresAtMs });

    const metrics = await renderMetrics();
    expect(metrics).toContain(
      'loopover_redis_token_cache_total{result="hit"} 1',
    );
    expect(metrics).not.toContain("sensitive-value");
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

    expect(await renderMetrics()).toContain(
      'loopover_redis_token_cache_total{result="miss"} 1',
    );
  });

  it("get returns null when the cached token is not a string", async () => {
    const f = fakeRedis();
    f.store.set(
      "gh:insttoken:9",
      JSON.stringify({ token: 123, expiresAtMs: Date.now() + 60_000 }),
    );
    expect(await createRedisTokenCache(f.redis).get(9)).toBeNull();

    expect(await renderMetrics()).toContain(
      'loopover_redis_token_cache_total{result="miss"} 1',
    );
  });

  it("get returns null when the cached expiry is not a number", async () => {
    const f = fakeRedis();
    f.store.set(
      "gh:insttoken:9",
      JSON.stringify({ token: "sensitive-value", expiresAtMs: "soon" }),
    );
    expect(await createRedisTokenCache(f.redis).get(9)).toBeNull();

    expect(await renderMetrics()).toContain(
      'loopover_redis_token_cache_total{result="miss"} 1',
    );
  });

  it("regression: fails open (returns null) and records an error metric on a Redis connection failure (#6288)", async () => {
    // Unlike a cache miss/malformed value, a connection failure must never throw uncaught here: the caller
    // (github/app.ts's readCachedToken -> createInstallationToken) has no try/catch of its own, so an uncaught
    // rejection would hard-fail GitHub App token minting on every Redis hiccup instead of costing one extra
    // real mint. This must still be observable, unlike redis-cache.ts's silent fail-open.
    const { redis } = fakeRedis({ getThrows: true });
    await expect(createRedisTokenCache(redis).get(9)).resolves.toBeNull();

    expect(await renderMetrics()).toContain(
      'loopover_redis_token_cache_total{result="error"} 1',
    );
  });

  it("regression: set() fails open (does not throw) and records an error metric on a Redis connection failure (#6999)", async () => {
    // The token was already successfully minted from GitHub before set() is called (github/app.ts's
    // createInstallationToken has no try/catch around this write), so a transient cache-write failure must
    // never surface as a token-mint failure -- same fail-open contract as get()'s own regression test above.
    const { redis, store } = fakeRedis({ setThrows: true });
    await expect(
      createRedisTokenCache(redis).set(9, { token: "sensitive-value", expiresAtMs: Date.now() + 60_000 }),
    ).resolves.toBeUndefined();

    expect(store.has("gh:insttoken:9")).toBe(false); // the write never actually landed
    const metrics = await renderMetrics();
    expect(metrics).toContain('loopover_redis_token_cache_total{result="error"} 1');
    expect(metrics).not.toContain("sensitive-value");
  });
});
