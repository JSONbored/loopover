import { describe, expect, it } from "vitest";

import { AUTH_BOOTSTRAP_PATH, authPlugin, handleAuthRequest, handleBootstrapRequest, isAuthenticatedRequest } from "../vite-auth";

const TOKEN = "deterministic-test-token";

describe("isAuthenticatedRequest (#4858)", () => {
  it("rejects a request with no Cookie header at all", () => {
    expect(isAuthenticatedRequest(undefined, TOKEN)).toBe(false);
  });

  it("rejects a Cookie header that never mentions the auth cookie", () => {
    expect(isAuthenticatedRequest("othercookie=x; another=y", TOKEN)).toBe(false);
  });

  it("skips a malformed cookie pair with no '=' separator, without throwing", () => {
    expect(isAuthenticatedRequest(`malformed; loopover_miner_ui_token=${TOKEN}`, TOKEN)).toBe(true);
  });

  it("skips a cookie pair with an empty name (leading '=')", () => {
    expect(isAuthenticatedRequest(`=novalue; loopover_miner_ui_token=${TOKEN}`, TOKEN)).toBe(true);
  });

  it("rejects the auth cookie when its value doesn't match the server's token", () => {
    expect(isAuthenticatedRequest("loopover_miner_ui_token=wrong-value", TOKEN)).toBe(false);
  });

  it("rejects the auth cookie when its value is a different length than the server's token", () => {
    // Exercises the length-mismatch short-circuit ahead of timingSafeEqual, which throws on unequal-length
    // buffers -- a shorter or longer guess must be rejected, not crash the request handler.
    expect(isAuthenticatedRequest("loopover_miner_ui_token=short", TOKEN)).toBe(false);
    expect(isAuthenticatedRequest(`loopover_miner_ui_token=${TOKEN}-and-then-some`, TOKEN)).toBe(false);
  });

  it("accepts the auth cookie when its value matches the server's token exactly", () => {
    expect(isAuthenticatedRequest(`loopover_miner_ui_token=${TOKEN}`, TOKEN)).toBe(true);
  });
});

describe("handleAuthRequest (#4858)", () => {
  it("falls through (null) for a request with no url", () => {
    expect(handleAuthRequest(undefined, undefined, TOKEN)).toBeNull();
  });

  it("falls through (null) for a non-/api/ request regardless of cookie state", () => {
    expect(handleAuthRequest("/", undefined, TOKEN)).toBeNull();
    expect(handleAuthRequest("/assets/index.js", undefined, TOKEN)).toBeNull();
  });

  it("falls through (null) for an authenticated /api/* request", () => {
    expect(handleAuthRequest("/api/portfolio-queue", `loopover_miner_ui_token=${TOKEN}`, TOKEN)).toBeNull();
  });

  it("returns a 401 JSON body for an unauthenticated /api/* request", () => {
    expect(handleAuthRequest("/api/portfolio-queue", undefined, TOKEN)).toEqual({
      status: 401,
      body: JSON.stringify({ error: "unauthenticated: missing or invalid local miner-ui session cookie" }),
    });
  });
});

describe("handleBootstrapRequest (GHSA-v6v4-mh5m-5mqq)", () => {
  it("falls through (null) for a request with no url", () => {
    expect(handleBootstrapRequest(undefined, TOKEN)).toBeNull();
  });

  it("falls through (null) for any path other than the bootstrap path", () => {
    expect(handleBootstrapRequest("/", TOKEN)).toBeNull();
    expect(handleBootstrapRequest("/api/portfolio-queue", TOKEN)).toBeNull();
  });

  it("redirects to / when the bootstrap path is visited with the correct token", () => {
    expect(handleBootstrapRequest(`${AUTH_BOOTSTRAP_PATH}?token=${TOKEN}`, TOKEN)).toEqual({ redirectTo: "/" });
  });

  it("returns a 404 (not a 401) for the bootstrap path with a missing token", () => {
    expect(handleBootstrapRequest(AUTH_BOOTSTRAP_PATH, TOKEN)).toEqual({ status: 404, body: "Not Found" });
  });

  it("returns a 404 for the bootstrap path with the wrong token", () => {
    expect(handleBootstrapRequest(`${AUTH_BOOTSTRAP_PATH}?token=wrong`, TOKEN)).toEqual({ status: 404, body: "Not Found" });
  });
});

type CapturedRequestHandler = (
  req: { url?: string; headers: { cookie?: string } },
  res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
  next: () => void,
) => void;

function captureMiddleware(deps: { generateToken?: () => string; logToken?: (token: string) => void } = { generateToken: () => TOKEN, logToken: () => {} }): CapturedRequestHandler {
  let captured: CapturedRequestHandler | undefined;
  const plugin = authPlugin({ logToken: () => {}, ...deps });
  const server = { middlewares: { use: (fn: CapturedRequestHandler) => (captured = fn) } };
  // @ts-expect-error -- the test double only implements the subset of Vite's ViteDevServer this plugin reads.
  plugin.configureServer(server);
  if (!captured) throw new Error("authPlugin did not register a middleware");
  return captured;
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let ended: string | undefined;
  return {
    res: {
      get statusCode() {
        return statusCode;
      },
      set statusCode(value: number) {
        statusCode = value;
      },
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      end: (body: string) => {
        ended = body;
      },
    },
    headers,
    getEnded: () => ended,
    getStatus: () => statusCode,
  };
}

describe("authPlugin (#4858, hardened for GHSA-v6v4-mh5m-5mqq)", () => {
  it("regression: NEVER stamps Set-Cookie on an unauthenticated, non-bootstrap request -- not even the initial page load", () => {
    // This is the exact vulnerability: an earlier version stamped Set-Cookie on every response that
    // wasn't itself rejected, including a plain unauthenticated `GET /`. That let ANY local process --
    // not just the intended browser -- read a valid, replayable session token off one unauthenticated
    // request (`curl http://127.0.0.1:4174/`), then use it against the mutating /api/* routes.
    const middleware = captureMiddleware();
    for (const url of ["/", "/index.html", "/assets/index.js", "/api/portfolio-queue"]) {
      const { res, headers } = fakeResponse();
      middleware({ url, headers: {} }, res, () => {});
      expect(headers["Set-Cookie"], `Set-Cookie must be absent for unauthenticated ${url}`).toBeUndefined();
    }
  });

  it("rejects an unauthenticated /api/* request with 401, never calls next(), and never leaks the token via Set-Cookie", () => {
    const middleware = captureMiddleware();
    const { res, headers, getEnded, getStatus } = fakeResponse();
    let calledNext = false;
    middleware({ url: "/api/portfolio-queue", headers: {} }, res, () => {
      calledNext = true;
    });
    expect(getStatus()).toBe(401);
    expect(JSON.parse(getEnded() ?? "{}")).toEqual({
      error: "unauthenticated: missing or invalid local miner-ui session cookie",
    });
    expect(calledNext).toBe(false);
    expect(headers["Set-Cookie"]).toBeUndefined();
  });

  it("lets an authenticated /api/* request fall through and re-stamps the same cookie", () => {
    const middleware = captureMiddleware();
    const { res, headers } = fakeResponse();
    let calledNext = false;
    middleware({ url: "/api/portfolio-queue", headers: { cookie: `loopover_miner_ui_token=${TOKEN}` } }, res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(true);
    expect(headers["Set-Cookie"]).toBe(`loopover_miner_ui_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
  });

  it("re-stamps the cookie on an already-authenticated non-/api/ request too (keeps the session rolling)", () => {
    const middleware = captureMiddleware();
    const { res, headers } = fakeResponse();
    let calledNext = false;
    middleware({ url: "/", headers: { cookie: `loopover_miner_ui_token=${TOKEN}` } }, res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(true);
    expect(headers["Set-Cookie"]).toBe(`loopover_miner_ui_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
  });

  it("mints the cookie and redirects to / when the bootstrap path is visited with the correct token", () => {
    const middleware = captureMiddleware();
    const { res, headers, getStatus } = fakeResponse();
    let calledNext = false;
    middleware({ url: `/__auth/bootstrap?token=${TOKEN}`, headers: {} }, res, () => {
      calledNext = true;
    });
    expect(getStatus()).toBe(302);
    expect(headers.Location).toBe("/");
    expect(headers["Set-Cookie"]).toBe(`loopover_miner_ui_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
    expect(calledNext).toBe(false);
  });

  it("404s the bootstrap path (never sets a cookie) when the token is missing or wrong", () => {
    const middleware = captureMiddleware();

    const missing = fakeResponse();
    middleware({ url: "/__auth/bootstrap", headers: {} }, missing.res, () => {});
    expect(missing.getStatus()).toBe(404);
    expect(missing.headers["Set-Cookie"]).toBeUndefined();

    const wrong = fakeResponse();
    middleware({ url: "/__auth/bootstrap?token=wrong", headers: {} }, wrong.res, () => {});
    expect(wrong.getStatus()).toBe(404);
    expect(wrong.headers["Set-Cookie"]).toBeUndefined();
  });

  it("uses deps.generateToken so a fixed test token is deterministic across requests", () => {
    const middleware = captureMiddleware({ generateToken: () => "fixed-token-123" });
    const { res } = fakeResponse();
    let calledNext = false;
    middleware({ url: "/api/ledgers", headers: { cookie: "loopover_miner_ui_token=fixed-token-123" } }, res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(true);
  });

  it("calls deps.logToken once with the generated token so an operator can complete the bootstrap flow", () => {
    const logged: string[] = [];
    authPlugin({ generateToken: () => "logged-token", logToken: (token) => logged.push(token) });
    expect(logged).toEqual(["logged-token"]);
  });

  it("uses console.log as the default logToken when no override is given", () => {
    const originalLog = console.log;
    const calls: unknown[][] = [];
    console.log = (...args: unknown[]) => calls.push(args);
    try {
      authPlugin({ generateToken: () => "console-logged-token" });
    } finally {
      console.log = originalLog;
    }
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("console-logged-token");
  });

  it("also attaches via configurePreviewServer for `vite preview`", () => {
    let captured: CapturedRequestHandler | undefined;
    const plugin = authPlugin({ logToken: () => {} });
    const server = { middlewares: { use: (fn: CapturedRequestHandler) => (captured = fn) } };
    // @ts-expect-error -- same partial test double as configureServer above.
    plugin.configurePreviewServer(server);
    expect(captured).toBeTypeOf("function");
  });
});
