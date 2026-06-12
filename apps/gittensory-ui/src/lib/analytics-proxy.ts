// First-party reverse proxy for the self-hosted Umami tracker.
//
// The browser only ever talks to our own origin (gittensory.aethereal.dev):
//   GET  /stats/script.js -> https://tasty.aethereal.dev/script.js
//   POST /stats/api/send  -> https://tasty.aethereal.dev/api/send
//
// The tracker derives its collect endpoint from its own <script src> directory,
// so serving it at /stats/script.js makes it POST to /stats/api/send on its own
// — no data-host-url attribute needed. Keeping the script first-party clears the
// Subresource-Integrity finding without an SRI hash to re-pin on every Umami
// upgrade, and it survives ad-blockers that target the analytics subdomain.
//
// The allowlist below is load-bearing: this must NOT become an open proxy onto
// the Umami host, whose admin/auth API lives on the same origin as the tracker.

const UPSTREAM = "https://tasty.aethereal.dev";
export const ANALYTICS_PREFIX = "/stats";

// First-party path -> methods we forward. Anything else under /stats 404s here.
const ROUTES: Record<string, ReadonlySet<string>> = {
  "/stats/script.js": new Set(["GET", "HEAD"]),
  "/stats/api/send": new Set(["POST"]),
};

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

/**
 * Proxies the allowlisted Umami tracker paths through our own origin.
 * Returns a `Response` for `/stats/script.js` and `/stats/api/send`, or
 * `undefined` for any other request so the caller falls through to SSR.
 */
export async function handleAnalyticsProxy(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  const allowedMethods = ROUTES[url.pathname];
  if (!allowedMethods) return undefined; // not an analytics path — let SSR handle it

  if (!allowedMethods.has(request.method)) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: [...allowedMethods].join(", ") },
    });
  }

  const upstreamUrl = UPSTREAM + url.pathname.slice(ANALYTICS_PREFIX.length) + url.search;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  // Preserve the real client IP so Umami geolocates the visitor, not the Worker. Set it to the
  // trusted cf-connecting-ip only -- the client-supplied x-forwarded-for is stripped above so a
  // visitor cannot spoof their geolocation.
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      // Buffer the (tiny) collect payload so we don't need a streaming/duplex body.
      body: hasBody ? await request.arrayBuffer() : null,
    });
  } catch {
    // Analytics must never take the page down — fail quietly.
    return new Response(null, { status: 502 });
  }

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
