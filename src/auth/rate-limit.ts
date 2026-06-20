import type { Context } from "hono";
import { DurableObject } from "cloudflare:workers";
import { recordAuditEvent } from "../db/repositories";
import { authenticateInternalToken, authenticatePrivateToken, extractBearerToken, hashToken } from "./security";

export type RateLimitClass = "strict" | "normal" | "expensive";

type RateLimitConfig = {
  limit: number;
  windowSeconds: number;
};

type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds?: number;
};

const CONFIG: Record<RateLimitClass, RateLimitConfig> = {
  strict: { limit: 10, windowSeconds: 60 },
  normal: { limit: 120, windowSeconds: 60 },
  expensive: { limit: 20, windowSeconds: 300 },
};

export class RateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  override async fetch(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { key?: string; limit?: number; windowSeconds?: number } | null;
    if (!body?.key || !body.limit || !body.windowSeconds) return Response.json({ error: "invalid_rate_limit_request" }, { status: 400 });
    const now = Date.now();
    const storageKey = `bucket:${body.key}`;
    const existing = (await this.ctx.storage.get<{ count: number; resetAt: number }>(storageKey)) ?? {
      count: 0,
      resetAt: now + body.windowSeconds * 1000,
    };
    const bucket = existing.resetAt <= now ? { count: 0, resetAt: now + body.windowSeconds * 1000 } : existing;
    bucket.count += 1;
    await this.ctx.storage.put(storageKey, bucket);
    const remaining = Math.max(body.limit - bucket.count, 0);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    const decision: RateLimitDecision = {
      allowed: bucket.count <= body.limit,
      limit: body.limit,
      remaining,
      resetAt: new Date(bucket.resetAt).toISOString(),
      ...(bucket.count > body.limit ? { retryAfterSeconds } : {}),
    };
    return Response.json(decision, { status: decision.allowed ? 200 : 429 });
  }
}

export async function enforceRateLimit(c: Context<{ Bindings: Env }>, routeClass: RateLimitClass): Promise<Response | null> {
  if (!c.env.RATE_LIMITER) return null;
  const config = CONFIG[routeClass];
  const key = await rateLimitKey(c, routeClass);
  const id = c.env.RATE_LIMITER.idFromName(key);
  const decisionResponse = await c.env.RATE_LIMITER.get(id).fetch("https://rate-limit/check", {
    method: "POST",
    body: JSON.stringify({ key, ...config }),
  });
  const decision = (await decisionResponse.json().catch(() => ({}))) as Partial<RateLimitDecision>;
  if (decisionResponse.status !== 429) {
    c.res.headers.set("x-ratelimit-limit", String(decision.limit ?? config.limit));
    c.res.headers.set("x-ratelimit-remaining", String(decision.remaining ?? config.limit));
    if (decision.resetAt) c.res.headers.set("x-ratelimit-reset", decision.resetAt);
    return null;
  }
  await recordAuditEvent(c.env, {
    eventType: "rate_limit.denied",
    actor: await actorHint(c),
    route: c.req.path,
    outcome: "denied",
    metadata: { routeClass, retryAfterSeconds: decision.retryAfterSeconds ?? null },
  });
  return c.json(
    {
      error: "rate_limited",
      routeClass,
      retryAfterSeconds: decision.retryAfterSeconds ?? 60,
      resetAt: decision.resetAt,
    },
    429,
    {
      "retry-after": String(decision.retryAfterSeconds ?? 60),
      "x-ratelimit-limit": String(decision.limit ?? config.limit),
      "x-ratelimit-remaining": "0",
      ...(decision.resetAt ? { "x-ratelimit-reset": decision.resetAt } : {}),
    },
  );
}

export function routeClassForPath(path: string): RateLimitClass {
  if (path === "/v1/github/webhook") return "strict";
  if (path === "/v1/auth/session" || path === "/v1/auth/logout") return "normal";
  if (path.startsWith("/v1/auth/")) return "strict";
  if (
    path.includes("/branch-analysis") ||
    path.includes("/v1/agent/") ||
    path.includes("/scoring/preview") ||
    path.includes("/decision-pack") ||
    path.includes("/miner-dashboard/refresh") ||
    path.includes("/open-pr-monitor") ||
    // Maintainer BYOK config: POST /ai-key runs PBKDF2 (100k iters) + an encrypted D1 upsert per request.
    /\/ai-(?:key|review)$/.test(path) ||
    /^\/v1\/installations\/[^/]+\/repair\/refresh$/.test(path) ||
    path.includes("/upstream/") ||
    path.includes("/internal/jobs/generate-signal-snapshots") ||
    path.includes("/internal/jobs/build-contributor-decision-packs") ||
    path.includes("/internal/jobs/refresh-upstream-drift") ||
    path.includes("/internal/jobs/file-upstream-drift-issues") ||
    path.includes("/internal/queue-intelligence")
  ) {
    return "expensive";
  }
  return "normal";
}

async function rateLimitKey(c: Context<{ Bindings: Env }>, routeClass: RateLimitClass): Promise<string> {
  const pathGroup = c.req.path
    .replace(/^\/v1\/public\/github\/repos\/[^/]+\/[^/]+\/stats$/, "/v1/public/github/repos/:owner/:repo/stats")
    .replace(/\/\d+(?=\/|$)/g, "/:number")
    .replace(/\/[^/]+\/[^/]+\/pulls\//, "/:owner/:repo/pulls/");
  const identity = await rateLimitIdentity(c);
  return `${routeClass}:${pathGroup}:${identity}`;
}

async function actorHint(c: Context<{ Bindings: Env }>): Promise<string> {
  if (isPreAuthRateLimitPath(c.req.path)) return "anonymous";
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token || !(await validateBearerForRateLimit(c, token))) return "anonymous";
  return `token:${(await hashToken(token)).slice(0, 16)}`;
}

async function rateLimitIdentity(c: Context<{ Bindings: Env }>): Promise<string> {
  const ipIdentity = `ip:${await hashToken(clientIp(c))}`;
  if (isPreAuthRateLimitPath(c.req.path)) return ipIdentity;

  const token = extractBearerToken(c.req.header("authorization"));
  if (!token || !(await validateBearerForRateLimit(c, token))) return ipIdentity;
  return `token:${await hashToken(token)}`;
}

async function validateBearerForRateLimit(c: Context<{ Bindings: Env }>, token: string): Promise<boolean> {
  return Boolean((await authenticatePrivateToken(c.env, token)) ?? (await authenticateInternalToken(c.env, token)));
}

function clientIp(c: Context<{ Bindings: Env }>): string {
  // Only trust Cloudflare-populated client IPs. Proxy fallback headers can be supplied by clients in Workers.
  return normalizeIpAddress(c.req.header("cf-connecting-ip")) ?? "unknown-ip";
}

function normalizeIpAddress(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !isValidIpAddress(trimmed)) return undefined;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  return trimmed;
}

function isValidIpAddress(value: string): boolean {
  return isValidIpv4(value) || isValidIpv6(value);
}

function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return false;
  }
  return true;
}

function isValidIpv6(value: string): boolean {
  let candidate = value;
  if (candidate.startsWith("[") && candidate.endsWith("]")) candidate = candidate.slice(1, -1);
  if (!candidate.includes(":") || !/^[0-9a-fA-F:.]+$/.test(candidate)) return false;
  if (candidate.split("::").length > 2) return false;
  const segments = candidate.split(":");
  if (segments.length > 8) return false;
  let hasHexSegment = false;
  for (const segment of segments) {
    if (segment === "") continue;
    if (!/^[0-9a-fA-F]{1,4}$/.test(segment)) return false;
    hasHexSegment = true;
  }
  return hasHexSegment;
}

function isPreAuthRateLimitPath(path: string): boolean {
  return path === "/health" || path === "/v1/mcp/compatibility" || path === "/openapi.json" || path === "/mcp" || path.startsWith("/v1/auth/") || path === "/v1/github/webhook";
}
