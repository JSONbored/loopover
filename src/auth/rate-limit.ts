import type { Context } from "hono";
import { DurableObject } from "cloudflare:workers";
import { recordAuditEvent } from "../db/repositories";
import { validateOrbRelayEnrollment } from "../orb/relay";
import { parsePositiveInt } from "../utils/json";
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
  const key = await rateLimitKey(c, routeClass);
  return checkRateLimitBucket(c, key, CONFIG[routeClass], routeClass);
}

// #9044: a SEPARATE, fixed-key (never identity-keyed) ceiling on /loopover/shot's on-demand render mode --
// the one route on this deployment's single internet-facing path that drives a real headless-Chromium render
// per request. The per-identity `expensive` bucket above is necessary but not sufficient: an attacker who can
// get an arbitrary value into `Cf-Connecting-Ip` (or who simply has no header at all pre-clientIp-fix) gets a
// FRESH per-identity bucket on every request by rotating it, bypassing the per-identity cap entirely. A fixed
// key sidesteps that class of bypass completely -- there is only ever ONE bucket for this route's render mode,
// no matter what identity a caller can manufacture. Deliberately its OWN (lower) budget rather than reusing
// CONFIG.expensive: this caps the render primitive's TOTAL cost to the whole deployment, not any one caller's
// share of it, so it is set independently of the per-identity number.
const SHOT_RENDER_GLOBAL_CONFIG: RateLimitConfig = { limit: 30, windowSeconds: 60 };
const SHOT_RENDER_GLOBAL_KEY = "global-ceiling:loopover-shot-render";

/** Enforce the fixed-key global ceiling on `/loopover/shot`'s on-demand render mode (see
 *  {@link SHOT_RENDER_GLOBAL_CONFIG}'s doc comment for why this exists alongside the per-identity `expensive`
 *  class). Callers should invoke this ONLY for the render (`?url=`) mode -- the R2-serve (`?key=`) mode is
 *  cheap and doesn't drive a render, so it stays covered by the ordinary per-identity check alone. */
export async function enforceShotRenderGlobalCeiling(c: Context<{ Bindings: Env }>): Promise<Response | null> {
  return checkRateLimitBucket(c, SHOT_RENDER_GLOBAL_KEY, SHOT_RENDER_GLOBAL_CONFIG, "expensive");
}

async function checkRateLimitBucket(c: Context<{ Bindings: Env }>, key: string, config: RateLimitConfig, routeClass: RateLimitClass): Promise<Response | null> {
  if (!c.env.RATE_LIMITER) return null;
  let decisionResponse: Response;
  try {
    const id = c.env.RATE_LIMITER.idFromName(key);
    decisionResponse = await c.env.RATE_LIMITER.get(id).fetch("https://rate-limit/check", {
      method: "POST",
      body: JSON.stringify({ key, ...config }),
    });
  } catch (error) {
    // Fail OPEN (#5000): this middleware runs on every route ahead of the handler's own try/catch, and no
    // app.onError is registered anywhere -- an uncaught Durable Object hiccup (eviction, migration, a
    // rolling-deploy blip) previously escaped as Hono's bare, unstructured 500 for whatever route the caller
    // happened to be hitting, indistinguishable from a real application bug in that route. The rate limiter
    // exists to protect the app, not crash the request it's supposed to be gating.
    console.error(JSON.stringify({ level: "error", event: "rate_limit_check_failed", routeClass, message: error instanceof Error ? error.message : String(error) }));
    return null;
  }
  const decision = (await decisionResponse.json().catch(() => ({}))) as Partial<RateLimitDecision>;
  if (decisionResponse.status !== 429) {
    c.res.headers.set("x-ratelimit-limit", String(decision.limit ?? config.limit));
    c.res.headers.set("x-ratelimit-remaining", String(decision.remaining ?? config.limit));
    if (decision.resetAt) c.res.headers.set("x-ratelimit-reset", decision.resetAt);
    return null;
  }
  // Best-effort: the 429 itself must still reach the caller even if this audit write fails (#5000, same
  // fail-open reasoning as the DO call above).
  await recordAuditEvent(c.env, {
    eventType: "rate_limit.denied",
    actor: await actorHint(c),
    route: c.req.path,
    outcome: "denied",
    metadata: { routeClass, retryAfterSeconds: decision.retryAfterSeconds ?? null },
  }).catch((error) => {
    console.warn(JSON.stringify({ level: "warn", event: "rate_limit_denied_audit_failed", routeClass, message: error instanceof Error ? error.message : String(error) }));
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
  // Orb central-App inbound webhook — same class as the review-app webhook above (GitHub delivers from a
  // narrow IP range; the per-IP strict cap is proven for /v1/github/webhook and #1292 reserves headroom).
  if (path === "/v1/orb/webhook") return "strict";
  if (path === "/v1/orb/relay") return "strict";
  if (path === "/v1/orb/oauth/callback") return "strict";
  if (path === "/v1/orb/token") return "strict";
  if (path === "/v1/orb/relay/register") return "strict";
  // Orb telemetry ingest: unauthenticated + write, accepting anonymized batches from untrusted
  // self-host instances. Strict (10/min per IP) caps abuse — legitimate instances export hourly.
  if (path === "/v1/orb/ingest") return "strict";
  // #9046: the AMS collector is the same shape as the Orb one above (unauthenticated-by-default
  // write surface, hard body ceiling) but was landing in the looser `normal` class purely by omission.
  if (path === "/v1/ams/ingest") return "strict";
  if (path === "/v1/auth/session" || path === "/v1/auth/logout") return "normal";
  // GitHub's OAuth Device Authorization Grant (RFC 8628) is polling-by-design: a client polls
  // /device/poll at a server-specified interval (this repo's own default is 5s) for up to the device
  // code's full expiry window (900s / 15 minutes here) -- normal human completion time alone can
  // exceed the blanket strict class's 10-req/60s budget well before the code even expires (#6792).
  // /device/start shares the same generous class since a retried/failed start attempt shouldn't eat
  // into the same tight budget a poll loop needs.
  if (path === "/v1/auth/github/device/poll" || path === "/v1/auth/github/device/start") return "normal";
  if (path.startsWith("/v1/auth/")) return "strict";
  if (path === "/loopover/shot") return "expensive";
  if (
    path.includes("/branch-analysis") ||
    path.includes("/v1/agent/") ||
    path.includes("/scoring/preview") ||
    path.includes("/decision-pack") ||
    path.includes("/miner-dashboard/refresh") ||
    path.includes("/open-pr-monitor") ||
    path === "/v1/opportunities/find" ||
    path === "/v1/issue-rag/retrieve" ||
    // Maintainer BYOK config: POST /ai-key and /linear-key both run PBKDF2 (100k iters) + an encrypted D1
    // upsert per request.
    /\/(?:ai-(?:key|review)|linear-key)$/.test(path) ||
    /^\/v1\/installations\/[^/]+\/repair\/refresh$/.test(path) ||
    /^\/v1\/app\/installations\/[^/]+\/repair\/refresh$/.test(path) ||
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

  const installationIdentity = await installationRateLimitIdentity(c, ipIdentity);
  if (installationIdentity) return installationIdentity;

  if (isPreAuthRateLimitPath(c.req.path)) return ipIdentity;

  const token = extractBearerToken(c.req.header("authorization"));
  if (!token || !(await validateBearerForRateLimit(c, token))) return ipIdentity;
  return `token:${await hashToken(token)}`;
}

// #4891: a centrally-hosted deployment brokers many self-hosted containers behind ONE shared egress path, so
// IP-keying (the only option before this) would collide every tenant's webhook/token/relay traffic into the same
// bucket -- exactly the correctness gap that's invisible on a self-host, which always has its own IP. These paths
// each carry a tenant identity independent of the connecting IP; prefer it when resolvable, falling back to
// IP-keying (below, unchanged) like every other route when it isn't -- a malformed payload, an unenrolled secret.
const INSTALLATION_KEYED_WEBHOOK_PATHS = new Set(["/v1/github/webhook", "/v1/orb/webhook"]);
const INSTALLATION_KEYED_ORB_BEARER_PATHS = new Set(["/v1/orb/token", "/v1/orb/relay/register", "/v1/orb/relay/pull"]);

async function installationRateLimitIdentity(c: Context<{ Bindings: Env }>, ipIdentity: string): Promise<string | null> {
  const path = c.req.path;
  if (INSTALLATION_KEYED_WEBHOOK_PATHS.has(path)) {
    const installationId = await peekWebhookInstallationId(c);
    // #9469: the installation id here is read from the body BEFORE signature verification, so it is
    // ATTACKER-CONTROLLED. Keying on it alone let anyone pin a chosen installation's bucket by POSTing
    // `{"installation":{"id":<victim>}}` 10 times a minute -- GitHub's genuine deliveries then 429, and
    // GitHub does not auto-redeliver, so the engine went deaf for that installation at a cost of one
    // unauthenticated request every six seconds. The prior threat note correctly observed that a spoofed id
    // grants no ACCESS, but sharing the bucket IS the attack.
    //
    // Folding in the connecting IP means an attacker and GitHub can never occupy the same bucket, while
    // #4891's requirement still holds: many brokered tenants behind ONE shared egress no longer collide,
    // because the installation id still separates them. It also restores headroom that #4891 removed by
    // accident -- GitHub delivers from many egress IPs, so a CI storm now spreads across per-IP buckets
    // again instead of contending for a single 10/60s window.
    return installationId === null ? null : `installation:${installationId}:${ipIdentity}`;
  }
  if (path === "/v1/orb/relay") {
    // Single-tenant per deployment: the bound enrollment secret (never the request body) IS this deployment's
    // identity, the same trust boundary brokerOrbToken's installation binding relies on (src/orb/broker.ts).
    const secret = c.env.ORB_ENROLLMENT_SECRET;
    return secret ? `installation:${await hashToken(secret)}` : null;
  }
  if (INSTALLATION_KEYED_ORB_BEARER_PATHS.has(path)) {
    const token = extractBearerToken(c.req.header("authorization"));
    if (!token) return null;
    // #9225: this middleware runs BEFORE the route handler, which has its own well-tested error response for
    // an unresolvable enrollment (a clean `503 broker_error` for the relay/token routes' own later call to
    // this same function). A DB error here must never escape uncaught -- it would surface as a bare framework
    // 500 upstream of that handler, exactly the class of gap #4995 already fixed for the handler's OWN call.
    // Degrading to null (→ IP-keyed fallback below) matches peekWebhookInstallationId's sibling pattern and
    // this function's own doc comment: a DB error is just another "not resolvable" case, alongside a
    // malformed payload or an unenrolled secret.
    const enrollment = await validateOrbRelayEnrollment(c.env, token).catch(() => null);
    if (enrollment === null) return null;
    return "error" in enrollment ? null : `installation:${enrollment.installationId}`;
  }
  return null;
}

const MAX_WEBHOOK_RATE_LIMIT_PEEK_BYTES = 1024 * 1024;

async function peekWebhookInstallationId(c: Context<{ Bindings: Env }>): Promise<number | null> {
  // Reads installation.id from the body BEFORE signature verification (which happens later, in the handler
  // itself, over the same untouched stream via .clone()). The value is therefore unverified at this point --
  // fine for bucketing (a spoofed installation.id here only shares that installation's own rate-limit bucket; it
  // grants no access, since HMAC/enrollment verification still gates everything downstream). Bounded by
  // content-length so a caller can't force this peek to buffer an oversized body twice.
  const contentLength = parsePositiveInt(c.req.header("content-length"));
  if (contentLength === null || contentLength > MAX_WEBHOOK_RATE_LIMIT_PEEK_BYTES) return null;
  const body = (await c.req.raw
    .clone()
    .json()
    .catch(() => null)) as { installation?: { id?: unknown } } | null;
  // A JSON number is always finite (the JSON grammar has no NaN/Infinity literal), so `typeof` alone suffices.
  const id = body?.installation?.id;
  return typeof id === "number" ? id : null;
}

async function validateBearerForRateLimit(c: Context<{ Bindings: Env }>, token: string): Promise<boolean> {
  try {
    return Boolean((await authenticatePrivateToken(c.env, token)) ?? (await authenticateInternalToken(c.env, token)));
  } catch (error) {
    // Fail OPEN (#5000, same reasoning as the DO-fetch catch in checkRateLimitBucket above): this call only
    // classifies which rate-limit bucket a caller lands in (falling back to IP-keying below), it is never the
    // actual authorization decision -- a D1 hiccup during the session-token lookup inside
    // authenticatePrivateToken must not crash the whole request (no app.onError is registered), it should
    // just be treated the same as an unrecognized token.
    console.warn(JSON.stringify({ level: "warn", event: "rate_limit_identity_check_failed", message: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

const LOOPBACK_PEER_IPS = new Set(["127.0.0.1", "::1"]);

/** Rightmost hop of a (possibly multi-hop) `X-Forwarded-For` header -- the one nearest to THIS process, i.e.
 *  the one a single trusted local proxy itself appended, as opposed to any earlier value a client could have
 *  supplied. Only ever consulted from the loopback-trusted branch below. */
function rightmostForwardedFor(header: string | undefined): string | undefined {
  const hops = (header ?? "").split(",");
  return normalizeIpAddress(hops[hops.length - 1]);
}

/**
 * The client identity a rate-limit bucket keys on (#9044).
 *
 * On Cloudflare Workers, `cf-connecting-ip` is populated by the Workers runtime itself and cannot be
 * supplied by the caller -- unconditionally trusting it there is correct and stays exactly as it always has
 * (`env.LOOPOVER_PEER_IP` is never set on Workers, so that branch is unreachable there).
 *
 * Self-host runs the SAME Hono app behind a loopback-bound Node process (`server.ts`), fronted by a
 * Cloudflare Tunnel (cloudflared). `env.LOOPOVER_PEER_IP` (set per-request by server.ts from the real TCP
 * peer address) tells us who actually connected to this process -- the one thing that can never be spoofed
 * by a request header. On THIS topology, a loopback peer IS the trust boundary: nothing other than the local
 * cloudflared process can ever reach a port bound to 127.0.0.1 only, so a loopback peer legitimizes trusting
 * the header it forwarded (falling back to the rightmost X-Forwarded-For hop, then the peer itself, if the
 * header is absent). A NON-loopback peer means this Node process is reachable some other way (e.g. exposed
 * directly with no tunnel in front of it, a foreseeable alternate self-host topology) -- an untrusted
 * connection whose headers could be anything, so the header is ignored entirely and the bucket keys on the
 * peer's own real address instead. Either way, once real peer info exists, "unknown-ip" (a bucket shared by
 * every anonymous caller worldwide -- the DoS this closes) is never reachable again.
 */
function clientIp(c: Context<{ Bindings: Env }>): string {
  const peerIp = normalizeIpAddress(c.env.LOOPOVER_PEER_IP);
  if (!peerIp) {
    // Workers, or any caller (tests, an unwired self-host build) that never threads a peer IP in --
    // byte-identical to the pre-#9044 behavior.
    return normalizeIpAddress(c.req.header("cf-connecting-ip")) ?? "unknown-ip";
  }
  if (LOOPBACK_PEER_IPS.has(peerIp)) {
    return normalizeIpAddress(c.req.header("cf-connecting-ip")) ?? rightmostForwardedFor(c.req.header("x-forwarded-for")) ?? peerIp;
  }
  // Untrusted topology: never honor a caller-suppliable header here.
  return peerIp;
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

// These /v1/auth/* paths are excluded from the broad /v1/auth/ prefix match below: unlike the OAuth
// start/callback/device-poll flows they sit alongside, each always requires (and validates) a real session
// bearer token to do anything useful, so they should rate-limit per SESSION like any other authenticated
// route -- not per IP, which would let a caller with a stolen session token bypass the strict 10/min cap by
// rotating source IPs, and would let unrelated sessions behind one NAT (a shared office network, CI infra)
// throttle each other.
//   /v1/auth/github/token (#6114/#6115/#6117): fetches the session's live GitHub token.
const SESSION_AUTHENTICATED_AUTH_PATHS = new Set(["/v1/auth/github/token"]);

function isPreAuthRateLimitPath(path: string): boolean {
  return (
    (path === "/health" || path === "/v1/mcp/compatibility" || path === "/openapi.json" || path === "/mcp" || path.startsWith("/v1/auth/") || path === "/v1/github/webhook") &&
    !SESSION_AUTHENTICATED_AUTH_PATHS.has(path)
  );
}
