import { randomBytes } from "node:crypto";
import type { Plugin } from "vite";

// Local miner-ui API auth (#4858): the miner-ui's /api/* endpoints previously relied on undocumented, implicit
// loopback-only trust -- and even that was inconsistent (vite-run-state-api.ts's own isLoopbackAddress gated
// only ONE of the three API plugins; vite-portfolio-queue-api.ts and vite-ledgers-api.ts had no gate at all).
// Neither is real authentication: loopback-IP checks don't stop another local process, or a malicious page the
// user has open in the SAME browser, from hitting the loopback API.
//
// This adds a minimal-but-real mechanism instead of touching each API file individually: a random token
// generated ONCE per dev-server process, delivered to the browser as a same-origin HttpOnly SameSite=Strict
// cookie on every response the caller is authorized to receive (so the very first page load already carries
// it going forward -- NOT on an unauthenticated /api/* request's own 401, which must never leak the token it
// is rejecting the caller for lacking), and required on every /api/* request thereafter. HttpOnly keeps it
// unreachable from any XSS in the SPA itself; SameSite=Strict
// means a cross-origin page -- including one from a DNS-rebinding attack, which resolves an ATTACKER-CONTROLLED
// hostname to 127.0.0.1 rather than reusing this dev server's own origin -- never has it attached automatically
// by the browser. Because it rides on the browser's own cookie jar, no client-side fetch call needs to change:
// the browser attaches it automatically to every same-origin request, including the existing fetchPortfolioQueue/
// fetchLedgers/fetchRunState calls.
//
// Registered as the FIRST plugin in vite.config.ts so its middleware runs before runStateApiPlugin/
// portfolioQueueApiPlugin/ledgersApiPlugin's own middlewares in the Connect chain: an unauthenticated /api/*
// request never reaches any of them. This also means any FUTURE /api/* endpoint (e.g. a write action) is
// covered automatically, with no per-endpoint auth wiring required.

const COOKIE_NAME = "loopover_miner_ui_token";

export type AuthDeps = {
  /** Injectable so tests get a deterministic token instead of a real random one. */
  generateToken: () => string;
};

const defaultDeps: AuthDeps = {
  generateToken: () => randomBytes(24).toString("hex"),
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

/** True when the incoming request carries the server's own auth cookie. Exported so the plugin's request
 *  handling can be exercised directly in tests without a real HTTP server. */
export function isAuthenticatedRequest(cookieHeader: string | undefined, token: string): boolean {
  return parseCookieHeader(cookieHeader)[COOKIE_NAME] === token;
}

/** The request handler, factored out of the Vite plugin shape so tests drive it directly (mirrors the sibling
 *  API files' handleXRequest pattern). Returns the 401 body when an /api/* request lacks a valid cookie, or
 *  null when the request should fall through to the next middleware (either it's authenticated, or it isn't
 *  an /api/* request at all and only needs the Set-Cookie header, applied by the caller). */
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

/** Vite dev/preview middleware: generates one token per process and (a) rejects any /api/* request that
 *  doesn't present it, before (b) stamping the cookie onto a response that's allowed to proceed. The ORDER
 *  matters: handleAuthRequest returns non-null (a rejection) ONLY for an unauthenticated /api/* request, so
 *  the Set-Cookie header must never be set on that response -- otherwise the token itself would ride along
 *  with the very 401 that was supposed to deny the caller, letting anyone who can reach the loopback port
 *  read the token off a single unauthenticated request and replay it, defeating the whole mechanism. Every
 *  request that reaches the setHeader call below is either already authenticated or isn't an /api/* request
 *  at all (the initial page/asset load a real browser session is meant to obtain the cookie from). */
export function authPlugin(deps: AuthDeps = defaultDeps): Plugin {
  const token = deps.generateToken();
  const attach = (middlewares: {
    use: (
      fn: (
        req: { url?: string; headers: { cookie?: string } },
        res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
        next: () => void,
      ) => void,
    ) => void;
  }) => {
    middlewares.use((req, res, next) => {
      const rejection = handleAuthRequest(req.url, req.headers.cookie, token);
      if (rejection) {
        res.statusCode = rejection.status;
        res.setHeader("Content-Type", "application/json");
        res.end(rejection.body);
        return;
      }
      res.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`);
      next();
    });
  };
  return {
    name: "gittensory-miner-ui:auth",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
