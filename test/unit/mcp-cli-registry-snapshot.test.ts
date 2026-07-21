import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7803: in-process coverage for the loopover_get_registry_snapshot stdio tool in
// packages/loopover-mcp/bin/loopover-mcp.ts. Same #7764 entrypoint-guard pattern as
// mcp-cli-plan-issues.test.ts — import the .ts source (not a gitignored .js build artifact), hold the
// exported `server`, and connect an in-memory transport so v8/Codecov attributes the new registerStdioTool
// lines. Subprocess spawn alone does not instrument the bin (that is why #7903's bin-only PR got 0% patch).
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const capturedRequests: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-registry-snapshot-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url === "/v1/registry/snapshot") {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
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

describe("bin loopover_get_registry_snapshot stdio tool (in-process, #7803)", () => {
  it.each(MODULES)("registers and proxies GET /v1/registry/snapshot — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "registry-snapshot-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_get_registry_snapshot");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/registry snapshot/i);

      const result = await client.callTool({ name: "loopover_get_registry_snapshot", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(capturedRequests).toEqual([{ url: "/v1/registry/snapshot", method: "GET" }]);
      expect(result.structuredContent).toMatchObject({
        id: "fixture-snapshot",
        repoCount: 1,
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
