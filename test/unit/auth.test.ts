import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionFromGitHubToken, pollGitHubDeviceFlow, startGitHubDeviceFlow } from "../../src/auth/github-oauth";
import { enforceRateLimit, RateLimiter, routeClassForPath } from "../../src/auth/rate-limit";
import { authenticatePrivateToken, createSessionForGitHubUser, revokeSession } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

describe("private-beta auth and rate limiting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("authenticates static tokens and hashed session tokens without accepting revoked sessions", async () => {
    const env = createTestEnv();
    await expect(authenticatePrivateToken(env, env.GITTENSORY_API_TOKEN)).resolves.toMatchObject({ kind: "static", actor: "api" });
    await expect(authenticatePrivateToken(env, env.GITTENSORY_MCP_TOKEN)).resolves.toMatchObject({ kind: "static", actor: "mcp" });
    await expect(authenticatePrivateToken(env, "wrong-token")).resolves.toBeNull();

    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { scopes: ["read:user"] });
    const identity = await authenticatePrivateToken(env, token);
    expect(identity).toMatchObject({ kind: "session", actor: "jsonbored" });
    await revokeSession(env, identity);
    await expect(authenticatePrivateToken(env, token)).resolves.toBeNull();
    await expect(revokeSession(env, null)).resolves.toBe(false);

    const expired = await createSessionForGitHubUser(env, { login: "expired-user" });
    await env.DB.prepare("update auth_sessions set expires_at = ? where login = ?").bind("2020-01-01T00:00:00.000Z", "expired-user").run();
    await expect(authenticatePrivateToken(env, expired.token)).resolves.toBeNull();
  });

  it("enforces burst limits inside the Durable Object bucket", async () => {
    const state = memoryDurableObjectState();
    const limiter = new RateLimiter(state as unknown as DurableObjectState, createTestEnv());
    const first = await limiter.fetch(new Request("https://rate-limit/check", { method: "POST", body: JSON.stringify({ key: "session:one", limit: 1, windowSeconds: 60 }) }));
    expect(first.status).toBe(200);

    const second = await limiter.fetch(new Request("https://rate-limit/check", { method: "POST", body: JSON.stringify({ key: "session:one", limit: 1, windowSeconds: 60 }) }));
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({ allowed: false, remaining: 0 });

    const invalid = await limiter.fetch(new Request("https://rate-limit/check", { method: "POST", body: "{}" }));
    expect(invalid.status).toBe(400);
  });

  it("resets Durable Object buckets after the configured window expires", async () => {
    const state = memoryDurableObjectState();
    const limiter = new RateLimiter(state as unknown as DurableObjectState, createTestEnv());
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);

    const first = await limiter.fetch(new Request("https://rate-limit/check", { method: "POST", body: JSON.stringify({ key: "session:reset", limit: 1, windowSeconds: 1 }) }));
    const second = await limiter.fetch(new Request("https://rate-limit/check", { method: "POST", body: JSON.stringify({ key: "session:reset", limit: 1, windowSeconds: 1 }) }));
    now.mockReturnValue(2_001);
    const reset = await limiter.fetch(new Request("https://rate-limit/check", { method: "POST", body: JSON.stringify({ key: "session:reset", limit: 1, windowSeconds: 1 }) }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(reset.status).toBe(200);
    await expect(reset.json()).resolves.toMatchObject({ allowed: true, remaining: 0 });
  });

  it("classifies rate-limit route costs", () => {
    expect(routeClassForPath("/v1/auth/github/device/start")).toBe("strict");
    expect(routeClassForPath("/v1/local/branch-analysis")).toBe("expensive");
    expect(routeClassForPath("/v1/scoring/preview")).toBe("expensive");
    expect(routeClassForPath("/v1/upstream/status")).toBe("expensive");
    expect(routeClassForPath("/v1/contributors/jsonbored/decision-pack")).toBe("expensive");
    expect(routeClassForPath("/v1/contributors/jsonbored/open-pr-monitor")).toBe("expensive");
    expect(routeClassForPath("/v1/internal/jobs/generate-signal-snapshots")).toBe("expensive");
    expect(routeClassForPath("/v1/internal/jobs/build-contributor-decision-packs")).toBe("expensive");
    expect(routeClassForPath("/v1/internal/jobs/refresh-upstream-drift")).toBe("expensive");
    expect(routeClassForPath("/v1/repos")).toBe("normal");
  });

  it("enforces route limits with session and IP keys plus retry headers", async () => {
    const env = createTestEnv();
    const noLimiter = fakeContext(env, "/v1/repos/123/pulls/456", { authorization: "Bearer session-token" });
    await expect(enforceRateLimit(noLimiter, "normal")).resolves.toBeNull();

    const fallbackHeaders = fakeContext(
      createTestEnv({ RATE_LIMITER: rateLimiterNamespace({ status: 200, body: {} }) as unknown as DurableObjectNamespace }),
      "/v1/repos/JSONbored/gittensory",
      { "x-forwarded-for": "198.51.100.2, 198.51.100.3" },
    );
    await expect(enforceRateLimit(fallbackHeaders, "normal")).resolves.toBeNull();
    expect(fallbackHeaders.res.headers.get("x-ratelimit-limit")).toBe("120");
    expect(fallbackHeaders.res.headers.get("x-ratelimit-remaining")).toBe("120");
    expect(fallbackHeaders.res.headers.get("x-ratelimit-reset")).toBeNull();

    const allowed = fakeContext(
      createTestEnv({ RATE_LIMITER: rateLimiterNamespace({ status: 200, body: { limit: 3, remaining: 2, resetAt: "2026-05-25T00:01:00.000Z" } }) as unknown as DurableObjectNamespace }),
      "/v1/repos/JSONbored/gittensory/pulls/123/reviewability",
      { authorization: "Bearer session-token" },
    );
    await expect(enforceRateLimit(allowed, "normal")).resolves.toBeNull();
    expect(allowed.res.headers.get("x-ratelimit-limit")).toBe("3");
    expect(allowed.res.headers.get("x-ratelimit-remaining")).toBe("2");
    expect(allowed.res.headers.get("x-ratelimit-reset")).toBe("2026-05-25T00:01:00.000Z");

    const deniedEnv = createTestEnv({ RATE_LIMITER: rateLimiterNamespace({ status: 429, body: { resetAt: "2026-05-25T00:02:00.000Z" } }) as unknown as DurableObjectNamespace });
    const denied = fakeContext(
      deniedEnv,
      "/v1/local/branch-analysis",
      { "cf-connecting-ip": "203.0.113.7" },
    );
    const response = await enforceRateLimit(denied, "expensive");
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
    await expect(response?.json()).resolves.toMatchObject({ error: "rate_limited", routeClass: "expensive", retryAfterSeconds: 60 });

    const audited = await deniedEnv.DB.prepare("select event_type, actor, outcome from audit_events where event_type = ?").bind("rate_limit.denied").all();
    expect(audited.results).toEqual(expect.arrayContaining([expect.objectContaining({ event_type: "rate_limit.denied", actor: "anonymous", outcome: "denied" })]));

    const deniedWithTokenEnv = createTestEnv({
      RATE_LIMITER: rateLimiterNamespace({ status: 429, body: { limit: 20, remaining: 0, retryAfterSeconds: 17, resetAt: "2026-05-25T00:03:00.000Z" } }) as unknown as DurableObjectNamespace,
    });
    const deniedWithToken = fakeContext(deniedWithTokenEnv, "/v1/local/branch-analysis", { authorization: "Bearer session-token" });
    const deniedWithTokenResponse = await enforceRateLimit(deniedWithToken, "expensive");
    expect(deniedWithTokenResponse?.headers.get("retry-after")).toBe("17");
    expect(deniedWithTokenResponse?.headers.get("x-ratelimit-reset")).toBe("2026-05-25T00:03:00.000Z");
    const tokenAudit = await deniedWithTokenEnv.DB.prepare("select actor, metadata_json from audit_events where event_type = ?").bind("rate_limit.denied").first<{
      actor: string;
      metadata_json: string;
    }>();
    expect(tokenAudit?.actor).toMatch(/^token:/);
    expect(JSON.parse(tokenAudit?.metadata_json ?? "{}")).toMatchObject({ retryAfterSeconds: 17 });
  });

  it("starts GitHub device flow and rejects malformed provider responses", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id" });
    vi.stubGlobal("fetch", async () =>
      Response.json({
        device_code: "device-code",
        user_code: "USER-CODE",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    );

    await expect(startGitHubDeviceFlow(env)).resolves.toMatchObject({ device_code: "device-code", user_code: "USER-CODE" });

    vi.stubGlobal("fetch", async () => Response.json({ error: "bad_verification_code", error_description: "bad" }));
    await expect(startGitHubDeviceFlow(env)).rejects.toThrow(/bad/);

    vi.stubGlobal("fetch", async () => Response.json({}, { status: 502 }));
    await expect(startGitHubDeviceFlow(env)).rejects.toThrow(/github_device_flow_start_failed/);

    vi.stubGlobal("fetch", async () => Response.json({ device_code: "missing" }));
    await expect(startGitHubDeviceFlow(env)).rejects.toThrow(/response_invalid/);
    await expect(startGitHubDeviceFlow(createTestEnv())).rejects.toThrow(/not_configured/);

    vi.stubGlobal("fetch", async () =>
      Response.json({
        device_code: "device-code",
        user_code: "USER-CODE",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
      }),
    );
    await expect(startGitHubDeviceFlow(env)).resolves.not.toHaveProperty("interval");
  });

  it("polls GitHub device flow and creates a session only after authorization", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", ADMIN_GITHUB_LOGINS: "jsonbored,scopefree" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ error: "authorization_pending", error_description: "waiting" });
      return Response.json({});
    });
    await expect(pollGitHubDeviceFlow(env, "device-code")).resolves.toMatchObject({ status: "authorization_pending" });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ access_token: "gh-token", scope: "read:user" });
      if (url === "https://api.github.com/user") return Response.json({ login: "jsonbored", id: 42 });
      return Response.json({});
    });
    await expect(pollGitHubDeviceFlow(env, "device-code")).resolves.toMatchObject({ login: "jsonbored", scopes: ["read:user"] });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ error: "slow_down", error_description: "slow down" });
      return Response.json({});
    });
    await expect(pollGitHubDeviceFlow(env, "device-code")).resolves.toMatchObject({ status: "slow_down" });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ error: "bad_verification_code", error_description: "bad code" });
      return Response.json({});
    });
    await expect(pollGitHubDeviceFlow(env, "device-code")).resolves.toMatchObject({ status: "bad_verification_code", message: "bad code" });
    await expect(env.DB.prepare("select outcome from audit_events where event_type = ? and detail = ?").bind("auth.github_device_poll", "bad_verification_code").first()).resolves.toMatchObject({ outcome: "error" });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ access_token: "gh-token" });
      if (url === "https://api.github.com/user") return Response.json({ login: "scopefree", id: 43 });
      return Response.json({});
    });
    await expect(pollGitHubDeviceFlow(env, "device-code")).resolves.toMatchObject({ login: "scopefree", scopes: [] });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({});
      return Response.json({});
    });
    await expect(pollGitHubDeviceFlow(env, "device-code")).rejects.toThrow(/access_token_missing/);
    await expect(pollGitHubDeviceFlow(createTestEnv(), "device-code")).rejects.toThrow(/not_configured/);
  });

  it("rejects invalid GitHub tokens when creating sessions", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async () => Response.json({ message: "bad credentials" }, { status: 401 }));
    await expect(createSessionFromGitHubToken(env, "bad-token")).rejects.toThrow(/github_user_validation_failed/);

    vi.stubGlobal("fetch", async () => Response.json({ login: "no-id-user" }));
    await expect(createSessionFromGitHubToken(createTestEnv({ ADMIN_GITHUB_LOGINS: "no-id-user" }), "valid-token")).resolves.toMatchObject({ login: "no-id-user", scopes: [] });
  });

  it("requires GitHub OAuth sessions to come from configured admin logins", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ login: "external-attacker", id: 99 }));
    await expect(createSessionFromGitHubToken(createTestEnv(), "attacker-token")).rejects.toThrow(/github_user_not_authorized/);
    await expect(createSessionFromGitHubToken(createTestEnv({ ADMIN_GITHUB_LOGINS: "" }), "attacker-token")).rejects.toThrow(/github_user_not_authorized/);

    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "jsonbored" });
    const { token } = await createSessionForGitHubUser(env, { login: "external-attacker", id: 99 });
    await expect(authenticatePrivateToken(env, token)).resolves.toBeNull();
  });
});

function memoryDurableObjectState() {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      async get(key: string) {
        return storage.get(key);
      },
      async put(key: string, value: unknown) {
        storage.set(key, value);
      },
    },
  };
}

function rateLimiterNamespace(decision: { status: number; body: Record<string, unknown> }) {
  return {
    idFromName(name: string) {
      expect(name).toMatch(/^(normal|expensive):/);
      return name;
    },
    get() {
      return {
        async fetch(_url: string, init?: RequestInit) {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body ?? "{}"))).toEqual(expect.objectContaining({ key: expect.any(String), limit: expect.any(Number), windowSeconds: expect.any(Number) }));
          return Response.json(decision.body, { status: decision.status });
        },
      };
    },
  };
}

function fakeContext(env: Env, path: string, headers: Record<string, string> = {}) {
  const responseHeaders = new Headers();
  return {
    env,
    req: {
      path,
      header(name: string) {
        return headers[name.toLowerCase()] ?? headers[name];
      },
    },
    res: { headers: responseHeaders },
    json(body: unknown, status: number, responseHeadersInit?: HeadersInit) {
      return Response.json(body, responseHeadersInit ? { status, headers: responseHeadersInit } : { status });
    },
  } as unknown as import("hono").Context<{ Bindings: Env }> & { res: { headers: Headers } };
}
