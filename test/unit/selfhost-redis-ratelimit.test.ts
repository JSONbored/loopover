import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { createRedisRateLimiter } from "../../src/selfhost/redis-ratelimit";

/** Minimal in-memory stand-in for the ioredis methods the limiter uses. */
function fakeRedis(): Redis {
  const store = new Map<string, number>();
  return {
    async incr(k: string) {
      const v = (store.get(k) ?? 0) + 1;
      store.set(k, v);
      return v;
    },
    async expire() {
      return 1;
    },
    async pttl() {
      return 30_000;
    },
  } as unknown as Redis;
}

describe("createRedisRateLimiter (#977)", () => {
  it("allows up to the limit then 429s, exposing a decision", async () => {
    const ns = createRedisRateLimiter(fakeRedis());
    const stub = ns.get(ns.idFromName("k"));
    const hit = () => stub.fetch("https://rl/check", { method: "POST", body: JSON.stringify({ key: "k", limit: 2, windowSeconds: 60 }) });

    let res = await hit();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { remaining: number }).remaining).toBe(1);
    res = await hit();
    expect(res.status).toBe(200); // count 2 == limit → still allowed
    res = await hit();
    expect(res.status).toBe(429); // count 3 > limit → blocked
    const blocked = (await res.json()) as { allowed: boolean; retryAfterSeconds: number };
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("400s on a malformed request", async () => {
    const ns = createRedisRateLimiter(fakeRedis());
    const res = await ns.get(ns.idFromName("k")).fetch("https://rl/check", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it("accepts a Request object and handles a missing TTL", async () => {
    const noTtl = {
      async incr() {
        return 1;
      },
      async expire() {
        return 1;
      },
      async pttl() {
        return -1; // no expiry set → resetMs falls back to windowSeconds
      },
    } as unknown as Redis;
    const ns = createRedisRateLimiter(noTtl);
    const req = new Request("https://rl/check", { method: "POST", body: JSON.stringify({ key: "k", limit: 5, windowSeconds: 60 }) });
    const res = await ns.get(ns.idFromName("k")).fetch(req); // pass a Request (not url+init)
    expect(res.status).toBe(200);
  });
});
