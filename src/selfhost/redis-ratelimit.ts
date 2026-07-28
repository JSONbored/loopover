// Redis-backed rate limiter for self-host (#977). The Cloudflare deploy uses a RateLimiter Durable Object;
// self-host provides the SAME binding surface (idFromName → get → fetch) backed by a Redis fixed-window
// counter, so `enforceRateLimit` works unchanged and is shared across instances. REDIS_URL is required by the
// self-host review runtime.
import type { Redis } from "ioredis";

interface RateLimitBody {
  key?: string;
  limit?: number;
  windowSeconds?: number;
}

/**
 * #9493: INCR-then-conditional-EXPIRE is two round trips, so a process death, a dropped connection, or an
 * EXPIRE that simply errored between them left the key with **no TTL**. The fixed window then never resets:
 * the counter climbs forever and, once past the limit, every request on that key is denied until someone
 * deletes it by hand. The worst key is `strict:/v1/github/webhook:installation:<id>` — a stuck key means
 * every webhook delivery for that installation is 429'd indefinitely, and GitHub does not auto-redeliver.
 * The old code even papered over the symptom: a `PTTL` of -1 fell back to a full window, so the 429 kept
 * promising "retry in 60s" forever.
 *
 * One script makes the increment and its expiry atomic, and repairs a key that somehow still has no TTL
 * (`t < 0`) instead of leaving it immortal — so a key stranded by the old code self-heals on next contact
 * rather than needing manual intervention. Returns `[count, ttlMs]`.
 */
const INCREMENT_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

async function incrementWindow(redis: Redis, key: string, windowSeconds: number): Promise<[number, number]> {
  const reply = (await redis.eval(INCREMENT_WINDOW_SCRIPT, 1, key, String(windowSeconds * 1000))) as [number, number];
  return [Number(reply[0]), Number(reply[1])];
}

export function createRedisRateLimiter(redis: Redis): DurableObjectNamespace {
  const stub = {
    // A DO stub's fetch is called fetch-style: `.fetch(url, init)`. On Workers the runtime builds the Request;
    // on Node we construct it ourselves so `.json()` is available.
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = (await request.json().catch(() => null)) as RateLimitBody | null;
      if (!body?.key || !body.limit || !body.windowSeconds) {
        return Response.json({ error: "invalid_rate_limit_request" }, { status: 400 });
      }
      const k = `ratelimit:${body.key}`;
      const [count, ttlMs] = await incrementWindow(redis, k, body.windowSeconds);
      // PTTL is now guaranteed positive by the script's own repair arm, but keep the fallback: a future
      // transport/serialization change that yields a non-numeric reply must not produce a NaN resetAt.
      const resetMs = ttlMs > 0 ? ttlMs : body.windowSeconds * 1000;
      const allowed = count <= body.limit;
      const decision = {
        allowed,
        limit: body.limit,
        remaining: Math.max(body.limit - count, 0),
        resetAt: new Date(Date.now() + resetMs).toISOString(),
        ...(allowed ? {} : { retryAfterSeconds: Math.max(1, Math.ceil(resetMs / 1000)) }),
      };
      return Response.json(decision, { status: allowed ? 200 : 429 });
    },
  };
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (_id: unknown) => stub,
  };
  return namespace as unknown as DurableObjectNamespace;
}
