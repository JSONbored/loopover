// Blanket, IP-keyed rate limiter for the discovery-index Worker (#4250's "rate-limiting/abuse posture"
// deliverable). Mirrors the main app's Durable-Object fixed-window-counter shape (src/auth/rate-limit.ts's
// RateLimiter) conceptually, but is deliberately self-contained rather than a shared import: Durable Object
// classes belong to one Worker deployment each, and this service's callers have no per-caller identity to
// key on in the first place -- every opted-in miner authenticates with the SAME shared
// DISCOVERY_INDEX_SHARED_SECRET (soft-claim.ts's own header comment: "the shipped client payload never
// carries caller identity"), so a token- or installation-keyed bucket (the main app's preferred identity
// when resolvable) isn't available here even in principle. IP-keying, the main app's own fallback for
// exactly this "no better identity" case, is the right default rather than a fallback.
import { DurableObject } from "cloudflare:workers";

/** Requests allowed per IP per window. Generous relative to legitimate miner polling cadence (the result
 *  cache TTL is 5 minutes by default, README.md), tight enough to blunt a single misbehaving/abusive
 *  caller sharing the one bearer secret. */
export const RATE_LIMIT = 60;
export const RATE_LIMIT_WINDOW_SECONDS = 60;

type Bucket = { count: number; resetAt: number };

export type RateLimitCheckRequest = { key: string; limit: number; windowSeconds: number };
export type RateLimitDecision = { allowed: boolean; remaining: number; retryAfterSeconds: number };

/** Fixed-window counter, keyed and configured entirely by the caller's request body (limit/windowSeconds
 *  travel on the wire, same shape as the main app's RateLimiter) rather than reading the module-level
 *  RATE_LIMIT/RATE_LIMIT_WINDOW_SECONDS constants directly -- keeps this class's own logic testable with
 *  small, fast numbers independent of the real operational values enforceDiscoveryIndexRateLimit sends. */
export class DiscoveryIndexRateLimiter extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Partial<RateLimitCheckRequest> | null;
    if (!body?.key || !body.limit || !body.windowSeconds) return Response.json({ error: "invalid_rate_limit_request" }, { status: 400 });
    const now = Date.now();
    const storageKey = `bucket:${body.key}`;
    const existing = await this.ctx.storage.get<Bucket>(storageKey);
    const bucket: Bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + body.windowSeconds * 1000 };
    bucket.count += 1;
    await this.ctx.storage.put(storageKey, bucket);
    const allowed = bucket.count <= body.limit;
    const decision: RateLimitDecision = {
      allowed,
      remaining: Math.max(body.limit - bucket.count, 0),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
    return Response.json(decision, { status: allowed ? 200 : 429 });
  }
}

/** Cloudflare-populated client IP only -- a client-supplied proxy header is not trusted, same reasoning as
 *  the main app's clientIp() (src/auth/rate-limit.ts). */
function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown-ip";
}

/** Checks and increments this IP's bucket. Fails OPEN on a Durable Object error (#5000's reasoning, same as
 *  the main app's enforceRateLimit): the limiter exists to protect the service, not to become a second
 *  point of failure that turns a DO hiccup into an outage for every legitimate caller. */
export async function enforceDiscoveryIndexRateLimit(
  request: Request,
  namespace: DurableObjectNamespace<DiscoveryIndexRateLimiter>,
): Promise<Response | null> {
  const key = `ip:${clientIp(request)}`;
  let decision: RateLimitDecision;
  try {
    const id = namespace.idFromName(key);
    const response = await namespace.get(id).fetch("https://rate-limit/check", {
      method: "POST",
      body: JSON.stringify({ key, limit: RATE_LIMIT, windowSeconds: RATE_LIMIT_WINDOW_SECONDS }),
    });
    decision = (await response.json()) as RateLimitDecision;
  } catch (error) {
    console.error(JSON.stringify({ event: "discovery_index_rate_limit_check_failed", message: error instanceof Error ? error.message : String(error) }));
    return null;
  }
  if (decision.allowed) return null;
  return Response.json(
    { error: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds },
    { status: 429, headers: { "retry-after": String(decision.retryAfterSeconds) } },
  );
}
