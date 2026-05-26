import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionFromGitHubToken, pollGitHubDeviceFlow, startGitHubDeviceFlow } from "../../src/auth/github-oauth";
import { RateLimiter, routeClassForPath } from "../../src/auth/rate-limit";
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

  it("classifies rate-limit route costs", () => {
    expect(routeClassForPath("/v1/auth/github/device/start")).toBe("strict");
    expect(routeClassForPath("/v1/local/branch-analysis")).toBe("expensive");
    expect(routeClassForPath("/v1/contributors/jsonbored/decision-pack")).toBe("expensive");
    expect(routeClassForPath("/v1/internal/jobs/generate-signal-snapshots")).toBe("expensive");
    expect(routeClassForPath("/v1/repos")).toBe("normal");
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
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id" });
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
    await expect(createSessionFromGitHubToken(env, "valid-token")).resolves.toMatchObject({ login: "no-id-user", scopes: [] });
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
