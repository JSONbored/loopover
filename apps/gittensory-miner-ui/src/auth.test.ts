import { describe, expect, it } from "vitest";

import { authPlugin, handleAuthRequest, isAuthenticatedRequest } from "../vite-auth";

const TOKEN = "deterministic-test-token";

describe("isAuthenticatedRequest (#4858)", () => {
  it("rejects a request with no Cookie header at all", () => {
    expect(isAuthenticatedRequest(undefined, TOKEN)).toBe(false);
  });

  it("rejects a Cookie header that never mentions the auth cookie", () => {
    expect(isAuthenticatedRequest("othercookie=x; another=y", TOKEN)).toBe(false);
  });

  it("skips a malformed cookie pair with no '=' separator, without throwing", () => {
    expect(isAuthenticatedRequest(`malformed; gittensory_miner_ui_token=${TOKEN}`, TOKEN)).toBe(true);
  });

  it("skips a cookie pair with an empty name (leading '=')", () => {
    expect(isAuthenticatedRequest(`=novalue; gittensory_miner_ui_token=${TOKEN}`, TOKEN)).toBe(true);
  });

  it("rejects the auth cookie when its value doesn't match the server's token", () => {
    expect(isAuthenticatedRequest("gittensory_miner_ui_token=wrong-value", TOKEN)).toBe(false);
  });

  it("accepts the auth cookie when its value matches the server's token exactly", () => {
    expect(isAuthenticatedRequest(`gittensory_miner_ui_token=${TOKEN}`, TOKEN)).toBe(true);
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
    expect(handleAuthRequest("/api/portfolio-queue", `gittensory_miner_ui_token=${TOKEN}`, TOKEN)).toBeNull();
  });

  it("returns a 401 JSON body for an unauthenticated /api/* request", () => {
    expect(handleAuthRequest("/api/portfolio-queue", undefined, TOKEN)).toEqual({
      status: 401,
      body: JSON.stringify({ error: "unauthenticated: missing or invalid local miner-ui session cookie" }),
    });
  });
});

type CapturedRequestHandler = (
  req: { url?: string; headers: { cookie?: string } },
  res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
  next: () => void,
) => void;

function captureMiddleware(deps = { generateToken: () => TOKEN }): CapturedRequestHandler {
  let captured: CapturedRequestHandler | undefined;
  const plugin = authPlugin(deps);
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

describe("authPlugin (#4858)", () => {
  it("stamps the Set-Cookie header on a non-/api/ request that falls through (the initial page load)", () => {
    const middleware = captureMiddleware();
    const { res, headers } = fakeResponse();
    let calledNext = false;
    middleware({ url: "/", headers: {} }, res, () => {
      calledNext = true;
    });
    expect(headers["Set-Cookie"]).toBe(`gittensory_miner_ui_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
    expect(calledNext).toBe(true);
  });

  it("rejects an unauthenticated /api/* request with 401, never calls next(), and NEVER leaks the token via Set-Cookie", () => {
    // Regression test: an earlier version set Set-Cookie on every response BEFORE checking auth, so an
    // unauthenticated caller could read the valid token straight off this 401's own headers and replay it --
    // completely defeating the mechanism. The token must only ever reach a caller that is already
    // authenticated, or a non-/api/* (page/asset) request.
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
    middleware({ url: "/api/portfolio-queue", headers: { cookie: `gittensory_miner_ui_token=${TOKEN}` } }, res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(true);
    expect(headers["Set-Cookie"]).toBe(`gittensory_miner_ui_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
  });

  it("uses deps.generateToken so a fixed test token is deterministic across requests", () => {
    const middleware = captureMiddleware({ generateToken: () => "fixed-token-123" });
    const { res } = fakeResponse();
    let calledNext = false;
    middleware({ url: "/api/ledgers", headers: { cookie: "gittensory_miner_ui_token=fixed-token-123" } }, res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(true);
  });

  it("also attaches via configurePreviewServer for `vite preview`", () => {
    let captured: CapturedRequestHandler | undefined;
    const plugin = authPlugin();
    const server = { middlewares: { use: (fn: CapturedRequestHandler) => (captured = fn) } };
    // @ts-expect-error -- same partial test double as configureServer above.
    plugin.configurePreviewServer(server);
    expect(captured).toBeTypeOf("function");
  });
});
