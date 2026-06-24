// Redis-backed request-dedup cache for self-host (#1216). Prevents duplicate GitHub webhook
// deliveries from being processed twice — GitHub retries webhooks that receive a non-200
// response, and each retry carries the same `x-github-delivery` UUID. By caching the delivery
// ID after a successful processing attempt, the server can return 204 immediately on retries
// without re-queuing the job. Activated when REDIS_URL is set alongside --profile redis.
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
  };
}

export type RedisCache = ReturnType<typeof createRedisCache>;

/**
 * Idempotency check for GitHub webhook deliveries. Returns true if the delivery was
 * already seen (caller should short-circuit with 204). Marks the delivery as seen
 * for `ttlSeconds` (default 5 min — covers GitHub's retry window) on the FIRST call.
 * Best-effort: a Redis error is swallowed to avoid blocking webhook processing.
 */
export async function checkAndMarkDelivery(cache: RedisCache, deliveryId: string, ttlSeconds = 300): Promise<boolean> {
  try {
    const seen = await cache.get(`delivery:${deliveryId}`);
    if (seen) return true;
    await cache.set(`delivery:${deliveryId}`, "1", ttlSeconds);
    return false;
  } catch {
    // Redis unavailable → treat as first-time (never block processing on cache failure)
    return false;
  }
}
