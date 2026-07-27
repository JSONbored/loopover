import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Plugin } from "vite";

// Local miner-ui API auth (#4858, hardened for GHSA-v6v4-mh5m-5mqq): the miner-ui's /api/* endpoints
// previously relied on undocumented, implicit loopback-only trust -- and even that was inconsistent
// (vite-run-state-api.ts's own isLoopbackAddress gated only ONE of the three API plugins;
// vite-portfolio-queue-api.ts and vite-ledgers-api.ts had no gate at all). Neither is real
// authentication: loopback-IP checks don't stop another local process, or a malicious page the user
// has open in the SAME browser, from hitting the loopback API.
//
// This adds a minimal-but-real mechanism instead of touching each API file individually: a random token
// generated ONCE per dev-server process, required on every /api/* request via a same-origin HttpOnly
// SameSite=Strict cookie. HttpOnly keeps it unreachable from any XSS in the SPA itself; SameSite=Strict
// means a cross-origin page -- including one from a DNS-rebinding attack, which resolves an
// ATTACKER-CONTROLLED hostname to 127.0.0.1 rather than reusing this dev server's own origin -- never
// has it attached automatically by the browser. Because it rides on the browser's own cookie jar, no
// client-side fetch call needs to change: the browser attaches it automatically to every same-origin
// request, including the existing fetchPortfolioQueue/fetchLedgers/fetchRunState calls.
//
// GHSA-v6v4-mh5m-5mqq: an earlier version of this plugin stamped Set-Cookie on EVERY response that
// wasn't itself rejected -- including the very first, wholly unauthenticated `GET /` and every static
// asset. That gave the token to any local process (not just a browser) that could `curl` the root path,
// with no proof it had ever been authorized to see it. The fix here is to never mint the cookie for an
// anonymous request: it is only ever (re)stamped on a request that ALREADY presents a valid cookie, or
// minted for the first time via the one-shot bootstrap path below, which requires the operator to copy
// the token off the server's own stdout/journal -- something only console/log access can provide, not an
// ordinary loopback request. `isAuthenticatedRequest` also now compares in constant time so a valid
// token can't be inferred from response-timing differences on a byte-by-byte guess.
//
// Registered as the FIRST plugin in vite.config.ts so its middleware runs before runStateApiPlugin/
// portfolioQueueApiPlugin/ledgersApiPlugin's own middlewares in the Connect chain: an unauthenticated /api/*
// request never reaches any of them. This also means any FUTURE /api/* endpoint (e.g. a write action) is
// covered automatically, with no per-endpoint auth wiring required.

const COOKIE_NAME = "loopover_miner_ui_token";

/** One-shot bootstrap path: a browser visits this ONCE per server start, with `?token=` copied from the
 *  server's own stdout/journal, to obtain the session cookie. Presenting the token here is exactly as
 *  strong a proof as the cookie itself -- an attacker without console/log access to the server process
 *  can only guess it, not read it off an ordinary request the way the prior unconditional Set-Cookie did. */
export const AUTH_BOOTSTRAP_PATH = "/__auth/bootstrap";

export type AuthDeps = {
  /** Injectable so tests get a deterministic token instead of a real random one. */
  generateToken: () => string;
  /** Injectable so tests capture the printed bootstrap instructions instead of writing real stdout. */
  logToken: (token: string) => void;
};

const defaultDeps: AuthDeps = {
  generateToken: () => randomBytes(24).toString("hex"),
  logToken: (token) =>
    console.log(
      `[loopover-miner-ui:auth] visit ${AUTH_BOOTSTRAP_PATH}?token=${token} once per server start to authenticate this browser (treat this token like a password): ${token}`,
    ),
};

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) continue;
    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

/** Constant-time string comparison so a byte-by-byte timing attack can't narrow down the token (fix item
 *  #3 of GHSA-v6v4-mh5m-5mqq). Length is checked first -- that alone leaks only the token's length, which
 *  is fixed and public (every token is a 48-char hex string), never any of its actual content. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** True when the incoming request carries the server's own auth cookie. Exported so the plugin's request
 *  handling can be exercised directly in tests without a real HTTP server. */
export function isAuthenticatedRequest(cookieHeader: string | undefined, token: string): boolean {
  const presented = parseCookieHeader(cookieHeader)[COOKIE_NAME];
  return presented !== undefined && constantTimeEquals(presented, token);
}

/** The request handler, factored out of the Vite plugin shape so tests drive it directly (mirrors the sibling
 *  API files' handleXRequest pattern). Returns the 401 body when an /api/* request lacks a valid cookie, or
 *  null when the request should fall through to the next middleware (either it's authenticated, or it isn't
 *  an /api/* request at all). Never sets or implies anything about Set-Cookie itself -- that decision is the
 *  caller's, based on whether the request already proved it holds the token (see authPlugin below). */
export function handleAuthRequest(
  url: string | undefined,
  cookieHeader: string | undefined,
  token: string,
): { status: number; body: string } | null {
  if (!url?.startsWith("/api/")) return null;
  if (isAuthenticatedRequest(cookieHeader, token)) return null;
  return {
    status: 401,
    body: JSON.stringify({ error: "unauthenticated: missing or invalid local miner-ui session cookie" }),
  };
}

export type BootstrapDecision = { redirectTo: string } | { status: number; body: string } | null;

/** Handles the one-shot bootstrap path (see AUTH_BOOTSTRAP_PATH above). Returns null for any other path
 *  (fall through to the normal auth check). A missing or wrong token gets a 404, not a 401 -- an attacker
 *  probing for this path with no valid token learns nothing about whether it exists. */
export function handleBootstrapRequest(url: string | undefined, token: string): BootstrapDecision {
  if (!url) return null;
  const parsed = new URL(url, "http://localhost");
  if (parsed.pathname !== AUTH_BOOTSTRAP_PATH) return null;
  const presented = parsed.searchParams.get("token");
  if (presented !== null && constantTimeEquals(presented, token)) return { redirectTo: "/" };
  return { status: 404, body: "Not Found" };
}

type ConnectRequest = { url?: string; headers: { cookie?: string } };
type ConnectResponse = { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void };

/** Vite dev/preview middleware: generates one token per process, logs it (see defaultDeps.logToken) so an
 *  operator with console/log access can complete the one-shot bootstrap, and then on every request either
 *  rejects it, bootstraps it, or lets it through -- (re)stamping the cookie ONLY when the request already
 *  proved it holds the token, or when it just proved that via a valid bootstrap token (GHSA-v6v4-mh5m-5mqq).
 *  An anonymous page/asset load gets neither the cookie nor any indication a token exists. */
export function authPlugin(deps: Partial<AuthDeps> = {}): Plugin {
  const { generateToken, logToken } = { ...defaultDeps, ...deps };
  const token = generateToken();
  logToken(token);
  const setSessionCookie = (res: ConnectResponse) =>
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`);
  const attach = (middlewares: {
    use: (fn: (req: ConnectRequest, res: ConnectResponse, next: () => void) => void) => void;
  }) => {
    middlewares.use((req, res, next) => {
      const bootstrap = handleBootstrapRequest(req.url, token);
      if (bootstrap) {
        if ("redirectTo" in bootstrap) {
          setSessionCookie(res);
          res.statusCode = 302;
          res.setHeader("Location", bootstrap.redirectTo);
          res.end("");
          return;
        }
        res.statusCode = bootstrap.status;
        res.end(bootstrap.body);
        return;
      }

      const rejection = handleAuthRequest(req.url, req.headers.cookie, token);
      if (rejection) {
        res.statusCode = rejection.status;
        res.setHeader("Content-Type", "application/json");
        res.end(rejection.body);
        return;
      }

      // Only re-stamp the cookie for a request that already presented it -- an anonymous page/asset
      // load (no cookie yet) falls through with NO Set-Cookie at all, closing the GHSA-v6v4-mh5m-5mqq
      // leak where `curl http://127.0.0.1:4174/` alone was enough to read a valid, replayable token.
      if (isAuthenticatedRequest(req.headers.cookie, token)) setSessionCookie(res);
      next();
    });
  };
  return {
    name: "loopover-miner-ui:auth",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
