import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { createRedisResponseCache } from "../../src/selfhost/redis-response-cache";

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

const URL_A = "https://api.github.com/repos/o/r/pulls/1";

describe("createRedisResponseCache (#perf GitHub GET cache)", () => {
  it("get returns null for a missing url", async () => {
    expect(
      await createRedisResponseCache(fakeRedis().redis, 20).get(URL_A),
    ).toBeNull();
  });

  it("set then get round-trips status/body/content-type with the configured TTL", async () => {
    const f = fakeRedis();
    const cache = createRedisResponseCache(f.redis, 30);
    await cache.set(URL_A, {
      status: 200,
      body: '{"x":1}',
      contentType: "application/json",
    });
    expect(f.ttl()).toBe(30);
    expect(await cache.get(URL_A)).toEqual({
      status: 200,
      body: '{"x":1}',
      contentType: "application/json",
    });
  });

  it("floors the TTL at 1s", async () => {
    const f = fakeRedis();
    await createRedisResponseCache(f.redis, 0).set(URL_A, {
      status: 200,
      body: "{}",
      contentType: "application/json",
    });
    expect(f.ttl()).toBe(1);
  });

  it("get returns null on malformed JSON", async () => {
    const f = fakeRedis();
    f.store.set("gh:resp:" + URL_A, "{nope");
    expect(await createRedisResponseCache(f.redis, 20).get(URL_A)).toBeNull();
  });

  it("get returns null when the stored shape is wrong", async () => {
    const f = fakeRedis();
    f.store.set("gh:resp:" + URL_A, JSON.stringify({ status: "200", body: 1 }));
    expect(await createRedisResponseCache(f.redis, 20).get(URL_A)).toBeNull();
  });
});
