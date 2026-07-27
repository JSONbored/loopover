import { describe, expect, it, vi } from "vitest";

// The render pipeline's best-effort DNS-resolution pin (#9044, shot.ts) does a real `node:dns/promises`
// lookup before navigating -- mocked here (same convention as test/unit/visual-shot.test.ts) so these
// route-wiring tests resolve instantly to a safe public address instead of making a real network call (which
// would be slow/flaky in a network-restricted sandbox and risks this file's 15s test timeout across the
// many-iteration ceiling test below).
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => ({ address: "93.184.216.34", family: 4 })),
}));

import { createApp } from "../../src/api/routes";
import { RateLimiter } from "../../src/auth/rate-limit";
import { mintShotRenderToken } from "../../src/review/visual/shot-render-token";
import { createTestEnv } from "../helpers/d1";

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

/** A REAL RateLimiter DO (not a stub), keyed by name so every call for the SAME key routes to the SAME
 *  instance -- mirrors real DurableObjectNamespace idFromName/get semantics closely enough to exercise
 *  actual enforcement, not just a canned response. */
function realRateLimiterNamespace(env: Env) {
  const instances = new Map<string, RateLimiter>();
  return {
    idFromName(name: string) {
      return name;
    },
    get(id: string) {
      let instance = instances.get(id);
      if (!instance) {
        instance = new RateLimiter(memoryDurableObjectState() as unknown as DurableObjectState, env);
        instances.set(id, instance);
      }
      // A real DurableObjectStub's .fetch(url, init) builds a Request and forwards it to the instance's own
      // fetch(request) override, which takes a single Request argument, not (url, init).
      return { fetch: (url: string, init?: RequestInit) => instance!.fetch(new Request(url, init)) };
    },
  };
}

const TARGET_URL = "https://preview.pages.dev/app";

describe("/loopover/shot route wiring (#9044 -- signed render token + global render ceiling)", () => {
  it("returns 404 when LOOPOVER_REVIEW_SCREENSHOTS is off, before any token/ceiling check runs", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request(`/loopover/shot?url=${encodeURIComponent(TARGET_URL)}`, {}, env);
    expect(res.status).toBe(404);
  });

  it("rejects the render mode outright when no token is present", async () => {
    const app = createApp();
    const env = createTestEnv({ LOOPOVER_REVIEW_SCREENSHOTS: "true" });
    const res = await app.request(`/loopover/shot?url=${encodeURIComponent(TARGET_URL)}`, {}, env);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "missing_or_invalid_shot_token" });
  });

  it("rejects a tampered token", async () => {
    const app = createApp();
    const env = createTestEnv({ LOOPOVER_REVIEW_SCREENSHOTS: "true" });
    const suffix = await mintShotRenderToken(env, TARGET_URL);
    const tampered = suffix.replace(/sig=[0-9a-f]+/, `sig=${"a".repeat(64)}`);
    const res = await app.request(`/loopover/shot?url=${encodeURIComponent(TARGET_URL)}&${tampered}`, {}, env);
    expect(res.status).toBe(403);
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
      const app = createApp();
      const env = createTestEnv({ LOOPOVER_REVIEW_SCREENSHOTS: "true" });
      const suffix = await mintShotRenderToken(env, TARGET_URL);
      vi.setSystemTime(new Date("2026-06-25T12:00:01.000Z")); // past the 24h TTL
      const res = await app.request(`/loopover/shot?url=${encodeURIComponent(TARGET_URL)}&${suffix}`, {}, env);
      expect(res.status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a token minted for a different url than the one being requested", async () => {
    const app = createApp();
    const env = createTestEnv({ LOOPOVER_REVIEW_SCREENSHOTS: "true" });
    const suffix = await mintShotRenderToken(env, "https://preview.pages.dev/some-other-page");
    const res = await app.request(`/loopover/shot?url=${encodeURIComponent(TARGET_URL)}&${suffix}`, {}, env);
    expect(res.status).toBe(403);
  });

  it("passes the token gate and reaches the pre-existing render pipeline for a validly minted token (degrades to 502 with no BROWSER binding configured -- proves it got past this layer, not that rendering itself succeeded)", async () => {
    const app = createApp();
    const env = createTestEnv({ LOOPOVER_REVIEW_SCREENSHOTS: "true" });
    const suffix = await mintShotRenderToken(env, TARGET_URL);
    const res = await app.request(`/loopover/shot?url=${encodeURIComponent(TARGET_URL)}&${suffix}`, {}, env);
    expect(res.status).toBe(502);
  });

  it("never requires a token for the ?key= (R2-serve) mode", async () => {
    const app = createApp();
    const env = createTestEnv({ LOOPOVER_REVIEW_SCREENSHOTS: "true" });
    const res = await app.request(`/loopover/shot?key=${encodeURIComponent("loopover/shots/missing.png")}`, {}, env);
    expect(res.status).toBe(404); // reached handleShot's R2 lookup (missing object) -- not blocked by a token check
  });

  it("never requires a token for a placeholder card", async () => {
    const app = createApp();
    const env = createTestEnv({ LOOPOVER_REVIEW_SCREENSHOTS: "true" });
    const res = await app.request("/loopover/shot?placeholder=loading", {}, env);
    expect(res.status).toBe(200);
  });

  it("REGRESSION (#9044): the fixed-key global ceiling throttles the render mode even with a fresh, validly-minted token and a rotating Cf-Connecting-Ip on every request", async () => {
    const baseEnv = createTestEnv({ LOOPOVER_REVIEW_SCREENSHOTS: "true" });
    const rateLimiter = realRateLimiterNamespace(baseEnv);
    const env = createTestEnv({ LOOPOVER_REVIEW_SCREENSHOTS: "true", RATE_LIMITER: rateLimiter as unknown as DurableObjectNamespace });
    const app = createApp();

    // SHOT_RENDER_GLOBAL_CONFIG's budget (30/60s) exhausted -- each iteration mints its OWN fresh token
    // (so the token gate itself never blocks) and forges a DIFFERENT Cf-Connecting-Ip (so the ordinary
    // per-identity `expensive` bucket never blocks either, since each identity gets its own fresh bucket).
    for (let i = 0; i < 30; i++) {
      const suffix = await mintShotRenderToken(env, TARGET_URL);
      const res = await app.request(`/loopover/shot?url=${encodeURIComponent(TARGET_URL)}&${suffix}`, { headers: { "cf-connecting-ip": `203.0.113.${i}` } }, env);
      expect(res.status).toBe(502); // reached the render pipeline every time -- not yet throttled
    }
    // The 31st request, with yet another rotated identity and a perfectly valid fresh token, is STILL
    // throttled: the fixed-key global ceiling doesn't care what identity or token the caller presents.
    const suffix = await mintShotRenderToken(env, TARGET_URL);
    const blocked = await app.request(`/loopover/shot?url=${encodeURIComponent(TARGET_URL)}&${suffix}`, { headers: { "cf-connecting-ip": "203.0.113.250" } }, env);
    expect(blocked.status).toBe(429);
  });
});
