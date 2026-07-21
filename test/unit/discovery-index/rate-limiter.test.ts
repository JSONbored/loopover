import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryIndexRateLimiter, enforceDiscoveryIndexRateLimit, RATE_LIMIT, RATE_LIMIT_WINDOW_SECONDS } from "../../../packages/discovery-index/src/rate-limiter";

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

function limiter() {
  const state = memoryDurableObjectState();
  return new DiscoveryIndexRateLimiter(state as unknown as DurableObjectState, {} as Env);
}

function checkRequest(body: unknown) {
  return new Request("https://rate-limit/check", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("DiscoveryIndexRateLimiter (DO)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within the limit and denies the one that exceeds it", async () => {
    const limit = limiter();
    const first = await limit.fetch(checkRequest({ key: "ip:1.1.1.1", limit: 1, windowSeconds: 60 }));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ allowed: true, remaining: 0 });

    const second = await limit.fetch(checkRequest({ key: "ip:1.1.1.1", limit: 1, windowSeconds: 60 }));
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({ allowed: false, remaining: 0 });
  });

  it("tracks separate buckets per key independently", async () => {
    const limit = limiter();
    await limit.fetch(checkRequest({ key: "ip:1.1.1.1", limit: 1, windowSeconds: 60 }));
    const otherIp = await limit.fetch(checkRequest({ key: "ip:2.2.2.2", limit: 1, windowSeconds: 60 }));
    expect(otherIp.status).toBe(200);
  });

  it("resets the bucket once the window expires", async () => {
    const limit = limiter();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    await limit.fetch(checkRequest({ key: "ip:reset", limit: 1, windowSeconds: 1 }));
    const stillLimited = await limit.fetch(checkRequest({ key: "ip:reset", limit: 1, windowSeconds: 1 }));
    expect(stillLimited.status).toBe(429);

    now.mockReturnValue(2_001);
    const afterReset = await limit.fetch(checkRequest({ key: "ip:reset", limit: 1, windowSeconds: 1 }));
    expect(afterReset.status).toBe(200);
    await expect(afterReset.json()).resolves.toMatchObject({ allowed: true });
  });

  it("rejects a request missing key/limit/windowSeconds as 400, and unparseable JSON as 400", async () => {
    const limit = limiter();
    await expect(limit.fetch(checkRequest({}))).resolves.toMatchObject({ status: 400 });
    await expect(limit.fetch(checkRequest({ key: "ip:x" }))).resolves.toMatchObject({ status: 400 }); // missing limit/windowSeconds
    await expect(limit.fetch(checkRequest({ key: "ip:x", limit: 1 }))).resolves.toMatchObject({ status: 400 }); // missing windowSeconds
    await expect(limit.fetch(checkRequest("{"))).resolves.toMatchObject({ status: 400 }); // unparseable
  });
});

function fakeNamespace(decision: { status: number; body: Record<string, unknown> | string }, observedKeys?: string[]) {
  return {
    idFromName(name: string) {
      observedKeys?.push(name);
      return name;
    },
    get() {
      return {
        async fetch(_url: string, init?: RequestInit) {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body ?? "{}"))).toEqual(
            expect.objectContaining({ key: expect.any(String), limit: RATE_LIMIT, windowSeconds: RATE_LIMIT_WINDOW_SECONDS }),
          );
          if (typeof decision.body === "string") return new Response(decision.body, { status: decision.status });
          return Response.json(decision.body, { status: decision.status });
        },
      };
    },
  };
}

describe("enforceDiscoveryIndexRateLimit", () => {
  it("returns null (pass-through) when the namespace allows the request", async () => {
    const namespace = fakeNamespace({ status: 200, body: { allowed: true, remaining: 59, retryAfterSeconds: 60 } });
    const request = new Request("https://discovery-index/v1/discovery-index/query", { headers: { "cf-connecting-ip": "9.9.9.9" } });
    await expect(enforceDiscoveryIndexRateLimit(request, namespace as unknown as DurableObjectNamespace<DiscoveryIndexRateLimiter>)).resolves.toBeNull();
  });

  it("returns a 429 with a retry-after header when the namespace denies the request", async () => {
    const namespace = fakeNamespace({ status: 429, body: { allowed: false, remaining: 0, retryAfterSeconds: 42 } });
    const request = new Request("https://discovery-index/v1/discovery-index/query", { headers: { "cf-connecting-ip": "9.9.9.9" } });
    const response = await enforceDiscoveryIndexRateLimit(request, namespace as unknown as DurableObjectNamespace<DiscoveryIndexRateLimiter>);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("42");
    await expect(response?.json()).resolves.toMatchObject({ error: "rate_limited", retryAfterSeconds: 42 });
  });

  it("keys the bucket by cf-connecting-ip, falling back to unknown-ip when the header is absent", async () => {
    const observedKeys: string[] = [];
    const namespace = fakeNamespace({ status: 200, body: { allowed: true, remaining: 1, retryAfterSeconds: 60 } }, observedKeys);
    await enforceDiscoveryIndexRateLimit(new Request("https://discovery-index/x", { headers: { "cf-connecting-ip": "5.6.7.8" } }), namespace as unknown as DurableObjectNamespace<DiscoveryIndexRateLimiter>);
    await enforceDiscoveryIndexRateLimit(new Request("https://discovery-index/x"), namespace as unknown as DurableObjectNamespace<DiscoveryIndexRateLimiter>);
    expect(observedKeys).toEqual(["ip:5.6.7.8", "ip:unknown-ip"]);
  });

  it("fails open (returns null) when the Durable Object call throws an Error", async () => {
    const namespace = {
      idFromName: () => "x",
      get: () => ({
        fetch() {
          throw new Error("durable object unavailable");
        },
      }),
    };
    const request = new Request("https://discovery-index/v1/discovery-index/query", { headers: { "cf-connecting-ip": "9.9.9.9" } });
    await expect(enforceDiscoveryIndexRateLimit(request, namespace as unknown as DurableObjectNamespace<DiscoveryIndexRateLimiter>)).resolves.toBeNull();
  });

  it("fails open (returns null) when the Durable Object call throws a non-Error value", async () => {
    const namespace = {
      idFromName: () => "x",
      get: () => ({
        fetch() {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error branch deliberately
          throw "durable object unavailable (string throw)";
        },
      }),
    };
    const request = new Request("https://discovery-index/v1/discovery-index/query", { headers: { "cf-connecting-ip": "9.9.9.9" } });
    await expect(enforceDiscoveryIndexRateLimit(request, namespace as unknown as DurableObjectNamespace<DiscoveryIndexRateLimiter>)).resolves.toBeNull();
  });
});
