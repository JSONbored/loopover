import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneNotConfiguredError,
  createTenant,
  destroyTenant,
  isControlPlaneConfigured,
  listTenants,
  resolveControlPlane,
  setTenantOrbInstallation,
} from "../../src/orb/control-plane-client";

// #9522: the Worker's admin client for the hosted control plane. Every call FAILS LOUD on purpose --
// tenant create/destroy are deliberate admin actions, so unreachable/non-2xx/malformed must never be
// mistaken for success. These pin that posture, and the "not configured" answer that precedes it.

function env(overrides: Record<string, string | undefined> = {}): Env {
  return { LOOPOVER_CONTROL_PLANE_URL: "https://cp.example/", LOOPOVER_CONTROL_PLANE_ADMIN_TOKEN: "admin-tok", ...overrides } as unknown as Env;
}

function respondWith(body: unknown, init: { status?: number; malformed?: boolean } = {}) {
  return vi.fn(async () =>
    init.malformed
      ? new Response("not json", { status: init.status ?? 200, headers: { "content-type": "text/plain" } })
      : new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json" } }),
  );
}

describe("resolveControlPlane", () => {
  it("strips trailing slashes so a configured URL with one does not double up on the path", () => {
    expect(resolveControlPlane(env())).toEqual({ baseUrl: "https://cp.example", token: "admin-tok" });
  });

  it.each([
    ["no URL", { LOOPOVER_CONTROL_PLANE_URL: undefined }],
    ["no token", { LOOPOVER_CONTROL_PLANE_ADMIN_TOKEN: undefined }],
    ["a blank URL", { LOOPOVER_CONTROL_PLANE_URL: "   " }],
    ["a blank token", { LOOPOVER_CONTROL_PLANE_ADMIN_TOKEN: "  " }],
  ])("returns null with %s — a caller answers 'not configured' rather than erroring", (_label, overrides) => {
    expect(resolveControlPlane(env(overrides))).toBeNull();
    expect(isControlPlaneConfigured(env(overrides))).toBe(false);
  });

  it("reports configured when both halves are present", () => {
    expect(isControlPlaneConfigured(env())).toBe(true);
  });
});

describe("createTenant", () => {
  it("POSTs the tenant body with the admin bearer", async () => {
    const fetchImpl = respondWith({ name: "acme", state: "provisioning" });
    const record = await createTenant(env(), { name: "acme", product: "orb", orbInstallationId: 42 }, { fetchImpl });
    expect(record).toEqual({ name: "acme", state: "provisioning" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cp.example/v1/tenants");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer admin-tok");
    expect(JSON.parse(init.body as string)).toEqual({ name: "acme", product: "orb", orbInstallationId: 42 });
  });

  it("throws ControlPlaneNotConfiguredError before making any request when unconfigured", async () => {
    const fetchImpl = respondWith({});
    await expect(createTenant(env({ LOOPOVER_CONTROL_PLANE_URL: undefined }), { name: "a", product: "ams" }, { fetchImpl })).rejects.toBeInstanceOf(
      ControlPlaneNotConfiguredError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws with the status on a non-2xx, and does NOT leak the operator-adjacent body", async () => {
    const fetchImpl = respondWith({ error: "tenant_exists", secretish: "do-not-echo" }, { status: 409 });
    await expect(createTenant(env(), { name: "a", product: "ams" }, { fetchImpl })).rejects.toThrow("control plane returned http_409 for POST /v1/tenants");
    await expect(createTenant(env(), { name: "a", product: "ams" }, { fetchImpl })).rejects.not.toThrow(/do-not-echo/);
  });

  it("throws when the transport itself fails, naming the method and path", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(createTenant(env(), { name: "a", product: "ams" }, { fetchImpl })).rejects.toThrow(
      "control plane unreachable for POST /v1/tenants: ECONNREFUSED",
    );
  });

  it("throws on a 2xx whose body is not an object — success is not assumed from the status alone", async () => {
    const fetchImpl = respondWith(null, { malformed: true });
    await expect(createTenant(env(), { name: "a", product: "ams" }, { fetchImpl })).rejects.toThrow("malformed response");
  });

  it("honors an explicit request timeout", async () => {
    const fetchImpl = respondWith({ ok: true });
    await createTenant(env(), { name: "a", product: "ams" }, { fetchImpl, requestTimeoutMs: 25 });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeDefined();
  });

  it("falls back to the global fetch when no fetchImpl is injected", async () => {
    // The `?? fetch` default is the branch every real call site takes; only tests pass an impl.
    const globalFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", globalFetch);
    try {
      await expect(createTenant(env(), { name: "a", product: "ams" })).resolves.toEqual({ ok: true });
      expect(globalFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omits an undefined optional rather than sending it as null", async () => {
    const fetchImpl = respondWith({ ok: true });
    await createTenant(env(), { name: "a", product: "ams" }, { fetchImpl });
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ name: "a", product: "ams" });
  });
});

describe("listTenants", () => {
  it("GETs with no body", async () => {
    const fetchImpl = respondWith({ tenants: [] });
    await listTenants(env(), { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cp.example/v1/tenants");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
});

describe("setTenantOrbInstallation", () => {
  it("PATCHes the orb-installation route with product=orb pinned in the query", async () => {
    const fetchImpl = respondWith({ ok: true });
    await setTenantOrbInstallation(env(), { name: "acme corp", orbInstallationId: 7 }, { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The name is encoded: a tenant name with a space must not split the path.
    expect(url).toBe("https://cp.example/v1/tenants/acme%20corp/orb-installation?product=orb");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ orbInstallationId: 7 });
  });
});

describe("destroyTenant", () => {
  it("DELETEs with the product in the query, since the registry keys by product:name", async () => {
    const fetchImpl = respondWith({ ok: true });
    await destroyTenant(env(), { name: "acme", product: "ams" }, { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cp.example/v1/tenants/acme?product=ams");
    expect(init.method).toBe("DELETE");
  });
});
