// First-party endpoint for forwarding cookieless analytics events to PostHog
// (#8293, #8299 -- this module previously forwarded to self-hosted Umami).
//
// The browser only ever talks to our own origin (loopover.ai):
//   POST /stats/i/v0/e/   -> https://us.i.posthog.com/i/v0/e/     (capture)
//   GET  /stats/static/*  -> https://us-assets.i.posthog.com/...  (SDK bundle)
//
// The `/stats` prefix is retained from the Umami proxy this replaces. It is
// not cosmetic: PostHog's own Cloudflare-proxy guide warns that ad blockers
// pattern-match "analytics"/"tracking"/"posthog"/"ph" in URLs even on a
// first-party origin, so an unrelated-sounding prefix is the recommendation.
// Keeping the existing one also means no dangling references elsewhere.
//
// WHY THE ALLOWLIST SURVIVED THE PORT (#8293 requires it stay load-bearing).
// Its original justification was Umami-specific: that host served its admin
// and auth API from the same origin as the collect endpoint, so an open proxy
// there would have exposed the analytics console itself. That specific threat
// does NOT carry over -- PostHog's ingest hosts (us.i.posthog.com,
// us-assets.i.posthog.com) serve ingest only, and the app/admin surface lives
// on the separate us.posthog.com. The allowlist is kept anyway, one level
// looser (path PREFIXES rather than exact paths), because it still bounds what
// this public unauthenticated route can be pointed at, while being tolerant of
// posthog-js choosing different sub-paths across SDK versions. An exact-path
// allowlist would silently break capture on a posthog-js upgrade; a prefix set
// covering PostHog's documented ingest surface will not.
//
// Note this DOES now serve PostHog's SDK bundle as same-origin JavaScript,
// which the Umami-era header comment here explicitly refused to do for the
// Umami tracker. That is a deliberate reversal, not an oversight: PostHog's
// documented proxy design requires it (posthog-js bootstraps itself from
// /static/array.js), the asset is served by a dedicated immutable asset host
// rather than the same host as an admin console, and it is the same posture
// JSONbored/metagraphed#7781 already runs in production. The alternative --
// loading the SDK from a third-party origin -- is strictly worse for both
// privacy and ad-blocker resilience.

export const ANALYTICS_PREFIX = "/stats";

const POSTHOG_API_HOST = "https://us.i.posthog.com";
const POSTHOG_ASSET_HOST = "https://us-assets.i.posthog.com";

// Edge-cacheable, per-project rather than per-visitor: the SDK bundle and the
// remote-config document. Routed to the asset host, everything else to the
// capture host. Order matters only in that these are checked first.
const ASSET_PREFIXES = ["/static/", "/array/"] as const;

// PostHog's documented ingest surface, as posthog-js actually calls it:
//   /e/, /i/       capture (legacy and current paths)
//   /batch/        batched capture
//   /decide/       legacy remote config + flags
//   /flags/        current flag evaluation
//   /s/            session-replay snapshots (not enabled yet -- #8295 -- but
//                  allowed so enabling it is a one-line SDK change, not a
//                  silent 404 to debug)
//   /engage/       person-property updates
const CAPTURE_PREFIXES = [
  "/e/",
  "/i/",
  "/batch/",
  "/decide/",
  "/flags/",
  "/s/",
  "/engage/",
] as const;

// Request headers we never forward upstream (hop-by-hop or our-origin specific).
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  // Cookieless analytics: never forward the visitor's first-party cookies upstream.
  "cookie",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-host",
  "x-forwarded-proto",
  // Re-derived below from the trusted cf-connecting-ip; never trust a client-supplied value.
  "x-forwarded-for",
]);

// Response headers we never relay back to the browser. content-encoding/-length
// are dropped because the runtime decodes the upstream body, so the originals
// would no longer match what we send.
const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "set-cookie", // cookieless analytics: never relay cookies to the client
]);

// This route is public and unauthenticated -- reachable by anyone, not just
// posthog-js -- so it must never buffer an unbounded body into Worker memory.
// Sized well above the Umami proxy's old 16 KiB cap this replaces, because
// PostHog's capture endpoint accepts BATCHED events (posthog-js queues and
// flushes several in one POST) where Umami sent strictly one event per
// request. Our own defensive ceiling, not a PostHog-documented limit.
const MAX_INGEST_BODY_BYTES = 64 * 1024;

// Session-replay snapshots are a different traffic class: rrweb DOM snapshots
// are orders of magnitude larger than an event batch, and a full-snapshot
// flush on a dense page blows past 64 KiB easily. Replay is not enabled yet
// (#8295), but the ceiling is sized correctly now so turning it on cannot
// silently 413 and drop recordings with nothing in the UI surfacing the loss --
// which is exactly the production bug JSONbored/metagraphed#8263 hit.
const MAX_REPLAY_BODY_BYTES = 2 * 1024 * 1024;

function isReplayPath(upstreamPath: string): boolean {
  return upstreamPath.startsWith("/s/");
}

function startsWithAny(upstreamPath: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => upstreamPath.startsWith(prefix));
}

/** Cloudflare Workers runtime `caches` global. Absent under local `vite dev`
 *  (Node) and in this module's unit tests, which is why the asset path below
 *  degrades to an uncached fetch when it is undefined. */
declare const caches:
  | {
      default: {
        match(request: Request): Promise<Response | undefined>;
        put(request: Request, response: Response): Promise<void>;
      };
    }
  | undefined;

export type PostHogAssetContext = { waitUntil(promise: Promise<unknown>): void };

async function retrieveAnalyticsAsset(
  request: Request,
  upstreamUrl: string,
  ctx: PostHogAssetContext | undefined,
): Promise<Response> {
  // `ctx` is typed as present but is cast through from an `unknown` parameter
  // in server.ts, so the type-level contract carries no runtime guarantee --
  // and an undefined ctx here was the root cause of a real production incident
  // in the sibling implementation (JSONbored/metagraphed#7794): `ctx.waitUntil`
  // threw, the rejection escaped, and every asset request 500'd. Edge caching
  // is a best-effort optimization -- treat a missing or unusable ctx exactly
  // like a missing `caches` global and degrade to a plain fetch, never throw.
  const hasEdgeCache = typeof caches !== "undefined" && typeof ctx?.waitUntil === "function";

  let cached: Response | undefined;
  if (hasEdgeCache) {
    try {
      cached = await caches.default.match(request);
    } catch {
      // A cache read failure must fall through to a normal upstream fetch.
    }
  }
  if (cached) return cached;

  const upstream = await fetch(upstreamUrl);
  if (hasEdgeCache) {
    // A rejected promise handed to waitUntil() becomes an unhandled rejection
    // at Worker global scope, which this app's own error-capture listeners
    // (lib/error-capture.ts) then turn into a 500 for the CURRENT request --
    // even though the response below was already computed correctly. Swallow
    // write failures; the response is already on its way to the browser.
    ctx.waitUntil(caches.default.put(request, upstream.clone()).catch(() => undefined));
  }
  return upstream;
}

async function forwardToAnalyticsHost(request: Request, upstreamUrl: string): Promise<Response> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  // Content-length-first gate: reject BEFORE buffering, never after, so an
  // oversized or malformed request is never read into memory at all.
  if (hasBody) {
    const rawContentLength = request.headers.get("content-length");
    const contentLength = rawContentLength === null ? NaN : Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return new Response("Length Required", { status: 411 });
    }
    const maxBytes = isReplayPath(new URL(upstreamUrl).pathname)
      ? MAX_REPLAY_BODY_BYTES
      : MAX_INGEST_BODY_BYTES;
    if (contentLength > maxBytes) {
      return new Response("Payload Too Large", { status: 413 });
    }
  }

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  // Preserve the real client IP so PostHog geolocates the visitor, not the
  // Worker -- this is what keeps the country/city data the Umami beacon's own
  // geo provided. Set from the trusted cf-connecting-ip only; the
  // client-supplied x-forwarded-for is stripped above so a visitor cannot
  // spoof their geolocation.
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    // Buffered, not streamed straight through: PostHog's own proxy guide flags
    // passing request.body directly as an observed cause of corrupted event
    // payloads on POST.
    body: hasBody ? await request.arrayBuffer() : null,
  });

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/**
 * Proxies the allowlisted PostHog ingest paths through our own origin.
 * Returns a `Response` for a matched `/stats/*` path, or `undefined` for any
 * other request so the caller falls through to SSR.
 */
export async function handleAnalyticsProxy(
  request: Request,
  ctx?: PostHogAssetContext,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${ANALYTICS_PREFIX}/`)) return undefined;

  const upstreamPath = url.pathname.slice(ANALYTICS_PREFIX.length);
  const isAsset = startsWithAny(upstreamPath, ASSET_PREFIXES);
  const isCapture = startsWithAny(upstreamPath, CAPTURE_PREFIXES);
  // Not an analytics path we know about. Returning undefined (rather than a
  // 404) keeps the old behavior: anything under /stats that isn't allowlisted
  // falls through to SSR, which renders the normal not-found page.
  if (!isAsset && !isCapture) return undefined;

  const upstreamUrl = (isAsset ? POSTHOG_ASSET_HOST : POSTHOG_API_HOST) + upstreamPath + url.search;

  try {
    return isAsset
      ? await retrieveAnalyticsAsset(request, upstreamUrl, ctx)
      : await forwardToAnalyticsHost(request, upstreamUrl);
  } catch {
    // Analytics must never take the page down -- fail quietly.
    return new Response(null, { status: 502 });
  }
}
