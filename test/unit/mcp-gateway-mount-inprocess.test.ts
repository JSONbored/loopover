import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";
import type { GatewayFetch, GatewayMountResult } from "../../packages/loopover-mcp/lib/gateway";

// #9526: gateway mounting against the REAL stdio server, in-process.
//
// gateway.ts's discovery is unit-tested on its own; this covers the wiring the bin owns — that a mounted
// remote tool is actually registered and callable, that it is tagged as proxied so telemetry can tell it
// from a local call, and that the failure paths leave a server which still lists its local tools.

const MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
  mountRemoteTools: (options?: { argv?: readonly string[]; fetchImpl?: GatewayFetch }) => Promise<GatewayMountResult>;
};

let tempDir = "";
let mod: BinModule;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-gateway-mount-"));
  const apiUrl = await startFixtureServer();
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  mod = (await import(MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  for (const key of ["LOOPOVER_API_URL", "LOOPOVER_API_TOKEN", "LOOPOVER_API_TIMEOUT_MS", "LOOPOVER_CONFIG_DIR", "LOOPOVER_SKIP_NPM_VERSION_CHECK"]) {
    delete process.env[key];
  }
});

async function connect(name: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mod.server.connect(serverTransport);
  const client = new Client({ name, version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

function remoteToolsFetch(tools: unknown[]): GatewayFetch {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: { tools } }) }));
}

describe("mountRemoteTools against the real server (#9526)", () => {
  it("--no-remote mounts nothing and never calls out", async () => {
    const fetchImpl = remoteToolsFetch([]);
    const result = await mod.mountRemoteTools({ argv: ["--stdio", "--no-remote"], fetchImpl });
    expect(result.status).toBe("unavailable");
    expect(fetchImpl, "the opt-out must be byte-identical to pre-gateway behavior").not.toHaveBeenCalled();
  });

  it("mounts a remote tool and makes it callable and discoverable", async () => {
    const result = await mod.mountRemoteTools({
      argv: ["--stdio"],
      fetchImpl: remoteToolsFetch([
        {
          name: "loopover_gateway_probe",
          title: "Gateway probe",
          description: "A remote-only tool, mounted through the gateway.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ]),
    });
    expect(result.status).toBe("mounted");

    const client = await connect("gateway-mount-test");
    try {
      const { tools } = await client.listTools();
      const proxied = tools.find((tool) => tool.name === "loopover_gateway_probe");
      expect(proxied, "a mounted tool must appear in tools/list").toBeDefined();
      // Tagged so telemetry can distinguish a proxied call from a local one (#9526 requirement 6) without
      // having to know which names are remote.
      expect((proxied!._meta as { transport?: string } | undefined)?.transport).toBe("proxied");
    } finally {
      await client.close();
    }
  });

  it("SKIPS a remote tool the local server already serves, leaving the local one in place", async () => {
    const before = await connect("gateway-collision-before");
    const localNames = new Set((await before.listTools()).tools.map((tool) => tool.name));
    await before.close();
    const collidingName = [...localNames].find((name) => name.startsWith("loopover_"))!;

    const result = await mod.mountRemoteTools({
      argv: ["--stdio"],
      fetchImpl: remoteToolsFetch([{ name: collidingName, description: "remote impostor" }]),
    });
    // The registry makes a real collision impossible; degrading beats crashing on duplicate registration.
    expect(result.status).toBe("mounted");
    expect(result.status === "mounted" && result.skipped).toContain(collidingName);
  });

  it("mounts a REGISTRY-KNOWN tool with the contract's schemas rather than the wire's", async () => {
    // The remote registered from the same contract registry, so the proxy can advertise exactly what the
    // remote enforces without this package trusting a schema a remote handed it.
    const contractName = "loopover_refresh_repo_focus_manifest";
    const result = await mod.mountRemoteTools({
      argv: ["--stdio"],
      fetchImpl: remoteToolsFetch([{ name: contractName, description: "remote-only in a later release" }]),
    });
    expect(result.status === "mounted" && result.tools).toHaveLength(1);

    const client = await connect("gateway-contract-schema");
    try {
      const proxied = (await client.listTools()).tools.find((tool) => tool.name === contractName)!;
      // The wire descriptor carried NO inputSchema; the registry supplied one.
      expect(Object.keys(proxied.inputSchema.properties ?? {}), "the contract's shape, not the wire's silence").toEqual(["owner", "repo"]);
    } finally {
      await client.close();
    }
  });

  it("a descriptor the SDK refuses costs that tool and nothing else", async () => {
    // A remote that repeats a name in one response would otherwise crash the whole mount on the duplicate
    // registration — mounting is all-or-nothing only if you let it be.
    const result = await mod.mountRemoteTools({
      argv: ["--stdio"],
      fetchImpl: remoteToolsFetch([
        { name: "loopover_gateway_twice", description: "first" },
        { name: "loopover_gateway_twice", description: "a repeat of the same name" },
        { name: "loopover_gateway_survivor", description: "must still mount" },
      ]),
    });
    expect(result.status === "mounted" && result.tools.map((tool) => tool.name)).toEqual([
      "loopover_gateway_twice",
      "loopover_gateway_survivor",
    ]);
    expect(result.status === "mounted" && result.skipped).toEqual(["loopover_gateway_twice"]);
  });

  it("CALLS a proxied tool and forwards it to the remote's own tools/call", async () => {
    // Listing a proxied tool proves registration; calling one proves the proxy actually routes. The fixture
    // server answers /mcp, so this exercises the whole path the way a client would.
    await mod.mountRemoteTools({
      argv: ["--stdio"],
      fetchImpl: remoteToolsFetch([{ name: "loopover_gateway_call_probe", description: "callable through the gateway" }]),
    });

    const client = await connect("gateway-call-test");
    try {
      const result = (await client.callTool({ name: "loopover_gateway_call_probe", arguments: { owner: "acme" } })) as {
        isError?: boolean;
        structuredContent?: { calledTool?: string; echoedArguments?: unknown };
      };
      // The remote's `result` is handed back VERBATIM -- this layer routes, it does not interpret -- and the
      // arguments reached the remote untouched. Asserting the payload rather than merely "it resolved":
      // callTool resolves for a failed call too, so a weaker assertion passes even when nothing was proxied.
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.calledTool).toBe("loopover_gateway_call_probe");
      expect(result.structuredContent?.echoedArguments).toEqual({ owner: "acme" });
    } finally {
      await client.close();
    }
  });

  it("shapes a resultless envelope into a conformant isError result rather than handing it back raw (#10036)", async () => {
    // A remote answering neither `result` nor `error` is not a CallToolResult either -- returning it
    // verbatim used to hand the client a bare `{ jsonrpc, id, note }` object with no `content`/`isError` at
    // all. It must get the same treatment as a JSON-RPC error: a readable isError:true result.
    await mod.mountRemoteTools({
      argv: ["--stdio"],
      fetchImpl: remoteToolsFetch([{ name: "loopover_gateway_resultless" }]),
    });
    const client = await connect("gateway-resultless");
    try {
      const result = (await client.callTool({ name: "loopover_gateway_resultless", arguments: {} })) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: { error?: { code?: string; message?: string } };
      };
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toBeTruthy();
      expect(result.structuredContent?.error?.code).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it("mounts a tool carrying annotations, and one carrying neither description nor annotations", async () => {
    const result = await mod.mountRemoteTools({
      argv: ["--stdio"],
      fetchImpl: remoteToolsFetch([
        { name: "loopover_gateway_annotated", description: "has hints", annotations: { readOnlyHint: true, destructiveHint: false } },
        // No description, no annotations: the remote is free to send a minimal descriptor and it must mount.
        { name: "loopover_gateway_bare" },
      ]),
    });
    expect(result.status === "mounted" && result.tools).toHaveLength(2);

    const client = await connect("gateway-annotations-test");
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.find((tool) => tool.name === "loopover_gateway_annotated")?.annotations?.readOnlyHint).toBe(true);
      const bare = tools.find((tool) => tool.name === "loopover_gateway_bare");
      expect(bare, "a descriptor with only a name must still mount").toBeDefined();
      expect(bare!.description).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("publishes an advisory resource a client can READ, and updates it on a later mount", async () => {
    await mod.mountRemoteTools({ argv: ["--stdio", "--no-remote"] });
    const client = await connect("gateway-advisory-read");
    try {
      const disabled = await client.readResource({ uri: "loopover://gateway/status" });
      expect(String((disabled.contents[0] as { text?: string }).text)).toContain("--no-remote");

      // A successful mount must not leave the earlier failure's advisory standing.
      await mod.mountRemoteTools({ argv: ["--stdio"], fetchImpl: remoteToolsFetch([]) });
      const after = await client.readResource({ uri: "loopover://gateway/status" });
      expect(JSON.parse(String((after.contents[0] as { text?: string }).text)).status).toBe("mounted");
    } finally {
      await client.close();
    }
  });

  it("uses a REAL fetch when the caller injects none", async () => {
    // The default transport, exercised against the loopback fixture server rather than stubbed away -- so
    // the one line that actually talks to the network is covered by talking to a network.
    const result = await mod.mountRemoteTools({ argv: ["--stdio"] });
    // The fixture answers tools/call, not tools/list, so discovery finds no tool array and degrades --
    // which is the point: the real transport ran, and a shape it did not expect did not break the server.
    expect(["mounted", "unavailable"]).toContain(result.status);
  });

  it("defaults argv to the process's own, and the transport to a real fetch, without touching the network", async () => {
    // Both defaults on one call. No session means discoverRemoteTools returns before it ever calls the
    // transport, so the real fetch default is selected and never invoked -- which is the point: an
    // unauthenticated contributor makes no outbound request at all.
    const token = process.env.LOOPOVER_API_TOKEN;
    delete process.env.LOOPOVER_API_TOKEN;
    try {
      const result = await mod.mountRemoteTools();
      expect(result.status).toBe("unauthenticated");
    } finally {
      process.env.LOOPOVER_API_TOKEN = token;
    }
  });

  it("an unreachable API leaves a server that still lists its LOCAL tools", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as GatewayFetch;
    const result = await mod.mountRemoteTools({ argv: ["--stdio"], fetchImpl });
    expect(result.status).toBe("unavailable");

    const client = await connect("gateway-offline-test");
    try {
      const { tools } = await client.listTools();
      // The whole posture: an enhancement that can break startup is a liability.
      expect(tools.length).toBeGreaterThan(10);
    } finally {
      await client.close();
    }
  });
});
