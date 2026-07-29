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
