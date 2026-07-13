import { afterEach, describe, expect, it, vi } from "vitest";
import { completeGitHubWebOAuth, createSessionFromGitHubToken, pollGitHubDeviceFlow, startGitHubDeviceFlow, startGitHubWebOAuth } from "../../src/auth/github-oauth";
import { enforceRateLimit, RateLimiter, routeClassForPath } from "../../src/auth/rate-limit";
import { authenticatePrivateToken, buildBrowserSessionCookie, createSessionForGitHubUser, extractCookieValue, isAuthorizedGitHubSessionLogin, isMcpActuationRepoAllowed, revokeSession, timingSafeEqual } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

describe("private-beta auth and rate limiting", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("authenticates static tokens and hashed session tokens without accepting revoked sessions", async () => {
    const env = createTestEnv();
    await expect(authenticatePrivateToken(env, env.LOOPOVER_API_TOKEN)).resolves.toMatchObject({ kind: "static", actor: "api" });
    await expect(authenticatePrivateToken(env, env.LOOPOVER_MCP_TOKEN)).resolves.toMatchObject({ kind: "static", actor: "mcp" });
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

    // Fail closed when the stored expiry is unparseable (NaN), not authenticate it as a never-expiring session.
    const malformed = await createSessionForGitHubUser(env, { login: "malformed-expiry-user" });
    await env.DB.prepare("update auth_sessions set expires_at = ? where login = ?").bind("not-a-date", "malformed-expiry-user").run();
    await expect(authenticatePrivateToken(env, malformed.token)).resolves.toBeNull();
  });

  it("authenticates static tokens supplied via a custom LOOPOVER_API_TOKEN/LOOPOVER_MCP_TOKEN override", async () => {
    const env = createTestEnv({ LOOPOVER_API_TOKEN: "new-api-token", LOOPOVER_MCP_TOKEN: "new-mcp-token" });
    await expect(authenticatePrivateToken(env, "new-api-token")).resolves.toMatchObject({ kind: "static", actor: "api" });
    await expect(authenticatePrivateToken(env, "new-mcp-token")).resolves.toMatchObject({ kind: "static", actor: "mcp" });
    // The default fixture values must no longer authenticate once overridden.
    await expect(authenticatePrivateToken(env, "test-api-token")).resolves.toBeNull();
  });

  it("scopes MCP static-token actuation to an explicit repo allowlist, denying by default (#2253)", () => {
    // Unset/empty ⇒ deny (fail closed — the shared LOOPOVER_MCP_TOKEN must not implicitly actuate everywhere).
    expect(isMcpActuationRepoAllowed(undefined, "owner/repo")).toBe(false);
    expect(isMcpActuationRepoAllowed("", "owner/repo")).toBe(false);
    expect(isMcpActuationRepoAllowed("   ", "owner/repo")).toBe(false);
    // An explicitly listed repo is allowed; a sibling repo NOT listed stays denied.
    expect(isMcpActuationRepoAllowed("owner/repo", "owner/repo")).toBe(true);
    expect(isMcpActuationRepoAllowed("owner/repo", "owner/other")).toBe(false);
    // Case-insensitive, and accepts whitespace OR comma-separated lists (matches parseGitHubLoginList's parse).
    expect(isMcpActuationRepoAllowed("Owner/Repo", "owner/repo")).toBe(true);
    expect(isMcpActuationRepoAllowed("owner/one,owner/two", "owner/two")).toBe(true);
    expect(isMcpActuationRepoAllowed("owner/one owner/two", "owner/two")).toBe(true);
    // `*`/`all` is an explicit operator opt-in to the old unscoped-trust behavior — never the unset default.
    expect(isMcpActuationRepoAllowed("*", "owner/anything")).toBe(true);
    expect(isMcpActuationRepoAllowed("all", "owner/anything")).toBe(true);
  });

  it("handles auth helper fallbacks for cookies, login lists, and token comparison", async () => {
    await expect(timingSafeEqual(undefined, "expected")).resolves.toBe(false);
    await expect(timingSafeEqual("short", "shorter")).resolves.toBe(false);
    const noAdminEnv = createTestEnv();
    delete (noAdminEnv as Partial<Env>).ADMIN_GITHUB_LOGINS;
    expect(isAuthorizedGitHubSessionLogin(noAdminEnv, "jsonbored")).toBe(false);

    const localhostCookie = buildBrowserSessionCookie("token", "http://localhost/v1/auth/session");
    expect(localhostCookie).toContain("HttpOnly");
    expect(localhostCookie).not.toContain("Secure");
    expect(buildBrowserSessionCookie("token", "http://127.0.0.1/v1/auth/session")).not.toContain("Secure");

    const malformedUrlCookie = buildBrowserSessionCookie("token", "not-a-url");
    expect(malformedUrlCookie).toContain("Secure");
    expect(extractCookieValue("gittensory_session=%E0%A4%A", "gittensory_session")).toBeUndefined();
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
    const invalidJson = await limiter.fetch(new Request("https://rate-limit/check", { method: "POST", body: "{" }));
    expect(invalidJson.status).toBe(400);
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
    expect(routeClassForPath("/v1/github/webhook")).toBe("strict");
    expect(routeClassForPath("/v1/orb/ingest")).toBe("strict"); // open telemetry ingest — abuse-capped per IP
    expect(routeClassForPath("/v1/auth/github/device/start")).toBe("strict");
    expect(routeClassForPath("/v1/local/branch-analysis")).toBe("expensive");
    expect(routeClassForPath("/loopover/shot")).toBe("expensive");
    expect(routeClassForPath("/v1/scoring/preview")).toBe("expensive");
    expect(routeClassForPath("/v1/upstream/status")).toBe("expensive");
    expect(routeClassForPath("/v1/contributors/jsonbored/decision-pack")).toBe("expensive");
    expect(routeClassForPath("/v1/app/miner-dashboard/refresh")).toBe("expensive");
    expect(routeClassForPath("/v1/contributors/jsonbored/open-pr-monitor")).toBe("expensive");
    expect(routeClassForPath("/v1/opportunities/find")).toBe("expensive");
    expect(routeClassForPath("/v1/issue-rag/retrieve")).toBe("expensive");
    expect(routeClassForPath("/v1/installations/999/repair/refresh")).toBe("expensive");
    expect(routeClassForPath("/v1/internal/jobs/generate-signal-snapshots")).toBe("expensive");
    expect(routeClassForPath("/v1/internal/jobs/build-contributor-decision-packs")).toBe("expensive");
    expect(routeClassForPath("/v1/internal/jobs/refresh-upstream-drift")).toBe("expensive");
    expect(routeClassForPath("/v1/internal/queue-intelligence")).toBe("expensive");
    // Maintainer BYOK config writes run PBKDF2 + an encrypted upsert; they are rate-limited as expensive.
    expect(routeClassForPath("/v1/repos/acme/widgets/ai-key")).toBe("expensive");
    expect(routeClassForPath("/v1/repos/acme/widgets/ai-review")).toBe("expensive");
    expect(routeClassForPath("/v1/repos/acme/widgets/linear-key")).toBe("expensive");
    expect(routeClassForPath("/v1/repos")).toBe("normal");
  });

  it("keys unvalidated bearer tokens by Cloudflare client IP", async () => {
    const observedKeys: string[] = [];
    const env = createTestEnv({ RATE_LIMITER: rateLimiterNamespace({ status: 200, body: {} }, observedKeys) as unknown as DurableObjectNamespace });

    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", {
          authorization: "Bearer random-token-one",
          "cf-connecting-ip": "203.0.113.9",
          "x-forwarded-for": "198.51.100.1",
        }),
        "strict",
      ),
    ).resolves.toBeNull();
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", {
          authorization: "Bearer random-token-two",
          "cf-connecting-ip": "203.0.113.9",
          "x-forwarded-for": "198.51.100.2",
        }),
        "strict",
      ),
    ).resolves.toBeNull();

    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toBe(observedKeys[1]);
    expect(observedKeys[0]).toMatch(/^strict:\/v1\/auth\/github\/session:ip:/);

    observedKeys.length = 0;
    await expect(
      enforceRateLimit(fakeContext(env, "/v1/repos", { authorization: "Bearer random-token", "cf-connecting-ip": "203.0.113.9" }), "normal"),
    ).resolves.toBeNull();
    await expect(
      enforceRateLimit(fakeContext(env, "/v1/repos", { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "cf-connecting-ip": "203.0.113.9" }), "normal"),
    ).resolves.toBeNull();
    expect(observedKeys[0]).toMatch(/^normal:\/v1\/repos:ip:/);
    expect(observedKeys[1]).toMatch(/^normal:\/v1\/repos:token:/);

    observedKeys.length = 0;
    await expect(enforceRateLimit(fakeContext(env, "/v1/public/github/repos/JSONbored/gittensory/stats", { "cf-connecting-ip": "203.0.113.9" }), "normal")).resolves.toBeNull();
    await expect(enforceRateLimit(fakeContext(env, "/v1/public/github/repos/Attacker/missing-one/stats", { "cf-connecting-ip": "203.0.113.9" }), "normal")).resolves.toBeNull();
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toBe(observedKeys[1]);
    expect(observedKeys[0]).toMatch(/^normal:\/v1\/public\/github\/repos\/:owner\/:repo\/stats:ip:/);
  });

  it("ignores proxy fallback headers when cf-connecting-ip is absent", async () => {
    const observedKeys: string[] = [];
    const env = rateLimitTestEnv({}, observedKeys);

    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({ "x-forwarded-for": "198.51.100.1" })),
        "strict",
      ),
    ).resolves.toBeNull();
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({ "x-forwarded-for": "198.51.100.2" })),
        "strict",
      ),
    ).resolves.toBeNull();
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toBe(observedKeys[1]);
    expect(observedKeys[0]).toMatch(/^strict:\/v1\/auth\/github\/session:ip:/);

    observedKeys.length = 0;
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({ "x-real-ip": "198.51.100.3", "x-forwarded-for": "198.51.100.2, 198.51.100.3" })),
        "strict",
      ),
    ).resolves.toBeNull();
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({ "x-real-ip": "203.0.113.44" })),
        "strict",
      ),
    ).resolves.toBeNull();
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toBe(observedKeys[1]);
  });

  it("does not treat spoofed cf-ray as trusted proxy proof", async () => {
    const observedKeys: string[] = [];
    const env = createTestEnv({
      RATE_LIMITER: rateLimiterNamespace({ status: 200, body: {} }, observedKeys) as unknown as DurableObjectNamespace,
    });

    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", { "cf-ray": "attacker-controlled", "x-forwarded-for": "198.51.100.1" }),
        "strict",
      ),
    ).resolves.toBeNull();
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", { "cf-ray": "attacker-controlled", "x-forwarded-for": "198.51.100.2" }),
        "strict",
      ),
    ).resolves.toBeNull();
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toBe(observedKeys[1]);
    expect(observedKeys[0]).toMatch(/^strict:\/v1\/auth\/github\/session:ip:/);
  });

  it("ignores malformed client address headers when building rate-limit keys", async () => {
    const observedKeys: string[] = [];
    const env = rateLimitTestEnv({}, observedKeys);

    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({
          "cf-connecting-ip": "not-an-ip",
          "x-real-ip": "198.51.100.2",
          "x-forwarded-for": "198.51.100.2, 198.51.100.3",
        })),
        "strict",
      ),
    ).resolves.toBeNull();
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({ "x-real-ip": "198.51.100.2" })),
        "strict",
      ),
    ).resolves.toBeNull();
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toBe(observedKeys[1]);

    observedKeys.length = 0;
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({
          "x-forwarded-for": "garbage, also-not-ip",
          "x-real-ip": "203.0.113.44",
        })),
        "strict",
      ),
    ).resolves.toBeNull();
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({ "x-real-ip": "203.0.113.44" })),
        "strict",
      ),
    ).resolves.toBeNull();
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toBe(observedKeys[1]);

    observedKeys.length = 0;
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", {
          "cf-connecting-ip": "999.999.999.999",
          "x-forwarded-for": "still-not-ip",
          "x-real-ip": "also-invalid",
        }),
        "strict",
      ),
    ).resolves.toBeNull();
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", {
          "x-forwarded-for": "attacker-controlled-bucket",
        }),
        "strict",
      ),
    ).resolves.toBeNull();
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toBe(observedKeys[1]);
    expect(observedKeys[0]).toMatch(/^strict:\/v1\/auth\/github\/session:ip:/);

    observedKeys.length = 0;
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", {
          "cf-connecting-ip": "203.0.113.9",
          "x-forwarded-for": "198.51.100.1",
          "x-real-ip": "198.51.100.99",
        }),
        "strict",
      ),
    ).resolves.toBeNull();
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({
          "x-forwarded-for": "not-an-ip, 198.51.100.55",
        })),
        "strict",
      ),
    ).resolves.toBeNull();
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({ "x-forwarded-for": "198.51.100.55" })),
        "strict",
      ),
    ).resolves.toBeNull();
    expect(observedKeys).toHaveLength(3);
    expect(observedKeys[0]).not.toBe(observedKeys[1]);
    expect(observedKeys[1]).toBe(observedKeys[2]);

    observedKeys.length = 0;
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({ "x-real-ip": "[2001:db8::1]" })),
        "strict",
      ),
    ).resolves.toBeNull();
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({ "x-real-ip": "2001:db8::1" })),
        "strict",
      ),
    ).resolves.toBeNull();
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toBe(observedKeys[1]);

    observedKeys.length = 0;
    await expect(enforceRateLimit(fakeContext(env, "/v1/auth/github/session"), "strict")).resolves.toBeNull();
    const unknownIpKey = observedKeys[0];

    observedKeys.length = 0;
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", trustedProxyHeaders({ "x-forwarded-for": "", "x-real-ip": "   " })),
        "strict",
      ),
    ).resolves.toBeNull();
    expect(observedKeys[0]).toBe(unknownIpKey);

    observedKeys.length = 0;
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", {
          "cf-connecting-ip": "1.2.3.abc",
          "x-forwarded-for": "256.0.0.1, 1.2.3",
          "x-real-ip": "1::2::3",
        }),
        "strict",
      ),
    ).resolves.toBeNull();
    expect(observedKeys[0]).toBe(unknownIpKey);

    observedKeys.length = 0;
    await expect(
      enforceRateLimit(
        fakeContext(env, "/v1/auth/github/session", {
          "x-forwarded-for": "1:2:3:4:5:6:7:8:9:0, xyz::1",
        }),
        "strict",
      ),
    ).resolves.toBeNull();
    expect(observedKeys[0]).toBe(unknownIpKey);
  });

  it("normalizes only valid Cloudflare client IP headers", async () => {
    const observedKeys: string[] = [];
    const env = rateLimitTestEnv({}, observedKeys);

    await expect(enforceRateLimit(fakeContext(env, "/v1/auth/github/session", { "cf-connecting-ip": " 203.0.113.9 " }), "strict")).resolves.toBeNull();
    const ipv4Key = observedKeys[0];

    observedKeys.length = 0;
    await expect(enforceRateLimit(fakeContext(env, "/v1/auth/github/session", { "cf-connecting-ip": "[2001:db8::1]" }), "strict")).resolves.toBeNull();
    await expect(enforceRateLimit(fakeContext(env, "/v1/auth/github/session", { "cf-connecting-ip": "2001:db8::1" }), "strict")).resolves.toBeNull();
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toBe(observedKeys[1]);
    expect(observedKeys[0]).not.toBe(ipv4Key);

    observedKeys.length = 0;
    await expect(enforceRateLimit(fakeContext(env, "/v1/auth/github/session"), "strict")).resolves.toBeNull();
    const unknownIpKey = observedKeys[0];

    for (const value of ["", "not-an-ip", "1.2.3", "256.0.0.1", "1::2::3", "1:2:3:4:5:6:7:8:9", "::"]) {
      observedKeys.length = 0;
      await expect(enforceRateLimit(fakeContext(env, "/v1/auth/github/session", { "cf-connecting-ip": value }), "strict")).resolves.toBeNull();
      expect(observedKeys[0]).toBe(unknownIpKey);
    }
  });

  it("enforces route limits with session and IP keys plus retry headers", async () => {
    const env = createTestEnv();
    const noLimiter = fakeContext(env, "/v1/repos/123/pulls/456", { authorization: "Bearer session-token" });
    await expect(enforceRateLimit(noLimiter, "normal")).resolves.toBeNull();

    const fallbackObservedKeys: string[] = [];
    const fallbackHeaders = fakeContext(
      rateLimitTestEnv({}, fallbackObservedKeys),
      "/v1/repos/JSONbored/gittensory",
      trustedProxyHeaders({ "x-real-ip": "198.51.100.3", "x-forwarded-for": "198.51.100.2, 198.51.100.3" }),
    );
    await expect(enforceRateLimit(fallbackHeaders, "normal")).resolves.toBeNull();
    expect(fallbackObservedKeys).toHaveLength(1);
    expect(fallbackObservedKeys[0]).toMatch(/^normal:\/v1\/repos\/JSONbored\/gittensory:ip:/);
    expect(fallbackHeaders.res.headers.get("x-ratelimit-limit")).toBe("120");
    expect(fallbackHeaders.res.headers.get("x-ratelimit-remaining")).toBe("120");
    expect(fallbackHeaders.res.headers.get("x-ratelimit-reset")).toBeNull();

    const malformedDecision = fakeContext(
      createTestEnv({ RATE_LIMITER: rateLimiterNamespace({ status: 200, body: "not-json" }) as unknown as DurableObjectNamespace }),
      "/v1/repos/JSONbored/gittensory",
    );
    await expect(enforceRateLimit(malformedDecision, "normal")).resolves.toBeNull();
    expect(malformedDecision.res.headers.get("x-ratelimit-limit")).toBe("120");
    expect(malformedDecision.res.headers.get("x-ratelimit-remaining")).toBe("120");

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
    const deniedWithToken = fakeContext(deniedWithTokenEnv, "/v1/local/branch-analysis", { authorization: `Bearer ${deniedWithTokenEnv.LOOPOVER_API_TOKEN}` });
    const deniedWithTokenResponse = await enforceRateLimit(deniedWithToken, "expensive");
    expect(deniedWithTokenResponse?.headers.get("retry-after")).toBe("17");
    expect(deniedWithTokenResponse?.headers.get("x-ratelimit-reset")).toBe("2026-05-25T00:03:00.000Z");
    const deniedWithoutReset = fakeContext(
      createTestEnv({
        RATE_LIMITER: rateLimiterNamespace({ status: 429, body: { limit: 20, remaining: 0 } }) as unknown as DurableObjectNamespace,
      }),
      "/v1/local/branch-analysis",
      { authorization: "Bearer session-token" },
    );
    const deniedWithoutResetResponse = await enforceRateLimit(deniedWithoutReset, "expensive");
    expect(deniedWithoutResetResponse?.headers.get("x-ratelimit-reset")).toBeNull();
    const tokenAudit = await deniedWithTokenEnv.DB.prepare("select actor, metadata_json from audit_events where event_type = ?").bind("rate_limit.denied").first<{
      actor: string;
      metadata_json: string;
    }>();
    expect(tokenAudit?.actor).toMatch(/^token:/);
    expect(JSON.parse(tokenAudit?.metadata_json ?? "{}")).toMatchObject({ retryAfterSeconds: 17 });
  });

  it("REGRESSION (#5000): fails OPEN when the rate-limit Durable Object itself throws, instead of crashing the request with a bare framework 500", async () => {
    const throwingLimiter = {
      idFromName(name: string) {
        return name;
      },
      get() {
        return {
          async fetch() {
            throw new Error("Durable Object reset");
          },
        };
      },
    };
    const env = createTestEnv({ RATE_LIMITER: throwingLimiter as unknown as DurableObjectNamespace });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(enforceRateLimit(fakeContext(env, "/v1/orb/token", { "cf-connecting-ip": "203.0.113.9" }), "strict")).resolves.toBeNull();

    expect(errors.mock.calls.some(([line]) => typeof line === "string" && line.includes("rate_limit_check_failed") && line.includes("\"routeClass\":\"strict\""))).toBe(true);
    errors.mockRestore();
  });

  it("REGRESSION (#5000): still fails open when the Durable Object rejects with a non-Error value", async () => {
    const throwingLimiter = {
      idFromName(name: string) {
        return name;
      },
      get() {
        return {
          async fetch() {
            // Deliberately a non-Error rejection -- exercises the `error instanceof Error` false branch in the fail-open catch below.
            throw "not an Error instance";
          },
        };
      },
    };
    const env = createTestEnv({ RATE_LIMITER: throwingLimiter as unknown as DurableObjectNamespace });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(enforceRateLimit(fakeContext(env, "/v1/orb/token", { "cf-connecting-ip": "203.0.113.10" }), "strict")).resolves.toBeNull();

    expect(errors.mock.calls.some(([line]) => typeof line === "string" && line.includes("rate_limit_check_failed") && line.includes("not an Error instance"))).toBe(true);
    errors.mockRestore();
  });

  it("REGRESSION (#5000): a failed rate_limit.denied audit write does not stop the 429 itself from reaching the caller", async () => {
    const deniedEnv = createTestEnv({ RATE_LIMITER: rateLimiterNamespace({ status: 429, body: { resetAt: "2026-05-25T00:04:00.000Z" } }) as unknown as DurableObjectNamespace });
    const realPrepare = deniedEnv.DB.prepare.bind(deniedEnv.DB);
    deniedEnv.DB.prepare = ((sql: string) => {
      if (/^insert into "?audit_events"?/i.test(sql)) throw new Error("poisoned query");
      return realPrepare(sql);
    }) as typeof deniedEnv.DB.prepare;
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await enforceRateLimit(fakeContext(deniedEnv, "/v1/local/branch-analysis", { "cf-connecting-ip": "203.0.113.44" }), "expensive");

    expect(response?.status).toBe(429);
    await expect(response?.json()).resolves.toMatchObject({ error: "rate_limited", routeClass: "expensive" });
    expect(warnings.mock.calls.some(([line]) => typeof line === "string" && line.includes("rate_limit_denied_audit_failed") && line.includes("poisoned query"))).toBe(true);
    warnings.mockRestore();
  });

  it("REGRESSION (#5000): still fails open on a non-Error audit-write rejection", async () => {
    const deniedEnv = createTestEnv({ RATE_LIMITER: rateLimiterNamespace({ status: 429, body: { resetAt: "2026-05-25T00:05:00.000Z" } }) as unknown as DurableObjectNamespace });
    const realPrepare = deniedEnv.DB.prepare.bind(deniedEnv.DB);
    deniedEnv.DB.prepare = ((sql: string) => {
      // Deliberately a non-Error throw -- exercises the `error instanceof Error` false branch in the fail-open catch below.
      if (/^insert into "?audit_events"?/i.test(sql)) throw "not an Error instance";
      return realPrepare(sql);
    }) as typeof deniedEnv.DB.prepare;
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await enforceRateLimit(fakeContext(deniedEnv, "/v1/local/branch-analysis", { "cf-connecting-ip": "203.0.113.45" }), "expensive");

    expect(response?.status).toBe(429);
    expect(warnings.mock.calls.some(([line]) => typeof line === "string" && line.includes("rate_limit_denied_audit_failed") && line.includes("not an Error instance"))).toBe(true);
    warnings.mockRestore();
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

    vi.stubGlobal("fetch", async () => new Response("{", { status: 502 }));
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

  it("starts and completes GitHub web OAuth with signed state", async () => {
    const env = createTestEnv({
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
      ADMIN_GITHUB_LOGINS: "jsonbored",
    });
    const started = await startGitHubWebOAuth(
      env,
      "https://gittensory-api.aethereal.dev/v1/auth/github/start",
      "https://loopover.ai/app/workbench",
    );
    expect(started.returnTo).toBe("https://loopover.ai/app/workbench");
    expect(started.authorizationUrl).toContain("https://github.com/login/oauth/authorize");
    expect(started.authorizationUrl).toContain("client_id=client-id");
    expect(started.authorizationUrl).toContain("redirect_uri=https%3A%2F%2Fapi.loopover.ai%2Fv1%2Fauth%2Fgithub%2Fcallback");

    await expect(
      startGitHubWebOAuth(createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id" }), "https://gittensory-api.aethereal.dev/v1/auth/github/start", undefined),
    ).rejects.toThrow(/not_configured/);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ access_token: "gh-token", scope: "read:user" });
      if (url === "https://api.github.com/user") return Response.json({ login: "jsonbored", id: 42 });
      return Response.json({});
    });
    await expect(
      completeGitHubWebOAuth(env, "https://gittensory-api.aethereal.dev/v1/auth/github/callback", {
        code: "code",
        state: started.state,
        cookieState: started.state,
      }),
    ).resolves.toMatchObject({ login: "jsonbored", scopes: ["read:user"], returnTo: "https://loopover.ai/app/workbench" });

    await expect(
      completeGitHubWebOAuth(env, "https://gittensory-api.aethereal.dev/v1/auth/github/callback", {
        code: "code",
        state: started.state,
        cookieState: "wrong-state",
      }),
    ).rejects.toThrow(/state_invalid/);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ error: "bad_verification_code", error_description: "bad code" });
      return Response.json({});
    });
    await expect(
      completeGitHubWebOAuth(env, "https://gittensory-api.aethereal.dev/v1/auth/github/callback", {
        code: "code",
        state: started.state,
        cookieState: started.state,
      }),
    ).rejects.toThrow(/bad code/);
  });

  it("normalizes GitHub web OAuth fallbacks and rejects malformed callback state", async () => {
    const env = createTestEnv({
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
      ADMIN_GITHUB_LOGINS: "jsonbored",
    });
    delete (env as Partial<Env>).PUBLIC_API_ORIGIN;
    delete (env as Partial<Env>).PUBLIC_SITE_ORIGIN;

    const invalidReturnTo = await startGitHubWebOAuth(env, "https://preview.example.workers.dev/v1/auth/github/start", "https://evil.example/app");
    expect(invalidReturnTo.returnTo).toBe("https://loopover.ai/app");
    expect(invalidReturnTo.authorizationUrl).toContain("redirect_uri=https%3A%2F%2Fpreview.example.workers.dev%2Fv1%2Fauth%2Fgithub%2Fcallback");

    const localhostReturnTo = await startGitHubWebOAuth(env, "https://preview.example.workers.dev/v1/auth/github/start", "http://localhost:5173/app");
    expect(localhostReturnTo.returnTo).toBe("http://localhost:5173/app");

    await expect(
      completeGitHubWebOAuth(createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id" }), "https://gittensory-api.aethereal.dev/v1/auth/github/callback", {
        code: "code",
        state: invalidReturnTo.state,
        cookieState: invalidReturnTo.state,
      }),
    ).rejects.toThrow(/not_configured/);

    await expect(
      completeGitHubWebOAuth(env, "https://preview.example.workers.dev/v1/auth/github/callback", {
        code: "code",
        state: "missing-signature",
        cookieState: "missing-signature",
      }),
    ).rejects.toThrow(/state_invalid/);

    await expect(
      completeGitHubWebOAuth(env, "https://preview.example.workers.dev/v1/auth/github/callback", {
        code: "code",
        state: "encoded.bad-signature",
        cookieState: "encoded.bad-signature",
      }),
    ).rejects.toThrow(/state_invalid/);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-31T00:00:00.000Z"));
      const started = await startGitHubWebOAuth(env, "https://preview.example.workers.dev/v1/auth/github/start", undefined);
      vi.setSystemTime(new Date("2026-05-31T00:11:00.000Z"));
      await expect(
        completeGitHubWebOAuth(env, "https://preview.example.workers.dev/v1/auth/github/callback", {
          code: "code",
          state: started.state,
          cookieState: started.state,
        }),
      ).rejects.toThrow(/state_invalid/);
    } finally {
      vi.useRealTimers();
    }

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({}, { status: 502 });
      return Response.json({});
    });
    await expect(
      completeGitHubWebOAuth(env, "https://preview.example.workers.dev/v1/auth/github/callback", {
        code: "code",
        state: invalidReturnTo.state,
        cookieState: invalidReturnTo.state,
      }),
    ).rejects.toThrow(/token_exchange_failed/);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return new Response("{", { status: 502 });
      return Response.json({});
    });
    await expect(
      completeGitHubWebOAuth(env, "https://preview.example.workers.dev/v1/auth/github/callback", {
        code: "code",
        state: invalidReturnTo.state,
        cookieState: invalidReturnTo.state,
      }),
    ).rejects.toThrow(/token_exchange_failed/);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({});
      return Response.json({});
    });
    await expect(
      completeGitHubWebOAuth(env, "https://preview.example.workers.dev/v1/auth/github/callback", {
        code: "code",
        state: invalidReturnTo.state,
        cookieState: invalidReturnTo.state,
      }),
    ).rejects.toThrow(/access_token_missing/);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ error: "bad_verification_code" });
      return Response.json({});
    });
    await expect(
      completeGitHubWebOAuth(env, "https://preview.example.workers.dev/v1/auth/github/callback", {
        code: "code",
        state: invalidReturnTo.state,
        cookieState: invalidReturnTo.state,
      }),
    ).rejects.toThrow(/bad_verification_code/);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/user") return Response.json({ login: "jsonbored" });
      return Response.json({});
    });
    await expect(createSessionFromGitHubToken(env, "github-token")).resolves.toMatchObject({ login: "jsonbored", scopes: [] });
  });

  it("a self-hoster's PUBLIC_SITE_ORIGIN is the sole allowed returnTo origin -- the cloud origin is no longer a bonus entry (#4615)", async () => {
    const env = createTestEnv({
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
      PUBLIC_SITE_ORIGIN: "https://my-instance.example.com",
    });

    // The self-hoster's own origin is accepted.
    const own = await startGitHubWebOAuth(env, "https://my-instance.example.com/v1/auth/github/start", "https://my-instance.example.com/app/workbench");
    expect(own.returnTo).toBe("https://my-instance.example.com/app/workbench");

    // The cloud gittensory.aethereal.dev origin is no longer accepted for THIS instance -- it falls back to
    // this instance's own /app, proving the dead literal is gone rather than merely redundant.
    const cloud = await startGitHubWebOAuth(env, "https://my-instance.example.com/v1/auth/github/start", "https://gittensory.aethereal.dev/app/workbench");
    expect(cloud.returnTo).toBe("https://my-instance.example.com/app");

    // Localhost dev origins remain accepted regardless of PUBLIC_SITE_ORIGIN.
    const local = await startGitHubWebOAuth(env, "https://my-instance.example.com/v1/auth/github/start", "http://localhost:5173/app");
    expect(local.returnTo).toBe("http://localhost:5173/app");
  });

  it("PUBLIC_SITE_ORIGIN_ALIASES lets a login started on a second live domain return to that same domain (#4762)", async () => {
    const env = createTestEnv({
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
      PUBLIC_SITE_ORIGIN: "https://gittensory.aethereal.dev",
      PUBLIC_SITE_ORIGIN_ALIASES: "https://loopover.ai, https://staging.loopover.ai",
    });

    // The primary PUBLIC_SITE_ORIGIN still works exactly as before.
    const primary = await startGitHubWebOAuth(env, "https://gittensory-api.aethereal.dev/v1/auth/github/start", "https://gittensory.aethereal.dev/app/workbench");
    expect(primary.returnTo).toBe("https://gittensory.aethereal.dev/app/workbench");

    // An aliased origin is accepted verbatim, not bounced to the primary origin's fallback.
    const alias = await startGitHubWebOAuth(env, "https://gittensory-api.aethereal.dev/v1/auth/github/start", "https://loopover.ai/app/workbench");
    expect(alias.returnTo).toBe("https://loopover.ai/app/workbench");

    // A second, comma-separated alias (with surrounding whitespace) is also accepted.
    const secondAlias = await startGitHubWebOAuth(env, "https://gittensory-api.aethereal.dev/v1/auth/github/start", "https://staging.loopover.ai/app");
    expect(secondAlias.returnTo).toBe("https://staging.loopover.ai/app");

    // An origin that is neither the primary nor an alias still falls back to the primary origin's /app.
    const untrusted = await startGitHubWebOAuth(env, "https://gittensory-api.aethereal.dev/v1/auth/github/start", "https://evil.example/app");
    expect(untrusted.returnTo).toBe("https://gittensory.aethereal.dev/app");

    // Unset PUBLIC_SITE_ORIGIN_ALIASES behaves exactly as before this var existed -- only the primary origin.
    const noAliases = createTestEnv({
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
      PUBLIC_SITE_ORIGIN: "https://gittensory.aethereal.dev",
    });
    delete (noAliases as Partial<Env>).PUBLIC_SITE_ORIGIN_ALIASES;
    const rejected = await startGitHubWebOAuth(noAliases, "https://gittensory-api.aethereal.dev/v1/auth/github/start", "https://loopover.ai/app/workbench");
    expect(rejected.returnTo).toBe("https://gittensory.aethereal.dev/app");
  });

  it("verifies the GitHub token audience before minting a session on the token-exchange path", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret" });
    const introspect = (appClientId: string | undefined) =>
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url === "https://api.github.com/applications/client-id/token") {
          return appClientId === undefined ? new Response("{", { status: 200 }) : Response.json({ app: { client_id: appClientId } });
        }
        if (url === "https://api.github.com/user") return Response.json({ login: "jsonbored", id: 42 });
        return Response.json({});
      });

    introspect("client-id");
    await expect(createSessionFromGitHubToken(env, "valid-token", {}, { verifyAppAudience: true })).resolves.toMatchObject({ login: "jsonbored" });

    introspect("someone-elses-app");
    await expect(createSessionFromGitHubToken(env, "foreign-token", {}, { verifyAppAudience: true })).rejects.toThrow(/audience_invalid/);

    introspect(undefined);
    await expect(createSessionFromGitHubToken(env, "unparseable-introspection", {}, { verifyAppAudience: true })).rejects.toThrow(/audience_invalid/);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString() === "https://api.github.com/applications/client-id/token" ? Response.json({}, { status: 404 }) : Response.json({}),
    );
    await expect(createSessionFromGitHubToken(env, "revoked-token", {}, { verifyAppAudience: true })).rejects.toThrow(/audience_invalid/);

    vi.stubGlobal("fetch", async () => Response.json({ login: "jsonbored", id: 42 }));
    await expect(
      createSessionFromGitHubToken(createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id" }), "no-secret", {}, { verifyAppAudience: true }),
    ).rejects.toThrow(/audience_invalid/);
    await expect(createSessionFromGitHubToken(createTestEnv(), "no-oauth", {}, { verifyAppAudience: true })).rejects.toThrow(/audience_invalid/);
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

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return new Response("{");
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

  it("creates GitHub OAuth sessions without granting operator authorization", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ login: "external-attacker", id: 99 }));
    await expect(createSessionFromGitHubToken(createTestEnv(), "attacker-token")).resolves.toMatchObject({ login: "external-attacker" });
    await expect(createSessionFromGitHubToken(createTestEnv({ ADMIN_GITHUB_LOGINS: "" }), "attacker-token")).resolves.toMatchObject({ login: "external-attacker" });

    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "jsonbored" });
    const { token } = await createSessionForGitHubUser(env, { login: "external-attacker", id: 99 });
    await expect(authenticatePrivateToken(env, token)).resolves.toMatchObject({ kind: "session", actor: "external-attacker" });
    expect(isAuthorizedGitHubSessionLogin(env, "external-attacker")).toBe(false);
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

function rateLimiterNamespace(decision: { status: number; body: Record<string, unknown> | string }, observedKeys?: string[]) {
  return {
    idFromName(name: string) {
      expect(name).toMatch(/^(strict|normal|expensive):/);
      observedKeys?.push(name);
      return name;
    },
    get() {
      return {
        async fetch(_url: string, init?: RequestInit) {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body ?? "{}"))).toEqual(expect.objectContaining({ key: expect.any(String), limit: expect.any(Number), windowSeconds: expect.any(Number) }));
          if (typeof decision.body === "string") return new Response(decision.body, { status: decision.status });
          return Response.json(decision.body, { status: decision.status });
        },
      };
    },
  };
}

function rateLimitTestEnv(overrides: Partial<Env> = {}, observedKeys?: string[]) {
  return createTestEnv({
    RATE_LIMITER: rateLimiterNamespace({ status: 200, body: {} }, observedKeys) as unknown as DurableObjectNamespace,
    ...overrides,
  });
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

const TEST_TRUSTED_PROXY = "198.51.100.99";

function trustedProxyHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const next = { ...headers };
  const chain = (next["x-forwarded-for"] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!chain.includes(TEST_TRUSTED_PROXY)) chain.push(TEST_TRUSTED_PROXY);
  next["x-forwarded-for"] = chain.join(", ");
  return next;
}
