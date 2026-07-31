import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { DISCOVERY_PATHS, resetDiscoveryCacheForTesting } from "../../src/mcp/discovery-routes";
import { SERVER_CARD_NAME } from "@loopover/contract/discovery";
import { createTestEnv } from "../helpers/d1";

// #9526: the discovery routes served by the real app — unauthenticated, cacheable, and describing the
// deployment that answered. The projections themselves are unit-tested; this covers the wiring: routing,
// the auth exemption, and conditional-request handling through Hono.

const app = createApp();

function request(path: string, headers: Record<string, string> = {}) {
  return app.fetch(new Request(`https://api.loopover.ai${path}`, { headers }), createTestEnv());
}

beforeEach(() => {
  resetDiscoveryCacheForTesting();
});

describe("discovery routes (#9526)", () => {
  it.each(DISCOVERY_PATHS)("%s is reachable WITHOUT a credential", async (path) => {
    // A registry crawler has no token; gating these would only hide a server that advertises itself.
    const response = await request(path);
    expect(response.status, `${path} must not require auth`).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("the server card names the registry identity and this deployment's own /mcp", async () => {
    const card = (await (await request("/.well-known/mcp.json")).json()) as {
      name: string;
      deployment: string;
      remotes: Array<{ url: string }>;
      tools: unknown[];
    };
    expect(card.name).toBe(SERVER_CARD_NAME);
    expect(card.remotes[0]!.url).toBe("https://api.loopover.ai/mcp");
    expect(card.tools.length).toBeGreaterThan(100);
  });

  it("names the deployment that ANSWERED, and scopes the catalog to what it serves", async () => {
    // src/server.ts serves this very Hono app, so the same route answers on both deployments. A self-host
    // card advertising the cloud's tool set would be a list of calls that 404 there.
    const selfhostEnv = createTestEnv();
    expect(selfhostEnv.SELFHOST_TRANSIENT_CACHE, "the test env is the self-host runtime").toBeTruthy();
    const selfhost = (await (await app.fetch(new Request("https://api.loopover.ai/.well-known/mcp.json"), selfhostEnv)).json()) as {
      deployment: string;
      tools: Array<{ name: string }>;
    };
    expect(selfhost.deployment).toBe("selfhost");

    resetDiscoveryCacheForTesting();
    const cloud = (await (
      await app.fetch(new Request("https://api.loopover.ai/.well-known/mcp.json"), { ...selfhostEnv, SELFHOST_TRANSIENT_CACHE: undefined } as unknown as Env)
    ).json()) as { deployment: string; tools: Array<{ name: string }> };
    expect(cloud.deployment).toBe("cloud");

    // Not merely a different label: the registry's cloud-only entries are absent from the self-host card.
    const cloudOnly = cloud.tools.filter((tool) => !selfhost.tools.some((entry) => entry.name === tool.name));
    expect(cloudOnly.length, "a cloud-only tool must not appear on a self-host card").toBeGreaterThan(0);
  });

  it("does not hardcode a version — the card reports what the shipped package says", async () => {
    const card = (await (await request("/.well-known/mcp.json")).json()) as { version: string };
    // The old serverInfo said "0.1.0" forever; this must track the real release instead.
    expect(card.version).not.toBe("0.1.0");
    expect(card.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each(DISCOVERY_PATHS)("%s answers 304 for a matching if-none-match", async (path) => {
    const first = await request(path);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);

    const second = await request(path, { "if-none-match": etag });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("answers 200 again when the caller's tag is stale", async () => {
    const response = await request("/.well-known/mcp.json", { "if-none-match": 'W/"stale"' });
    expect(response.status).toBe(200);
  });

  it("the agent-tools trio all describe the same catalog the card does", async () => {
    const card = (await (await request("/.well-known/mcp.json")).json()) as { tools: Array<{ name: string }> };
    const index = (await (await request("/.well-known/agent-tools/index.json")).json()) as { tools: Array<{ name: string }> };
    const openai = (await (await request("/.well-known/agent-tools/openai.json")).json()) as { tools: Array<{ function: { name: string } }> };
    const anthropic = (await (await request("/.well-known/agent-tools/anthropic.json")).json()) as { tools: Array<{ name: string }> };

    const expected = card.tools.map((tool) => tool.name);
    expect(index.tools.map((tool) => tool.name)).toEqual(expected);
    expect(openai.tools.map((tool) => tool.function.name)).toEqual(expected);
    expect(anthropic.tools.map((tool) => tool.name)).toEqual(expected);
  });

  it("every agent-tools document points a caller at /mcp tools/call", async () => {
    for (const path of DISCOVERY_PATHS.filter((candidate) => candidate.includes("agent-tools"))) {
      const document = (await (await request(path)).json()) as { executor: { url: string; method: string } };
      expect(document.executor.url).toBe("https://api.loopover.ai/mcp");
      expect(document.executor.method).toBe("tools/call");
    }
  });

  it("advertises the origin the request ARRIVED on when no public origin is configured", async () => {
    // A self-host deployment answers on its own hostname; the card must not advertise the cloud's. The test
    // env presets PUBLIC_API_ORIGIN, so this clears it to reach the request-origin fallback.
    const response = await app.fetch(new Request("https://selfhost.example/.well-known/mcp.json"), {
      ...createTestEnv(),
      PUBLIC_API_ORIGIN: undefined,
    } as unknown as Env);
    const card = (await response.json()) as { remotes: Array<{ url: string }> };
    expect(card.remotes[0]!.url).toBe("https://selfhost.example/mcp");
  });

  it("prefers the configured public origin over the request's", async () => {
    const response = await app.fetch(
      new Request("https://internal.example/.well-known/mcp.json"),
      createTestEnv({ PUBLIC_API_ORIGIN: "https://api.loopover.ai" }),
    );
    const card = (await response.json()) as { remotes: Array<{ url: string }> };
    expect(card.remotes[0]!.url).toBe("https://api.loopover.ai/mcp");
  });
});

// #10039: a self-host card must describe only what THIS deployment's /mcp actually registers. "admin" is
// the one category gated behind LOOPOVER_MCP_ADMIN_ENABLED (createServer's isMcpAdminEnabled) rather than
// availability alone, so a card built from availability filtering only would advertise five tools the
// server refuses as unknown on a default (flag-unset) self-host deployment.
describe("admin-tool exclusion from a self-host card when the admin surface is not enabled (#10039)", () => {
  const ADMIN_TOOL_NAMES = [
    "loopover_admin_get_config",
    "loopover_admin_write_config",
    "loopover_admin_list_config_backups",
    "loopover_admin_trigger_redeploy",
    "loopover_admin_rotate_secret",
  ];

  it("lists none of the five admin tools when LOOPOVER_MCP_ADMIN_ENABLED is unset on a self-host env", async () => {
    const env = createTestEnv();
    expect(env.SELFHOST_TRANSIENT_CACHE, "the test env is the self-host runtime").toBeTruthy();
    expect(env.LOOPOVER_MCP_ADMIN_ENABLED, "the flag defaults off").toBeFalsy();

    const card = (await (await app.fetch(new Request("https://api.loopover.ai/.well-known/mcp.json"), env)).json()) as {
      tools: Array<{ name: string }>;
    };
    const index = (await (await app.fetch(new Request("https://api.loopover.ai/.well-known/agent-tools/index.json"), env)).json()) as {
      tools: Array<{ name: string }>;
    };
    const cardNames = card.tools.map((tool) => tool.name);
    const indexNames = index.tools.map((tool) => tool.name);
    for (const name of ADMIN_TOOL_NAMES) {
      expect(cardNames, `${name} must not be on the flag-off self-host card`).not.toContain(name);
      expect(indexNames, `${name} must not be on the flag-off self-host index`).not.toContain(name);
    }
  });

  it("lists all five admin tools when LOOPOVER_MCP_ADMIN_ENABLED=1 on the same self-host env", async () => {
    const env = createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "1" });
    expect(env.SELFHOST_TRANSIENT_CACHE, "the test env is the self-host runtime").toBeTruthy();

    const card = (await (await app.fetch(new Request("https://api.loopover.ai/.well-known/mcp.json"), env)).json()) as {
      tools: Array<{ name: string }>;
    };
    const index = (await (await app.fetch(new Request("https://api.loopover.ai/.well-known/agent-tools/index.json"), env)).json()) as {
      tools: Array<{ name: string }>;
    };
    const cardNames = card.tools.map((tool) => tool.name);
    const indexNames = index.tools.map((tool) => tool.name);
    for (const name of ADMIN_TOOL_NAMES) {
      expect(cardNames, `${name} must be on the flag-on self-host card`).toContain(name);
      expect(indexNames, `${name} must be on the flag-on self-host index`).toContain(name);
    }
  });

  it("the flag-on and flag-off documents do not leak through the memo, with no reset needed", async () => {
    // Same module instance, same (deployment, version, baseUrl) -- only the flag differs. Deliberately does
    // NOT call resetDiscoveryCacheForTesting between the two requests: that would mask a memo key that
    // forgot to carry the flag, since a fresh cache always misses regardless.
    const off = await app.fetch(new Request("https://api.loopover.ai/.well-known/mcp.json"), createTestEnv());
    const on = await app.fetch(new Request("https://api.loopover.ai/.well-known/mcp.json"), createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "1" }));

    const offBody = await off.text();
    const onBody = await on.text();
    expect(onBody).not.toBe(offBody);
    expect(on.headers.get("etag")).not.toBe(off.headers.get("etag"));

    const offNames = (JSON.parse(offBody) as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    const onNames = (JSON.parse(onBody) as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    for (const name of ADMIN_TOOL_NAMES) {
      expect(offNames).not.toContain(name);
      expect(onNames).toContain(name);
    }
  });

  it("does not affect the cloud deployment's documents, which never listed the selfhost-only admin tools", async () => {
    const cloudEnv = { ...createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "1" }), SELFHOST_TRANSIENT_CACHE: undefined } as unknown as Env;
    const card = (await (await app.fetch(new Request("https://api.loopover.ai/.well-known/mcp.json"), cloudEnv)).json()) as {
      deployment: string;
      tools: Array<{ name: string }>;
    };
    expect(card.deployment).toBe("cloud");
    const names = card.tools.map((tool) => tool.name);
    for (const name of ADMIN_TOOL_NAMES) expect(names).not.toContain(name);
  });
});
