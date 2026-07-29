import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantRecord } from "@loopover/contract/control-plane";

import {
  CONTROL_PLANE_ADMIN_TOKEN_FLAG,
  CONTROL_PLANE_FLAG,
  CONTROL_PLANE_URL_FLAG,
  createTenant,
  destroyTenant,
  isControlPlaneEnabled,
  listTenants,
} from "../../packages/loopover-miner/lib/tenant-client";
import {
  parseTenantCreateArgs,
  parseTenantListArgs,
  parseTenantNameArgs,
  runTenantCli,
  runTenantCreate,
  runTenantDestroy,
  runTenantList,
} from "../../packages/loopover-miner/lib/tenant-cli";

const ENABLED_ENV = {
  [CONTROL_PLANE_FLAG]: "true",
  [CONTROL_PLANE_URL_FLAG]: "https://control.example.internal",
  [CONTROL_PLANE_ADMIN_TOKEN_FLAG]: "admin-secret",
};

let logs: string[] = [];
let errs: string[] = [];

function captureConsole() {
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg));
  });
  vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
    errs.push(String(msg));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("isControlPlaneEnabled (#7275)", () => {
  it("defaults to disabled when unset", () => {
    expect(isControlPlaneEnabled({})).toBe(false);
  });

  it("accepts the documented truthy-string convention, rejects anything else", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(isControlPlaneEnabled({ [CONTROL_PLANE_FLAG]: value })).toBe(true);
    }
    for (const value of ["0", "false", "no", "off", "", "  "]) {
      expect(isControlPlaneEnabled({ [CONTROL_PLANE_FLAG]: value })).toBe(false);
    }
  });
});

describe("tenant-client fail-loud preconditions (#7275)", () => {
  it("throws when the plane is disabled, without touching fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(createTenant("acme", { env: {}, fetchImpl })).rejects.toThrow(/control plane disabled/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when the plane is enabled but no URL is configured", async () => {
    const fetchImpl = vi.fn();
    await expect(listTenants({ env: { [CONTROL_PLANE_FLAG]: "true" }, fetchImpl })).rejects.toThrow(/URL unconfigured/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when the admin token is not configured", async () => {
    const fetchImpl = vi.fn();
    await expect(
      destroyTenant("acme", {
        env: { [CONTROL_PLANE_FLAG]: "true", [CONTROL_PLANE_URL_FLAG]: "https://control.example.internal" },
        fetchImpl,
      }),
    ).rejects.toThrow(/admin token unconfigured/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createTenant (#7275)", () => {
  it("POSTs the name + default product with a bearer header and returns the record verbatim", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://control.example.internal/v1/tenants");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer admin-secret");
      expect(JSON.parse(String(init.body))).toEqual({ name: "acme", product: "ams" });
      return Response.json({ tenant: { name: "acme" }, product: "ams", state: "provisioning" });
    });
    const record = await createTenant("acme", { env: ENABLED_ENV, fetchImpl });
    expect(record).toEqual({ tenant: { name: "acme" }, product: "ams", state: "provisioning" });
  });

  it("passes an explicit product through, and trims a URL's trailing slashes", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://control.example.internal/v1/tenants");
      expect(JSON.parse(String(init.body))).toEqual({ name: "acme", product: "widgets" });
      return Response.json({ tenant: { name: "acme" }, product: "widgets", state: "provisioning" });
    });
    await createTenant("acme", {
      env: { ...ENABLED_ENV, [CONTROL_PLANE_URL_FLAG]: "https://control.example.internal///" },
      fetchImpl,
      product: "widgets",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default product when product is blank/whitespace", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({ name: "acme", product: "ams" });
      return Response.json({ tenant: { name: "acme" }, product: "ams", state: "provisioning" });
    });
    await createTenant("acme", { env: ENABLED_ENV, fetchImpl, product: "   " });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails loud on a non-2xx response", async () => {
    const fetchImpl = async () => new Response("nope", { status: 409 });
    await expect(createTenant("acme", { env: ENABLED_ENV, fetchImpl })).rejects.toThrow(/http_409 for POST \/v1\/tenants/);
  });

  it("fails loud (unreachable) when fetch throws, honoring a custom request timeout", async () => {
    const fetchImpl = async () => {
      throw new Error("network exploded");
    };
    await expect(createTenant("acme", { env: ENABLED_ENV, fetchImpl, requestTimeoutMs: 25 })).rejects.toThrow(
      /unreachable for POST \/v1\/tenants: network exploded/,
    );
  });

  it("fails loud (unreachable) when fetch throws a non-Error value", async () => {
    const fetchImpl = async () => {
      throw "string failure";
    };
    await expect(createTenant("acme", { env: ENABLED_ENV, fetchImpl })).rejects.toThrow(/unreachable.*string failure/);
  });

  it("fails loud when the body is not valid JSON", async () => {
    const fetchImpl = async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
    await expect(createTenant("acme", { env: ENABLED_ENV, fetchImpl })).rejects.toThrow(/malformed response/);
  });

  it("fails loud when the body is JSON but not an object", async () => {
    const fetchImpl = async () => new Response("42", { status: 200, headers: { "content-type": "application/json" } });
    await expect(createTenant("acme", { env: ENABLED_ENV, fetchImpl })).rejects.toThrow(/malformed response/);
  });
});

describe("listTenants + destroyTenant (#7275)", () => {
  it("GETs and returns the tenants array", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://control.example.internal/v1/tenants");
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      return Response.json({ tenants: [{ tenant: { name: "acme" }, product: "ams", state: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] });
    });
    const records = await listTenants({ env: ENABLED_ENV, fetchImpl });
    expect(records).toEqual([{ tenant: { name: "acme" }, product: "ams", state: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]);
  });

  it("FAILS LOUD on a response with no `tenants` field rather than reporting an empty fleet (#9750)", async () => {
    // Was: degrade to []. An admin listing that answers "you have no tenants" because the control plane
    // renamed a field is the most misleading possible answer -- and this client's whole documented posture
    // is that every call fails loud, precisely because these are deliberate admin actions.
    const fetchImpl = async () => Response.json({ note: "no tenants field" });
    await expect(listTenants({ env: ENABLED_ENV, fetchImpl })).rejects.toThrow(/does not match the published contract/);
  });

  it("rejects a tenant record missing a required field, naming the route (#9750)", async () => {
    const fetchImpl = async () => Response.json({ tenants: [{ product: "ams", state: "active", createdAt: "x", updatedAt: "y" }] });
    await expect(listTenants({ env: ENABLED_ENV, fetchImpl })).rejects.toThrow(/GET \/v1\/tenants/);
  });

  it("ACCEPTS a record carrying a field this client has never heard of", async () => {
    // The schema is a loose object on purpose: a control plane that starts returning one more field must not
    // break a client validating against today's shape.
    const entry = { tenant: { name: "acme" }, product: "ams", state: "active", createdAt: "x", updatedAt: "y", somethingNew: 42 };
    const fetchImpl = async () => Response.json({ tenants: [entry] });
    expect(await listTenants({ env: ENABLED_ENV, fetchImpl })).toEqual([entry]);
  });

  it("DELETEs a URL-encoded name and returns the final record", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://control.example.internal/v1/tenants/acme%2Fedge");
      expect(init.method).toBe("DELETE");
      return Response.json({ tenant: { name: "acme/edge" }, product: "ams", state: "torn down" });
    });
    const record = await destroyTenant("acme/edge", { env: ENABLED_ENV, fetchImpl });
    expect(record).toEqual({ tenant: { name: "acme/edge" }, product: "ams", state: "torn down" });
  });
});

describe("tenant-client default fallbacks (real process.env / global fetch) (#7275)", () => {
  it("createTenant reads process.env and throws (disabled) when the flag isn't set there", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    await expect(createTenant("acme")).rejects.toThrow(/control plane disabled/);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("listTenants falls back to the real global fetch when no fetchImpl is injected", async () => {
    vi.stubEnv(CONTROL_PLANE_FLAG, "true");
    vi.stubEnv(CONTROL_PLANE_URL_FLAG, "https://control.example.internal");
    vi.stubEnv(CONTROL_PLANE_ADMIN_TOKEN_FLAG, "admin-secret");
    const globalFetch = vi.fn(async () => Response.json({ tenants: [] }));
    vi.stubGlobal("fetch", globalFetch);
    expect(await listTenants()).toEqual([]);
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});

describe("tenant argv parsing (#7275)", () => {
  it("parseTenantCreateArgs accepts name + product + json in any order", () => {
    expect(parseTenantCreateArgs(["acme", "--product", "widgets", "--json"])).toEqual({
      name: "acme",
      product: "widgets",
      json: true,
    });
    expect(parseTenantCreateArgs(["acme"])).toEqual({ name: "acme", json: false });
  });

  it("parseTenantCreateArgs rejects a missing product value, a flag-shaped value, a duplicate name, an unknown flag, and no name", () => {
    expect(parseTenantCreateArgs(["acme", "--product"])).toHaveProperty("error");
    expect(parseTenantCreateArgs(["acme", "--product", "--json"])).toHaveProperty("error");
    expect(parseTenantCreateArgs(["acme", "beta"])).toHaveProperty("error");
    expect(parseTenantCreateArgs(["acme", "--bogus"])).toHaveProperty("error");
    expect(parseTenantCreateArgs([])).toHaveProperty("error");
  });

  it("parseTenantNameArgs accepts a single name (+json) and rejects extras", () => {
    expect(parseTenantNameArgs(["acme", "--json"])).toEqual({ name: "acme", json: true });
    expect(parseTenantNameArgs([])).toHaveProperty("error");
    expect(parseTenantNameArgs(["acme", "beta"])).toHaveProperty("error");
    expect(parseTenantNameArgs(["--bogus"])).toHaveProperty("error");
  });

  it("parseTenantListArgs accepts --json and rejects any positional/unknown token", () => {
    expect(parseTenantListArgs([])).toEqual({ json: false });
    expect(parseTenantListArgs(["--json"])).toEqual({ json: true });
    expect(parseTenantListArgs(["oops"])).toHaveProperty("error");
  });
});

describe("runTenantCreate (#7275)", () => {
  it("prints json and forwards name/product/env/fetchImpl to the injected client", async () => {
    captureConsole();
    const createSpy = vi.fn(async () => ({ tenant: { name: "acme" }, product: "widgets", state: "provisioning" }) as TenantRecord);
    const fetchImpl = vi.fn();
    const code = await runTenantCreate(["acme", "--product", "widgets", "--json"], {
      createTenant: createSpy,
      env: ENABLED_ENV,
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(createSpy).toHaveBeenCalledWith("acme", { env: ENABLED_ENV, fetchImpl, product: "widgets" });
    expect(JSON.parse(logs.join(""))).toEqual({ tenant: { name: "acme" }, product: "widgets", state: "provisioning" });
  });

  it("prints a human summary in text mode, omitting product when not supplied", async () => {
    captureConsole();
    const createSpy = vi.fn(async (_name: string, _options?: Record<string, unknown>) => ({ tenant: { name: "acme" }, product: "ams", state: "provisioning" }) as TenantRecord);
    const code = await runTenantCreate(["acme"], { createTenant: createSpy });
    expect(code).toBe(0);
    expect(createSpy.mock.calls[0]![1]).not.toHaveProperty("product");
    expect(logs.join("")).toBe("created acme  product=ams  state=provisioning");
  });

  it("reports the client error as a non-zero exit (fail loud)", async () => {
    captureConsole();
    const createSpy = vi.fn(async () => {
      throw new Error("control plane disabled: set X");
    });
    const code = await runTenantCreate(["acme", "--json"], { createTenant: createSpy });
    expect(code).toBe(2);
    expect(JSON.parse(logs.join(""))).toEqual({ ok: false, error: "control plane disabled: set X" });
  });

  it("reports a parse error without calling the client", async () => {
    captureConsole();
    const createSpy = vi.fn();
    const code = await runTenantCreate([], { createTenant: createSpy });
    expect(code).toBe(2);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("falls back to the real client, which fails loud when the plane is disabled", async () => {
    captureConsole();
    const code = await runTenantCreate(["acme"], { env: {}, fetchImpl: vi.fn() });
    expect(code).toBe(2);
    expect(errs.join("")).toMatch(/control plane disabled/);
  });
});

describe("runTenantList (#7275)", () => {
  it("prints json of the records", async () => {
    captureConsole();
    const listSpy = vi.fn(async () => [{ tenant: { name: "acme" }, product: "ams", state: "active" }] as TenantRecord[]);
    const code = await runTenantList(["--json"], { listTenants: listSpy });
    expect(code).toBe(0);
    expect(JSON.parse(logs.join(""))).toEqual([{ tenant: { name: "acme" }, product: "ams", state: "active" }]);
  });

  it("prints one line per tenant in text mode", async () => {
    captureConsole();
    const listSpy = vi.fn(async () => [
      { tenant: { name: "acme" }, product: "ams", state: "active" },
      { tenant: { name: "beta" }, product: "widgets", state: "suspended" },
    ] as TenantRecord[]);
    const code = await runTenantList([], { listTenants: listSpy });
    expect(code).toBe(0);
    expect(logs.join("")).toBe("acme  product=ams  state=active\nbeta  product=widgets  state=suspended");
  });

  it("prints 'no tenants' for an empty list, and renders unknown fields defensively", async () => {
    captureConsole();
    const empty = await runTenantList([], { listTenants: vi.fn(async () => []) });
    expect(empty).toBe(0);
    expect(logs.join("")).toBe("no tenants");

    logs = [];
    // A record missing every field still renders rather than throwing mid-listing -- the schema is a loose
    // object and an older control plane is a real possibility.
    await runTenantList([], { listTenants: vi.fn(async () => [{} as unknown as TenantRecord]) });
    expect(logs.join("")).toBe("(unknown)  product=(unknown)  state=(unknown)");
  });

  it("reports a parse error and a client failure", async () => {
    captureConsole();
    const parseErr = await runTenantList(["oops"], { listTenants: vi.fn() });
    expect(parseErr).toBe(2);

    const failure = await runTenantList(["--json"], {
      listTenants: vi.fn(async () => {
        throw new Error("control plane returned http_500 for GET /v1/tenants");
      }),
    });
    expect(failure).toBe(2);
  });

  it("falls back to the real client, which fails loud when the plane is disabled", async () => {
    captureConsole();
    const code = await runTenantList([], { env: {}, fetchImpl: vi.fn() });
    expect(code).toBe(2);
    expect(errs.join("")).toMatch(/control plane disabled/);
  });
});

describe("runTenantDestroy (#7275)", () => {
  it("prints json and forwards the name to the injected client", async () => {
    captureConsole();
    const destroySpy = vi.fn(async () => ({ tenant: { name: "acme" }, product: "ams", state: "torn down" }) as TenantRecord);
    const code = await runTenantDestroy(["acme", "--json"], { destroyTenant: destroySpy });
    expect(code).toBe(0);
    expect(destroySpy).toHaveBeenCalledWith("acme", { env: undefined, fetchImpl: undefined });
    expect(JSON.parse(logs.join(""))).toEqual({ tenant: { name: "acme" }, product: "ams", state: "torn down" });
  });

  it("prints a human summary in text mode", async () => {
    captureConsole();
    const code = await runTenantDestroy(["acme"], {
      destroyTenant: vi.fn(async () => ({ tenant: { name: "acme" }, product: "ams", state: "torn down" }) as TenantRecord),
    });
    expect(code).toBe(0);
    expect(logs.join("")).toBe("destroyed acme  product=ams  state=torn down");
  });

  it("reports a parse error and a client failure", async () => {
    captureConsole();
    const parseErr = await runTenantDestroy([], { destroyTenant: vi.fn() });
    expect(parseErr).toBe(2);

    const failure = await runTenantDestroy(["acme"], {
      destroyTenant: vi.fn(async () => {
        throw new Error("control plane unreachable for DELETE /v1/tenants/acme: boom");
      }),
    });
    expect(failure).toBe(2);
  });

  it("falls back to the real client, which fails loud when the plane is disabled", async () => {
    captureConsole();
    const code = await runTenantDestroy(["acme"], { env: {}, fetchImpl: vi.fn() });
    expect(code).toBe(2);
    expect(errs.join("")).toMatch(/control plane disabled/);
  });
});

describe("runTenantCli dispatch (#7275)", () => {
  it("routes each subcommand to its handler", async () => {
    captureConsole();
    expect(await runTenantCli("create", ["acme"], { createTenant: vi.fn(async () => ({ tenant: { name: "acme" }, product: "ams", state: "provisioning" }) as TenantRecord) })).toBe(0);
    expect(await runTenantCli("list", [], { listTenants: vi.fn(async () => []) })).toBe(0);
    expect(await runTenantCli("destroy", ["acme"], { destroyTenant: vi.fn(async () => ({ tenant: { name: "acme" }, product: "ams", state: "torn down" }) as TenantRecord) })).toBe(0);
  });

  it("reports usage for an unknown or missing subcommand", async () => {
    captureConsole();
    expect(await runTenantCli("bogus", ["--json"])).toBe(2);
    expect(JSON.parse(logs.join(""))).toMatchObject({ ok: false });

    expect(await runTenantCli(undefined, [])).toBe(2);
    expect(errs.join("")).toMatch(/Usage: loopover-miner tenant/);
  });
});
