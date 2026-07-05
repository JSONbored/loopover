// Redis-backed request-dedup cache for self-host (#1216). Prevents duplicate GitHub webhook
// deliveries from being processed twice — GitHub retries webhooks that receive a non-200
// response, and each retry carries the same `x-github-delivery` UUID. By caching the delivery
// ID after a successful processing attempt, the server can return 204 immediately on retries
// without re-queuing the job. The self-host review runtime requires REDIS_URL.
import type { Redis } from "ioredis";

export function createRedisCache(redis: Redis) {
  return {
    async get(key: string): Promise<string | null> {
      return redis.get(key);
    },
    async set(key: string, value: string, ttlSeconds: number): Promise<void> {
      await redis.set(key, value, "EX", ttlSeconds);
    },
    async del(key: string): Promise<void> {
      await redis.del(key);
    },
    // Redis performs the existence check and the write as a single atomic command server-side (SET ... NX), so
    // two concurrent callers racing on the same key can never both receive "OK" -- unlike a get-then-set pair,
    // which has a window between the read and the write where both callers can observe an absent key.
    async claim(key: string, value: string, ttlSeconds: number): Promise<boolean> {
      const result = await redis.set(key, value, "EX", ttlSeconds, "NX");
      return result === "OK";
    },
    // Compare-and-delete: the read and the delete must be one atomic server-side step (a Lua eval), or a
    // holder's own release could race a NEW claimant's write between a separate GET and DEL and delete the
    // wrong holder's key -- the exact race per-holder ownership tokens exist to close.
    async releaseIfValue(key: string, value: string): Promise<boolean> {
      const result = await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        value,
      );
      return result === 1;
    },
  };
}

/** Self-host boot guard: `claim()` without ownership-aware release pins actuation locks for minutes. */
export function assertSelfhostTransientCacheOwnershipRelease(
  cache: { claim?(key: string, value: string, ttlSeconds: number): Promise<boolean>; releaseIfValue?(key: string, value: string): Promise<boolean> },
): void {
  if (cache.claim && !cache.releaseIfValue) {
    throw new Error(
      "SELFHOST_TRANSIENT_CACHE.claim requires releaseIfValue for ownership-aware transient locks (#2129)",
    );
  }
}

export type RedisCache = ReturnType<typeof createRedisCache>;
