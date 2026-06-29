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
      const count = await redis.incr(k);
      if (count === 1) await redis.expire(k, body.windowSeconds); // start the window on first hit
      const ttlMs = await redis.pttl(k);
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
