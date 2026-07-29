import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_DISABLED_ADVISORY,
  GATEWAY_UNAUTHENTICATED_ADVISORY,
  discoverRemoteTools,
  gatewayAdvisoryResource,
  gatewayDisabled,
  type GatewayFetch,
  type RemoteToolDescriptor,
} from "../../packages/loopover-mcp/lib/gateway";

// #9526: gateway discovery. The governing rule is that NONE of this may break a stdio server — a missing
// session, a dead network, or a hostile response all leave the local tools working plus one advisory. An
// enhancement that can break startup is a liability, so every failure path here is asserted to be
// non-throwing and to say something a contributor can act on.

const REMOTE_TOOLS: RemoteToolDescriptor[] = [
  { name: "loopover_get_decision_pack", title: "Decision pack", description: "…", inputSchema: { type: "object" } },
  { name: "loopover_preflight_pr", title: "Preflight", description: "…", inputSchema: { type: "object" } },
];

function respondingWith(payload: unknown, init: { ok?: boolean; status?: number } = {}): GatewayFetch {
  return vi.fn(async () => ({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => payload }));
}

function input(overrides: Partial<Parameters<typeof discoverRemoteTools>[0]> = {}) {
  return {
    apiUrl: "https://api.loopover.ai",
    token: "session-token",
    localToolNames: new Set<string>(),
    fetchImpl: respondingWith({ result: { tools: REMOTE_TOOLS } }),
    ...overrides,
  };
}

describe("discovery requires a session (#9526)", () => {
  it("reports unauthenticated WITHOUT making a request", async () => {
    const fetchImpl = respondingWith({ result: { tools: [] } });
    const result = await discoverRemoteTools(input({ token: null, fetchImpl }));
    expect(result.status).toBe("unauthenticated");
    expect(fetchImpl, "no session means nothing to authenticate with — do not call out").not.toHaveBeenCalled();
  });

  it("the unauthenticated advisory tells a contributor exactly what to do", async () => {
    const result = await discoverRemoteTools(input({ token: null }));
    expect(result.status === "unauthenticated" && result.advisory).toBe(GATEWAY_UNAUTHENTICATED_ADVISORY);
    expect(GATEWAY_UNAUTHENTICATED_ADVISORY).toContain("loopover-mcp login");
    expect(GATEWAY_UNAUTHENTICATED_ADVISORY, "and must say the local half still works").toContain("Local tools are available");
  });
});

describe("a successful mount (#9526)", () => {
  it("returns the remote tools and calls the remote's own tools/list with the session bearer", async () => {
    const fetchImpl = respondingWith({ result: { tools: REMOTE_TOOLS } });
    const result = await discoverRemoteTools(input({ fetchImpl }));
    expect(result.status).toBe("mounted");
    expect(result.status === "mounted" && result.tools.map((tool) => tool.name)).toEqual([
      "loopover_get_decision_pack",
      "loopover_preflight_pr",
    ]);

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, { headers: Record<string, string>; body: string }][] } }).mock.calls[0]!;
    expect(url).toBe("https://api.loopover.ai/mcp");
    expect(init.headers.authorization).toBe("Bearer session-token");
    expect(JSON.parse(init.body).method).toBe("tools/list");
  });

  it("trims a trailing slash rather than requesting a doubled path", async () => {
    const fetchImpl = respondingWith({ result: { tools: [] } });
    await discoverRemoteTools(input({ apiUrl: "https://api.loopover.ai/", fetchImpl }));
    expect((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]).toBe("https://api.loopover.ai/mcp");
  });

  it("SKIPS a remote tool whose name the local server already serves — local wins", async () => {
    // The registry makes this unreachable, but a duplicate registration would crash the stdio server, and
    // degrading to the local tool is strictly better than refusing to start.
    const result = await discoverRemoteTools(input({ localToolNames: new Set(["loopover_preflight_pr"]) }));
    expect(result.status === "mounted" && result.tools.map((tool) => tool.name)).toEqual(["loopover_get_decision_pack"]);
    expect(result.status === "mounted" && result.skipped).toEqual(["loopover_preflight_pr"]);
  });

  it("ignores malformed entries instead of mounting a tool with no name", async () => {
    const fetchImpl = respondingWith({ result: { tools: [...REMOTE_TOOLS, null, "nope", { title: "no name" }, { name: "" }] } });
    const result = await discoverRemoteTools(input({ fetchImpl }));
    expect(result.status === "mounted" && result.tools).toHaveLength(2);
  });
});

describe("every failure degrades to a working local server (#9526)", () => {
  it("a transport error reports unavailable, naming the cause", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as GatewayFetch;
    const result = await discoverRemoteTools(input({ fetchImpl }));
    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.advisory).toContain("ECONNREFUSED");
  });

  it("names a non-Error rejection too, rather than rendering it as [object Object]", async () => {
    // fetch implementations reject with plenty of things that are not Errors; an advisory reading
    // "the API was unreachable ([object Object])" tells a contributor nothing.
    const fetchImpl = vi.fn(async () => {
      throw "ETIMEDOUT from a bare string";
    }) as unknown as GatewayFetch;
    const result = await discoverRemoteTools(input({ fetchImpl }));
    expect(result.status === "unavailable" && result.advisory).toContain("ETIMEDOUT from a bare string");
  });

  it("a non-2xx reports the STATUS and does not echo the remote body", async () => {
    // The body is remote-controlled; it has no business in a local advisory string.
    const fetchImpl = respondingWith({ error: "internal", secretish: "do-not-echo" }, { ok: false, status: 503 });
    const result = await discoverRemoteTools(input({ fetchImpl }));
    expect(result.status === "unavailable" && result.advisory).toContain("503");
    expect(result.status === "unavailable" && result.advisory).not.toContain("do-not-echo");
  });

  it.each([
    ["a body with no result", {}],
    ["a result with no tools", { result: {} }],
    ["tools that are not an array", { result: { tools: "everything" } }],
    ["a null body", null],
  ])("reports unavailable for %s rather than throwing", async (_label, payload) => {
    const result = await discoverRemoteTools(input({ fetchImpl: respondingWith(payload) }));
    expect(result.status).toBe("unavailable");
  });

  it("a body that will not parse is unavailable, not a crash", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as GatewayFetch;
    expect((await discoverRemoteTools(input({ fetchImpl }))).status).toBe("unavailable");
  });

  it("every unavailable advisory says the local tools still work", async () => {
    const result = await discoverRemoteTools(input({ fetchImpl: respondingWith({}) }));
    expect(result.status === "unavailable" && result.advisory).toContain("Local tools are available");
  });

  it("bounds the call so a hanging remote cannot delay stdio startup", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: { tools: [] } }) }));
    await discoverRemoteTools(input({ fetchImpl: fetchImpl as unknown as GatewayFetch, timeoutMs: 25 }));
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, { signal?: AbortSignal }][] } }).mock.calls[0]!;
    expect(init.signal, "an unbounded discovery call would hang the server's start").toBeDefined();
  });
});

describe("--no-remote (#9526)", () => {
  it.each([
    [["--stdio", "--no-remote"], true],
    [["--no-remote"], true],
    [["--stdio"], false],
    [[], false],
  ])("gatewayDisabled(%j) is %s", (argv, expected) => {
    expect(gatewayDisabled(argv)).toBe(expected);
  });

  it("its advisory explains how to turn the gateway back on", () => {
    expect(GATEWAY_DISABLED_ADVISORY).toContain("--no-remote");
    expect(GATEWAY_DISABLED_ADVISORY).toContain("Local tools are available");
  });
});

describe("the advisory resource (#9526)", () => {
  it("is null when tools mounted — there is nothing to advise about", () => {
    expect(gatewayAdvisoryResource({ status: "mounted", tools: [], skipped: [] })).toBeNull();
  });

  it.each([
    ["unauthenticated" as const, GATEWAY_UNAUTHENTICATED_ADVISORY],
    ["unavailable" as const, "some reason"],
  ])("carries the %s status and its advisory", (status, advisory) => {
    expect(gatewayAdvisoryResource({ status, advisory })).toEqual({ status, advisory });
  });
});
