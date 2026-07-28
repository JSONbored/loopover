import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { createRedisRateLimiter } from "../../src/selfhost/redis-ratelimit";

/**
 * Minimal in-memory stand-in for the ioredis surface the limiter uses. Since #9493 the limiter drives a single
 * Lua script rather than INCR + conditional EXPIRE, so this models the two pieces of state the script actually
 * reads and writes: the counter and its TTL (-1 for "exists, no TTL", which is the stuck-key shape the script
 * repairs). `seedNoTtl` lets a test construct a key stranded by the OLD code path.
 */
function fakeRedis(seed?: { key: string; count: number; ttlMs: number }): Redis {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  if (seed) {
    counts.set(seed.key, seed.count);
    ttls.set(seed.key, seed.ttlMs);
  }
  return {
    // Mirrors INCREMENT_WINDOW_SCRIPT's semantics, including the ttl < 0 repair arm.
    async eval(_script: string, _numKeys: number, key: string, windowMs: string) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count === 1) ttls.set(key, Number(windowMs));
      let ttl = ttls.get(key) ?? -1;
      if (ttl < 0) {
        ttls.set(key, Number(windowMs));
        ttl = Number(windowMs);
      }
      return [count, ttl];
    },
    // Exposed only so assertions can inspect the resulting TTL state.
    async pttl(k: string) {
      return ttls.get(k) ?? -2;
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

  it("accepts a Request object and handles a non-numeric TTL reply defensively", async () => {
    // The script guarantees a positive TTL, but a transport/serialization change that yields a non-numeric
    // reply must still produce a sane resetAt rather than NaN -- that fallback arm stays covered.
    const oddReply = {
      async eval() {
        return [1, "not-a-number"];
      },
    } as unknown as Redis;
    const ns = createRedisRateLimiter(oddReply);
    const req = new Request("https://rl/check", { method: "POST", body: JSON.stringify({ key: "k", limit: 5, windowSeconds: 60 }) });
    const res = await ns.get(ns.idFromName("k")).fetch(req); // pass a Request (not url+init)
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resetAt: string };
    expect(Number.isNaN(Date.parse(body.resetAt))).toBe(false);
  });

  // #9493 regression: INCR then a conditional EXPIRE is two round trips. A death, dropped connection, or an
  // EXPIRE that merely errored between them left the key with NO TTL, so the fixed window never reset: the
  // counter climbed forever and, once past the limit, every request on that key was denied until someone
  // deleted it by hand. The worst key is strict:/v1/github/webhook:installation:<id> -- a stuck key means every
  // webhook delivery for that installation 429s indefinitely, and GitHub does not auto-redeliver.
  it("#9493 sets the window TTL atomically with the first increment", async () => {
    const redis = fakeRedis();
    const ns = createRedisRateLimiter(redis);
    await ns.get(ns.idFromName("k")).fetch("https://rl/check", { method: "POST", body: JSON.stringify({ key: "k", limit: 5, windowSeconds: 60 }) });
    // A TTL exists immediately after the very first hit -- there is no window in which the key is immortal.
    expect(await redis.pttl("ratelimit:k")).toBe(60_000);
  });

  it("#9493 repairs a key that already has no TTL instead of leaving it immortal", async () => {
    // A key stranded by the OLD code path: a live counter, already over the limit, with no expiry.
    const redis = fakeRedis({ key: "ratelimit:stuck", count: 999, ttlMs: -1 });
    const ns = createRedisRateLimiter(redis);
    const res = await ns
      .get(ns.idFromName("stuck"))
      .fetch("https://rl/check", { method: "POST", body: JSON.stringify({ key: "stuck", limit: 5, windowSeconds: 60 }) });

    // Still denied on this request (the counter is genuinely over the limit) ...
    expect(res.status).toBe(429);
    // ... but the key now expires, so the bucket recovers on its own rather than needing manual deletion.
    expect(await redis.pttl("ratelimit:stuck")).toBe(60_000);
    const body = (await res.json()) as { retryAfterSeconds: number };
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});
