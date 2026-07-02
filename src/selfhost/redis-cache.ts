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
  };
}

export type RedisCache = ReturnType<typeof createRedisCache>;
