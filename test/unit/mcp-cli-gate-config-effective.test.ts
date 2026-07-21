import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeFixtureServer,
  startFixtureServer,
} from "./support/mcp-cli-harness";

// #7800: in-process coverage for the loopover_get_gate_config_effective stdio tool.
// Same #7764 entrypoint-guard pattern as mcp-cli-registry-snapshot.test.ts / mcp-cli-activation-preview.test.ts.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const capturedRequests: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-gate-config-effective-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/gate-config/effective")) {
        capturedRequests.push({
          url: request.url ?? "",
          method: request.method ?? "GET",
        });
      }
    },
  });
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  for (const specifier of MODULES) {
    loaded.set(specifier, (await import(specifier)) as unknown as BinModule);
  }
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

describe("bin loopover_get_gate_config_effective stdio tool (in-process, #7800)", () => {
  it.each(MODULES)(
    "registers and proxies GET .../gate-config/effective — %s",
    async (specifier) => {
      capturedRequests.length = 0;
      const mod = loaded.get(specifier)!;
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await mod.server.connect(serverTransport);
      const client = new Client(
        { name: "gate-config-effective-test", version: "0.1.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);
      try {
        const { tools } = await client.listTools();
        const tool = tools.find(
          (entry) => entry.name === "loopover_get_gate_config_effective",
        );
        expect(tool).toBeDefined();
        expect(tool?.description).toMatch(/effective.*gate|gate.*threshold/i);

        const result = await client.callTool({
          name: "loopover_get_gate_config_effective",
          arguments: { owner: "owner", repo: "repo" },
        });
        expect(result.isError).toBeFalsy();
        expect(capturedRequests).toEqual([
          { url: "/v1/repos/owner/repo/gate-config/effective", method: "GET" },
        ]);
        expect(result.structuredContent).toMatchObject({
          repoFullName: "owner/repo",
          effective: {
            confidenceFloor: 0.9,
            scopeCap: { files: 12, lines: 400 },
          },
          shadowPending: true,
        });
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  );
});
