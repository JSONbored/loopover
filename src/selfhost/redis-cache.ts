// Redis-backed request-dedup cache for self-host (#1216). Prevents duplicate GitHub webhook
// deliveries from being processed twice — GitHub retries webhooks that receive a non-200
// response, and each retry carries the same `x-github-delivery` UUID. By caching the delivery
// ID after a successful processing attempt, the server can return 204 immediately on retries
// without re-queuing the job. The self-host review runtime requires REDIS_URL.
import type { Redis } from "ioredis";
import { incr } from "./metrics";

const WEBHOOK_DELIVERY_CACHE_PREFIX = "delivery:";

const REDIS_WEBHOOK_DEDUP_CACHE_METRIC = "loopover_redis_webhook_dedup_cache_total";

/** Records a webhook-dedup Redis cache outcome. Mirrors redis-token-cache.ts's recordTokenCacheMetric /
 *  redis-response-cache.ts's recordRedisResponseCacheMetric: a named recorder over a `{result}`-labeled
 *  counter, so a sustained Redis outage on this cache is as visible as one on either sibling. Kept separate
 *  from `loopover_webhook_dedup_total{backend="redis"}`, which counts actual dedup HITS -- folding errors
 *  into that counter would conflate "deliveries deduplicated" with "cache unavailable". */
function recordWebhookDedupCacheMetric(result: "error"): void {
  incr(REDIS_WEBHOOK_DEDUP_CACHE_METRIC, { result });
}

export function webhookDeliveryCacheKey(deliveryId: string): string {
  return `${WEBHOOK_DELIVERY_CACHE_PREFIX}${deliveryId}`;
}

/** Returns true when this GitHub webhook delivery ID was already processed (Redis dedup hit).
 *  Increments `loopover_webhook_dedup_total{backend="redis"}` on a hit. Does NOT mark the
 *  delivery — the caller marks only after a successful response (#2506 / #2572). */
export async function isWebhookDeliveryDuplicate(cache: RedisCache, deliveryId: string): Promise<boolean> {
  try {
    const seen = await cache.get(webhookDeliveryCacheKey(deliveryId));
    if (seen) {
      incr("loopover_webhook_dedup_total", { backend: "redis" });
      return true;
    }
    return false;
  } catch {
    // Fail open (unchanged): a cache outage must never block webhook processing -- but record it so the
    // outage is visible, matching both sibling Redis caches.
    recordWebhookDedupCacheMetric("error");
    return false;
  }
}

/** Best-effort: record a successfully processed webhook delivery for Redis dedup. */
export async function rememberWebhookDelivery(cache: RedisCache, deliveryId: string, ttlSeconds = 300): Promise<void> {
  try {
    await cache.set(webhookDeliveryCacheKey(deliveryId), "1", ttlSeconds);
  } catch {
    // best-effort — never block the response on a cache write failure (unchanged), but make the failure
    // observable on the same metric surface as the sibling caches.
    recordWebhookDedupCacheMetric("error");
  }
}

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
